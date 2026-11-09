// In-memory job queue. One render at a time; files live on local disk and are
// removed after 24 hours.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { plan, render } = require('./pipeline');

const ROOT = process.env.JOBS_DIR || path.join(require('node:os').tmpdir(), 'gfn-jobs');
const TTL_MS = 24 * 60 * 60 * 1000;
fs.mkdirSync(ROOT, { recursive: true });

const jobs = new Map();
const queue = [];
let busy = false;

function newJobDir() {
  const id = crypto.randomBytes(9).toString('base64url');
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

function publicView(job) {
  return {
    id: job.id,
    status: job.status,
    progress: Math.round(job.progress * 100),
    message: job.message,
    error: job.error,
    stats: job.stats,
    position: job.status === 'queued' ? queue.indexOf(job.id) + 1 : 0,
  };
}

function create({ id, dir, clips, options }) {
  const job = {
    id, dir, clips, options,
    status: 'queued', progress: 0, message: 'Waiting to start',
    createdAt: Date.now(),
    output: path.join(dir, 'reel.mp4'),
  };
  jobs.set(id, job);
  queue.push(id);
  pump();
  return job;
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = jobs.get(queue.shift());
  const t0 = Date.now();
  try {
    job.status = 'analyzing';
    job.message = 'Finding the silent parts';
    const p = await plan(job.clips, job.options);
    job.status = 'rendering';
    job.message = 'Cutting and rendering your reel';
    await render(p.parts, job.output, (f) => (job.progress = f));
    job.stats = {
      inputSeconds: +p.inputDuration.toFixed(1),
      outputSeconds: +p.outputDuration.toFixed(1),
      removedSeconds: +(p.inputDuration - p.outputDuration).toFixed(1),
      cuts: p.parts.length,
      renderSeconds: +((Date.now() - t0) / 1000).toFixed(1),
      sizeMB: +(fs.statSync(job.output).size / 1e6).toFixed(1),
    };
    job.status = 'done';
    job.progress = 1;
    job.message = 'Ready';
  } catch (e) {
    console.error(`[job ${job.id}]`, e);
    job.status = 'error';
    job.error = String(e.message || e).split('\n')[0].slice(0, 300);
    job.message = 'Something went wrong';
  } finally {
    for (const c of job.clips) fs.rm(c.path, { force: true }, () => {});
    busy = false;
    pump();
  }
}

function get(id) {
  return jobs.get(id);
}

function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > TTL_MS) {
      fs.rm(job.dir, { recursive: true, force: true }, () => {});
      jobs.delete(id);
    }
  }
  // Also remove leftover folders from earlier runs.
  for (const name of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, name);
    try {
      if (!jobs.has(name) && now - fs.statSync(dir).mtimeMs > TTL_MS) {
        fs.rm(dir, { recursive: true, force: true }, () => {});
      }
    } catch {}
  }
}
setInterval(cleanup, 60 * 60 * 1000).unref();
cleanup();

module.exports = { newJobDir, create, get, publicView, ROOT };
