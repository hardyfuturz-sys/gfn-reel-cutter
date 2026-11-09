const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const jobs = require('./jobs');

const PORT = process.env.PORT || 8080;
const PASSCODE = process.env.APP_PASSCODE || '';
const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

const app = express();
app.disable('x-powered-by');

function passcodeOk(given) {
  if (!PASSCODE) return true;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PASSCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requirePasscode(req, res, next) {
  if (passcodeOk(req.get('x-passcode') || req.query.key)) return next();
  res.status(401).json({ error: 'Wrong passcode' });
}

app.get('/api/config', (req, res) => {
  res.json({ passcodeRequired: !!PASSCODE, maxFiles: MAX_FILES, maxTotalMB: MAX_TOTAL_BYTES / 1024 / 1024 });
});

app.post('/api/login', express.json(), (req, res) => {
  if (passcodeOk(req.body?.passcode)) return res.json({ ok: true });
  res.status(401).json({ error: 'Wrong passcode' });
});

// ---- Chunked uploads ----
// Phones upload each clip in 8 MB pieces. This stays under Cloud Run's 32 MB
// request limit and lets a dropped piece be retried without starting over.
const CHUNK_LIMIT = 9 * 1024 * 1024;
const uploads = new Map(); // id -> { id, dir, createdAt }

function num(v, def, min, max) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function clipPath(dir, n) {
  return path.join(dir, `clip-${String(n).padStart(2, '0')}.bin`);
}

function dirBytes(dir) {
  let total = 0;
  for (let n = 1; n <= MAX_FILES; n++) {
    try { total += fs.statSync(clipPath(dir, n)).size; } catch {}
  }
  return total;
}

app.post('/api/uploads', requirePasscode, (req, res) => {
  const u = { ...jobs.newJobDir(), createdAt: Date.now() };
  uploads.set(u.id, u);
  res.status(201).json({ id: u.id, chunkBytes: 8 * 1024 * 1024 });
});

app.put(
  '/api/uploads/:id/clips/:n',
  requirePasscode,
  express.raw({ type: () => true, limit: CHUNK_LIMIT }),
  (req, res) => {
    const u = uploads.get(req.params.id);
    const n = parseInt(req.params.n, 10);
    if (!u) return res.status(404).json({ error: 'Upload expired. Please start again.' });
    if (!(n >= 1 && n <= MAX_FILES)) return res.status(400).json({ error: `Up to ${MAX_FILES} clips at a time` });
    const offset = parseInt(req.get('x-offset') || '0', 10);
    const file = clipPath(u.dir, n);
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    const body = req.body || Buffer.alloc(0);
    if (offset + body.length <= size) return res.json({ size }); // already have this piece (retry)
    if (offset !== size) return res.status(409).json({ error: 'Out of order', size });
    if (dirBytes(u.dir) + body.length > MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: 'Clips are too large (200 MB max in total)' });
    }
    fs.appendFileSync(file, body);
    res.json({ size: size + body.length });
  }
);

app.post('/api/uploads/:id/start', requirePasscode, express.json(), (req, res) => {
  const u = uploads.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Upload expired. Please start again.' });
  const list = Array.isArray(req.body?.clips) ? req.body.clips.slice(0, MAX_FILES) : [];
  const clips = [];
  for (const c of list) {
    const n = parseInt(c.n, 10);
    const file = clipPath(u.dir, n);
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (!size || size !== Number(c.size)) {
      return res.status(400).json({ error: `Clip ${n} did not upload completely. Please try again.` });
    }
    clips.push({ path: file, name: String(c.name || `clip ${n}`).slice(0, 120) });
  }
  if (!clips.length) return res.status(400).json({ error: 'No clips received' });
  const o = req.body.options || {};
  const options = {
    removeSilences: o.removeSilences !== false,
    minSilence: num(o.minSilence, 0.6, 0.3, 3),
    noiseDb: num(o.noiseDb, -35, -60, -20),
    maxDuration: num(o.maxDuration, 60, 5, 90),
  };
  uploads.delete(u.id);
  const job = jobs.create({ id: u.id, dir: u.dir, clips, options });
  res.status(201).json(jobs.publicView(job));
});

// Forget abandoned uploads after a day (their folders are removed by jobs.js).
setInterval(() => {
  for (const [id, u] of uploads) if (Date.now() - u.createdAt > 24 * 3600 * 1000) uploads.delete(id);
}, 3600 * 1000).unref();

app.get('/api/jobs/:id', requirePasscode, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'This reel has expired or does not exist' });
  res.json(jobs.publicView(job));
});

app.get('/api/jobs/:id/video', requirePasscode, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Reel not ready' });
  if (req.query.download) res.attachment(`gfn-reel-${job.id.slice(0, 6)}.mp4`);
  res.sendFile(job.output);
});

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, file) => {
    if (file.endsWith('sw.js') || file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

if (require.main === module) {
  app.listen(PORT, () => console.log(`GFN Reel Cutter on http://localhost:${PORT}`));
}

module.exports = app;
