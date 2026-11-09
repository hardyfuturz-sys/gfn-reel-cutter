// Video pipeline: probe clips, find silences, render one 9:16 reel with FFmpeg.
const { spawn } = require('node:child_process');

const OUT_W = 1080;
const OUT_H = 1920;
const FPS = 30;

function run(cmd, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
      if (onStdout) onStdout(d.toString());
    });
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} exited with ${code}: ${err.slice(-1500)}`));
    });
  });
}

async function probe(file) {
  const { out } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type',
    '-of', 'json',
    file,
  ]);
  const j = JSON.parse(out);
  const duration = parseFloat(j.format?.duration || '0');
  const hasAudio = (j.streams || []).some((s) => s.codec_type === 'audio');
  const hasVideo = (j.streams || []).some((s) => s.codec_type === 'video');
  if (!hasVideo) throw new Error('One of the files has no video track.');
  if (!(duration > 0)) throw new Error('Could not read the length of one of the clips.');
  return { duration, hasAudio };
}

// Returns [{start, end}] silences detected in the clip's audio.
async function detectSilences(file, { noiseDb, minSilence }) {
  const { err } = await run('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', file,
    '-vn',
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
    '-f', 'null', '-',
  ]);
  const silences = [];
  let cur = null;
  for (const line of err.split('\n')) {
    const s = line.match(/silence_start: (-?[\d.]+)/);
    const e = line.match(/silence_end: ([\d.]+)/);
    if (s) cur = { start: Math.max(0, parseFloat(s[1])) };
    if (e && cur) {
      cur.end = parseFloat(e[1]);
      silences.push(cur);
      cur = null;
    }
  }
  if (cur) {
    cur.end = Infinity; // silence runs to the end of the clip
    silences.push(cur);
  }
  return silences;
}

// Turn silences into segments to keep. `pad` keeps a little air around speech
// so words are not clipped.
function keepSegments(duration, silences, { pad = 0.15, minKeep = 0.3 } = {}) {
  const segs = [];
  let t = 0;
  for (const s of silences) {
    const end = Math.min(duration, s.start + pad);
    if (end - t >= minKeep) segs.push({ start: t, end });
    t = Math.max(t, Math.min(duration, s.end - pad));
  }
  if (duration - t >= minKeep) segs.push({ start: t, end: duration });
  return segs;
}

// Cap total length; cut the last segment short if needed.
function capSegments(segs, maxDuration) {
  const out = [];
  let total = 0;
  for (const s of segs) {
    if (total >= maxDuration) break;
    const len = Math.min(s.end - s.start, maxDuration - total);
    out.push({ ...s, end: s.start + len });
    total += len;
  }
  return out;
}

async function plan(clips, opts) {
  const parts = [];
  let inputDuration = 0;
  for (const clip of clips) {
    const info = await probe(clip.path);
    inputDuration += info.duration;
    let segs;
    if (opts.removeSilences && info.hasAudio) {
      const sil = await detectSilences(clip.path, opts);
      segs = keepSegments(info.duration, sil);
    } else {
      segs = [{ start: 0, end: info.duration }];
    }
    for (const s of segs) parts.push({ file: clip.path, hasAudio: info.hasAudio, ...s });
  }
  const capped = capSegments(parts, opts.maxDuration);
  if (!capped.length) {
    throw new Error('Nothing left after removing silences. Try turning silence removal off.');
  }
  const outputDuration = capped.reduce((a, s) => a + (s.end - s.start), 0);
  return { parts: capped, inputDuration, outputDuration };
}

async function render(parts, outFile, onProgress) {
  const args = ['-hide_banner', '-y', '-nostats'];
  // One input per segment with fast input seeking; accurate because we re-encode.
  for (const p of parts) {
    args.push('-ss', p.start.toFixed(3), '-t', (p.end - p.start).toFixed(3), '-i', p.file);
  }
  const filters = [];
  const labels = [];
  parts.forEach((p, i) => {
    const d = (p.end - p.start).toFixed(3);
    filters.push(
      `[${i}:v:0]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,` +
        `crop=${OUT_W}:${OUT_H},setsar=1,fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`
    );
    if (p.hasAudio) {
      filters.push(
        `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad,atrim=0:${d},asetpts=PTS-STARTPTS[a${i}]`
      );
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${d},asetpts=PTS-STARTPTS[a${i}]`);
    }
    labels.push(`[v${i}][a${i}]`);
  });
  filters.push(`${labels.join('')}concat=n=${parts.length}:v=1:a=1[v][a]`);

  const total = parts.reduce((a, s) => a + (s.end - s.start), 0);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    outFile
  );
  await run('ffmpeg', args, {
    onStdout: (chunk) => {
      const m = [...chunk.matchAll(/out_time_us=(\d+)/g)].pop();
      if (m && onProgress) onProgress(Math.min(1, parseInt(m[1], 10) / 1e6 / total));
    },
  });
}

module.exports = { probe, detectSilences, keepSegments, capSegments, plan, render };
