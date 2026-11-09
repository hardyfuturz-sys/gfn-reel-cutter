(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_FILES = 5;
  const MAX_BYTES = 200 * 1024 * 1024;
  const state = { clips: [], passcode: localStorage.getItem('gfn-passcode') || '', polling: null };

  const show = (...ids) => {
    for (const id of ['login', 'editor', 'progress', 'result']) $(id).classList.toggle('hidden', !ids.includes(id));
  };
  const mb = (b) => (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(1)} s`);
  const headers = () => (state.passcode ? { 'x-passcode': state.passcode } : {});
  const keyQuery = () => (state.passcode ? `key=${encodeURIComponent(state.passcode)}` : '');
  function setError(id, msg) {
    $(id).textContent = msg || '';
    $(id).classList.toggle('hidden', !msg);
  }

  // ---------- start ----------
  async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    let cfg = { passcodeRequired: false };
    try { cfg = await (await fetch('api/config')).json(); } catch {}
    if (cfg.passcodeRequired && !(await checkPasscode(state.passcode))) {
      show('login');
      return;
    }
    const last = localStorage.getItem('gfn-last-job');
    if (last) return resumeJob(last);
    show('editor');
  }

  async function checkPasscode(code) {
    if (!code) return false;
    const r = await fetch('api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: code }),
    });
    return r.ok;
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('passcode').value.trim();
    if (await checkPasscode(code)) {
      state.passcode = code;
      localStorage.setItem('gfn-passcode', code);
      setError('loginError');
      show('editor');
    } else setError('loginError', 'Wrong passcode. Try again.');
  });

  // ---------- clips ----------
  $('fileInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      if (state.clips.length >= MAX_FILES) { setError('editorError', `Up to ${MAX_FILES} clips at a time.`); break; }
      state.clips.push({ file: f, url: URL.createObjectURL(f), duration: null });
    }
    renderClips();
  });

  function renderClips() {
    const list = $('clipList');
    list.innerHTML = '';
    state.clips.forEach((c, i) => {
      const li = document.createElement('li');
      li.className = 'clip';
      const v = document.createElement('video');
      v.src = c.url + '#t=0.1';
      v.muted = true; v.playsInline = true; v.preload = 'metadata';
      v.addEventListener('loadedmetadata', () => {
        c.duration = v.duration;
        li.querySelector('.meta').textContent = `${secs(v.duration)} · ${mb(c.file.size)}`;
      });
      const info = document.createElement('div');
      info.style.minWidth = '0';
      info.innerHTML = `<div class="name"><span class="num">${i + 1}</span></div><div class="meta">${c.duration ? secs(c.duration) + ' · ' : ''}${mb(c.file.size)}</div>`;
      info.querySelector('.name').append(c.file.name);
      const tools = document.createElement('div');
      tools.className = 'tools';
      tools.append(
        iconBtn('↑', 'Move up', i === 0, () => move(i, -1)),
        iconBtn('↓', 'Move down', i === state.clips.length - 1, () => move(i, 1)),
        iconBtn('✕', 'Remove', false, () => remove(i)),
      );
      li.append(v, info, tools);
      list.append(li);
    });
    const total = state.clips.reduce((a, c) => a + c.file.size, 0);
    $('totalSize').textContent = state.clips.length ? `${state.clips.length} clip${state.clips.length > 1 ? 's' : ''} · ${mb(total)}` : '';
    const tooBig = total > MAX_BYTES;
    setError('editorError', tooBig ? 'Clips are over 200 MB in total. Remove one or shoot at 1080p.' : '');
    $('makeBtn').disabled = !state.clips.length || tooBig;
  }

  function iconBtn(label, title, disabled, onClick) {
    const b = document.createElement('button');
    b.className = 'icon'; b.type = 'button'; b.textContent = label; b.title = title; b.ariaLabel = title;
    b.disabled = disabled; b.onclick = onClick;
    return b;
  }
  function move(i, d) {
    const [c] = state.clips.splice(i, 1);
    state.clips.splice(i + d, 0, c);
    renderClips();
  }
  function remove(i) {
    URL.revokeObjectURL(state.clips[i].url);
    state.clips.splice(i, 1);
    renderClips();
  }

  // ---------- settings ----------
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
  const segValue = (name) => document.querySelector(`.seg[data-name="${name}"] .on`).dataset.value;
  $('removeSilences').addEventListener('change', (e) => $('pauseGroup').querySelector('.seg').classList.toggle('disabled', !e.target.checked));

  // ---------- upload & job ----------
  class HttpError extends Error {
    constructor(status, msg, data) { super(msg); this.status = status; this.data = data; }
  }
  async function api(method, url, body, extra = {}) {
    const isJson = body && !(body instanceof Blob);
    const r = await fetch(url, {
      method,
      headers: { ...headers(), ...(isJson ? { 'content-type': 'application/json' } : { 'content-type': 'application/octet-stream' }), ...extra },
      body: isJson ? JSON.stringify(body) : body,
    });
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) throw new HttpError(r.status, data.error || `Request failed (${r.status})`, data);
    return data;
  }

  // Upload one clip in pieces, retrying a piece up to 4 times on a bad connection.
  async function uploadClip(id, n, file, chunkBytes, onBytes) {
    let offset = 0;
    while (offset < file.size) {
      const piece = file.slice(offset, offset + chunkBytes);
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await api('PUT', `api/uploads/${id}/clips/${n}`, piece, { 'x-offset': String(offset) });
          offset = r.size;
          break;
        } catch (e) {
          if (e.status === 409 && Number.isFinite(e.data?.size)) { offset = e.data.size; break; } // resume where the server is
          if ((e.status && e.status < 500) || attempt >= 4) throw e;
          await new Promise((res) => setTimeout(res, 1500 * attempt));
        }
      }
      onBytes(offset);
    }
  }

  $('makeBtn').addEventListener('click', async () => {
    const clips = state.clips.slice();
    const total = clips.reduce((a, c) => a + c.file.size, 0);
    show('progress');
    setProgress('Uploading', 0, 'Keep this screen open until the upload finishes.');
    try {
      const up = await api('POST', 'api/uploads', {});
      let done = 0;
      for (let i = 0; i < clips.length; i++) {
        const before = done;
        await uploadClip(up.id, i + 1, clips[i].file, up.chunkBytes, (sent) => {
          setProgress('Uploading', (before + sent) / total, `Clip ${i + 1} of ${clips.length} · ${mb(before + sent)} of ${mb(total)}`);
        });
        done += clips[i].file.size;
      }
      const job = await api('POST', `api/uploads/${up.id}/start`, {
        clips: clips.map((c, i) => ({ n: i + 1, name: c.file.name, size: c.file.size })),
        options: {
          removeSilences: $('removeSilences').checked,
          minSilence: +segValue('minSilence'),
          maxDuration: +segValue('maxDuration'),
        },
      });
      localStorage.setItem('gfn-last-job', job.id);
      trackJob(job);
    } catch (e) {
      if (e.status === 401) { localStorage.removeItem('gfn-passcode'); state.passcode = ''; show('login'); return; }
      backToEditor(e.status ? e.message : 'Upload failed. Check your connection and try again.');
    }
  });

  function setProgress(title, frac, text) {
    $('progressTitle').textContent = title;
    $('barFill').style.width = `${Math.round(frac * 100)}%`;
    $('progressText').textContent = text || '';
  }

  function backToEditor(msg) {
    clearTimeout(state.polling);
    show('editor');
    setError('editorError', msg);
  }

  async function resumeJob(id) {
    try {
      const r = await fetch(`api/jobs/${id}`, { headers: headers() });
      if (!r.ok) throw new Error();
      show('progress');
      trackJob(await r.json());
    } catch {
      localStorage.removeItem('gfn-last-job');
      show('editor');
    }
  }

  function trackJob(job) {
    clearTimeout(state.polling);
    if (job.status === 'done') return showResult(job);
    if (job.status === 'error') {
      localStorage.removeItem('gfn-last-job');
      return backToEditor(job.error || 'Something went wrong while making the reel.');
    }
    const titles = { queued: 'Waiting in line', analyzing: 'Finding the pauses', rendering: 'Rendering your reel' };
    const frac = job.status === 'rendering' ? job.progress / 100 : 0.02;
    const text = job.status === 'queued' ? `Position ${job.position} in the queue` : job.status === 'rendering' ? `${job.progress}%` : 'This takes a few seconds.';
    setProgress(titles[job.status] || 'Working', frac, text);
    state.polling = setTimeout(async () => {
      try {
        const r = await fetch(`api/jobs/${job.id}`, { headers: headers() });
        if (r.status === 404) { localStorage.removeItem('gfn-last-job'); return backToEditor('This reel expired. Please upload again.'); }
        trackJob(await r.json());
      } catch { trackJob(job); }
    }, 1200);
  }

  function showResult(job) {
    const q = keyQuery();
    const src = `api/jobs/${job.id}/video${q ? '?' + q : ''}`;
    $('resultVideo').src = src;
    $('downloadBtn').href = `api/jobs/${job.id}/video?download=1${q ? '&' + q : ''}`;
    $('downloadBtn').setAttribute('download', `gfn-reel-${job.id.slice(0, 6)}.mp4`);
    const s = job.stats || {};
    $('stats').innerHTML = '';
    const items = [
      ['Reel length', secs(s.outputSeconds || 0)],
      ['Pauses removed', secs(s.removedSeconds || 0)],
      ['Cuts', String(s.cuts ?? '–')],
      ['Processed in', secs(s.renderSeconds || 0)],
    ];
    for (const [k, v] of items) {
      const li = document.createElement('li');
      li.innerHTML = `<b></b>`;
      li.querySelector('b').textContent = v;
      li.append(k);
      $('stats').append(li);
    }
    const canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.mp4', { type: 'video/mp4' })] }));
    $('shareBtn').classList.toggle('hidden', !canShareFiles);
    $('shareBtn').onclick = async () => {
      $('shareBtn').disabled = true;
      $('shareBtn').textContent = 'Preparing…';
      try {
        const blob = await (await fetch(src)).blob();
        const file = new File([blob], `gfn-reel-${job.id.slice(0, 6)}.mp4`, { type: 'video/mp4' });
        await navigator.share({ files: [file], title: 'GFN reel' });
      } catch {}
      $('shareBtn').disabled = false;
      $('shareBtn').textContent = 'Share to Instagram…';
    };
    show('result');
  }

  $('againBtn').addEventListener('click', () => {
    localStorage.removeItem('gfn-last-job');
    $('resultVideo').removeAttribute('src');
    for (const c of state.clips) URL.revokeObjectURL(c.url);
    state.clips = [];
    renderClips();
    setError('editorError');
    show('editor');
  });

  start();
})();
