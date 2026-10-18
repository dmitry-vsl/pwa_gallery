const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'heic', 'heif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', '3gp', 'mkv']);
const THUMB_SIZE = 384;
const THUMB_WORKERS = 4;
const READ_BATCH = 64;
const VIDEO_THUMB_TIMEOUT_MS = 15000;

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const statusEl = $('status');
const titleEl = $('title');
const emptyEl = $('empty');
const reopenBtn = $('reopen');
const fallbackInput = $('fallback');
const viewer = $('viewer');
const stage = $('stage');
const caption = $('caption');

let items = [];
// Bumped on every new folder load, so work from an older load can tell it is stale.
let generation = 0;

function extOf(name) {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

function mediaKind(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- IndexedDB (remembers the last picked folder) ----------

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('gallery', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

const idbGet = (key) => idb('readonly', (store) => store.get(key));
const idbSet = (key, value) => idb('readwrite', (store) => store.put(value, key));

// ---------- Loading ----------

function reset(title) {
  generation++;
  closeViewerNow();
  for (const item of items) if (item.thumb) URL.revokeObjectURL(item.thumb);
  items = [];
  queue.length = 0;
  observer.disconnect();
  grid.replaceChildren();
  titleEl.textContent = title;
  emptyEl.hidden = true;
}

async function collect(dir, path, out, gen) {
  for await (const [name, handle] of dir.entries()) {
    if (gen !== generation) return;
    if (name.startsWith('.')) continue;
    if (handle.kind === 'directory') {
      await collect(handle, `${path}${name}/`, out, gen);
    } else {
      const kind = mediaKind(name);
      if (kind) out.push({ path: path + name, kind, handle });
    }
    if (out.length % 100 === 0) setStatus(`Scanning… ${out.length} found`);
  }
}

async function readEntry(entry) {
  try {
    return { path: entry.path, kind: entry.kind, file: await entry.handle.getFile() };
  } catch (e) {
    console.warn('Cannot read file', entry.path, e);
    return null;
  }
}

async function loadFromHandle(dir) {
  reset(dir.name);
  const gen = generation;
  setStatus('Scanning…');
  const entries = [];
  try {
    await collect(dir, '', entries, gen);
  } catch (e) {
    console.error('Folder scan failed', e);
    setStatus(`Scan failed: ${e.message}`);
    return;
  }
  const loaded = [];
  for (let i = 0; i < entries.length; i += READ_BATCH) {
    if (gen !== generation) return;
    const batch = await Promise.all(entries.slice(i, i + READ_BATCH).map(readEntry));
    loaded.push(...batch.filter(Boolean));
    setStatus(`Reading ${loaded.length} / ${entries.length}`);
  }
  if (gen === generation) render(loaded);
}

function loadFromFileList(files) {
  const first = files[0]?.webkitRelativePath;
  reset(first ? first.split('/')[0] : 'Selected files');
  const loaded = [];
  for (const file of files) {
    const kind = mediaKind(file.name);
    if (kind) loaded.push({ path: file.webkitRelativePath || file.name, kind, file });
  }
  render(loaded);
}

function render(list) {
  // File creation time is not exposed to the web, so lastModified is the only date available.
  list.sort((a, b) => b.file.lastModified - a.file.lastModified);
  items = list;
  const fragment = document.createDocumentFragment();
  items.forEach((item, i) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.i = i;
    cell.dataset.ext = extOf(item.path);
    item.cell = cell;
    fragment.append(cell);
    observer.observe(cell);
  });
  grid.append(fragment);
  emptyEl.hidden = items.length > 0;
  setStatus(`${items.length} items`);
}

// ---------- Thumbnails ----------

// LIFO, so cells the user scrolled to most recently are drawn first.
const queue = [];
let activeWorkers = 0;

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    queue.push(Number(entry.target.dataset.i));
  }
  pump();
}, { rootMargin: '800px 0px' });

function pump() {
  while (activeWorkers < THUMB_WORKERS && queue.length) {
    const i = queue.pop();
    activeWorkers++;
    loadThumb(items[i], generation).finally(() => {
      activeWorkers--;
      pump();
    });
  }
}

function videoFrame(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const timer = setTimeout(() => finish(new Error('Video thumbnail timeout')), VIDEO_THUMB_TIMEOUT_MS);
    let duration = NaN;

    function finish(err, bitmap) {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      if (err) reject(err);
      else resolve({ bitmap, duration });
    }

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadeddata = () => {
      duration = video.duration;
      video.currentTime = Number.isFinite(duration) ? Math.min(1, duration / 2) : 0;
    };
    video.onseeked = () => {
      createImageBitmap(video, { resizeWidth: THUMB_SIZE }).then((bitmap) => finish(null, bitmap), finish);
    };
    video.onerror = () => finish(video.error || new Error('Video decode failed'));
    video.src = url;
  });
}

async function squareJpeg(bitmap) {
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(side, side);
  canvas.getContext('2d').drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, side, side,
  );
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}

async function loadThumb(item, gen) {
  try {
    const { bitmap, duration } = item.kind === 'image'
      ? { bitmap: await createImageBitmap(item.file, { resizeWidth: THUMB_SIZE }) }
      : await videoFrame(item.file);
    const url = URL.createObjectURL(await squareJpeg(bitmap));
    if (gen !== generation) {
      URL.revokeObjectURL(url);
      return;
    }
    item.thumb = url;
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    item.cell.append(img);
    if (item.kind === 'video') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = Number.isFinite(duration) ? `▶ ${formatDuration(duration)}` : '▶';
      item.cell.append(badge);
    }
  } catch (e) {
    console.warn('Thumbnail failed', item.path, e);
    if (gen === generation) item.cell.classList.add('broken');
  }
}

// ---------- Fullscreen viewer ----------

let current = -1;
let viewUrl = null;

function showItem(i) {
  if (i < 0 || i >= items.length) return;
  current = i;
  const item = items[i];
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = URL.createObjectURL(item.file);

  const el = document.createElement(item.kind === 'video' ? 'video' : 'img');
  if (item.kind === 'video') {
    el.controls = true;
    el.autoplay = true;
    el.playsInline = true;
  }
  el.onerror = () => {
    console.warn('Cannot display', item.path, el.error);
    const msg = document.createElement('div');
    msg.className = 'error';
    msg.textContent = `This browser cannot show .${extOf(item.path)} files`;
    el.replaceWith(msg);
  };
  el.src = viewUrl;
  stage.replaceChildren(el);
  caption.textContent = `${formatDate(item.file.lastModified)} · ${item.path}`;
}

function openViewer(i) {
  // A history entry lets the Android back button close the viewer.
  if (current < 0) history.pushState({ viewer: true }, '');
  viewer.hidden = false;
  showItem(i);
}

function closeViewerNow() {
  viewer.hidden = true;
  stage.replaceChildren();
  if (viewUrl) URL.revokeObjectURL(viewUrl);
  viewUrl = null;
  current = -1;
}

window.addEventListener('popstate', () => {
  if (current >= 0) closeViewerNow();
});

$('close').addEventListener('click', () => history.back());

document.addEventListener('keydown', (e) => {
  if (current < 0) return;
  if (e.key === 'Escape') history.back();
  else if (e.key === 'ArrowRight') showItem(current + 1);
  else if (e.key === 'ArrowLeft') showItem(current - 1);
});

let touchStart = null;
stage.addEventListener('touchstart', (e) => {
  touchStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
stage.addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) showItem(current + (dx < 0 ? 1 : -1));
}, { passive: true });

grid.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (cell) openViewer(Number(cell.dataset.i));
});

// ---------- Folder picking ----------

async function ensureReadPermission(handle) {
  if (!handle.queryPermission) return true;
  const opts = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

$('pick').addEventListener('click', async () => {
  if (!('showDirectoryPicker' in window)) {
    fallbackInput.click();
    return;
  }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'gallery', mode: 'read', startIn: 'pictures' });
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Folder picker failed', e);
      setStatus(`Picker failed: ${e.message}`);
    }
    return;
  }
  idbSet('dir', dir).catch((e) => console.warn('Cannot remember folder', e));
  loadFromHandle(dir);
});

fallbackInput.addEventListener('change', () => {
  if (fallbackInput.files.length) loadFromFileList([...fallbackInput.files]);
  fallbackInput.value = '';
});

async function offerReopen() {
  if (!('showDirectoryPicker' in window)) return;
  let handle;
  try {
    handle = await idbGet('dir');
  } catch (e) {
    console.warn('Cannot read saved folder', e);
    return;
  }
  if (!handle) return;
  reopenBtn.textContent = `Open "${handle.name}" again`;
  reopenBtn.hidden = false;
  reopenBtn.addEventListener('click', async () => {
    try {
      if (await ensureReadPermission(handle)) loadFromHandle(handle);
      else setStatus('Permission denied');
    } catch (e) {
      console.error('Cannot reopen folder', e);
      setStatus(`Cannot reopen: ${e.message}`);
    }
  });
}

offerReopen();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker failed', e));
}
