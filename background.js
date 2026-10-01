/* NetMedia Saver — MV3 service worker
 * Watches network traffic (like DevTools' Media/Img filters) and auto-saves
 * images / video / audio above a configurable minimum size.
 * Architecture: chrome.webRequest observer (metadata) + refetch via
 * chrome.downloads.download, or direct write into a user-picked folder via
 * the File System Access API. webRequest cannot read response bodies, so
 * bytes are re-fetched — blob:/data: URLs and one-time signed URLs can't
 * be captured this way (documented in README).
 */

const DEFAULTS = {
  enabled: true,
  minSizeKB: 200,          // minimum file size gate
  types: { image: true, video: true, audio: true },
  saveUnknownSize: true,   // save when no Content-Length is present
  subfolder: 'netsaver/{date}', // template: {date} {host} {kind}
  useCustomFolder: false,  // true = write into File System Access dir handle
  customFolderName: '',    // display name of picked folder
  maxConcurrent: 5,
  dedupLimit: 5000,
};

const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
  'image/svg+xml': '.svg', 'image/bmp': '.bmp', 'image/tiff': '.tif',
  'image/x-icon': '.ico',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv',
  'video/quicktime': '.mov', 'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv',
  'application/vnd.apple.mpegurl': '.m3u8', 'application/x-mpegurl': '.m3u8',
  'application/dash+xml': '.mpd',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg',
  'audio/wav': '.wav', 'audio/webm': '.weba', 'audio/flac': '.flac',
  'audio/aac': '.aac', 'audio/x-wav': '.wav',
};

let settings = { ...DEFAULTS };
let savedUrls = new Set();   // dedup across SW restarts (persisted)
let queue = [];
let activeCount = 0;
let sessionSaved = 0;
let sessionBytes = 0;

/* ---------- storage ---------- */

async function loadState() {
  const s = await chrome.storage.local.get(['settings', 'savedUrls', 'stats']);
  if (s.settings) settings = { ...DEFAULTS, ...s.settings, types: { ...DEFAULTS.types, ...(s.settings.types || {}) } };
  if (Array.isArray(s.savedUrls)) savedUrls = new Set(s.savedUrls);
  if (s.stats) { sessionSaved = s.stats.savedCount || 0; sessionBytes = s.stats.savedBytes || 0; }
  updateBadge();
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    const arr = [...savedUrls];
    const trimmed = arr.slice(-settings.dedupLimit);
    await chrome.storage.local.set({
      savedUrls: trimmed,
      stats: { savedCount: sessionSaved, savedBytes: sessionBytes },
    });
  }, 2000);
}

async function addLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift({ t: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, 60) });
}

function updateBadge() {
  chrome.action.setBadgeText({ text: sessionSaved > 0 ? String(sessionSaved) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}

/* ---------- classification ---------- */

function headerValue(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function classifyKind(contentType, reqType) {
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/') || ct === 'application/vnd.apple.mpegurl' || ct === 'application/x-mpegurl' || ct === 'application/dash+xml') return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  // fall back to the request type when the server sent no useful MIME
  if (reqType === 'image') return 'image';
  if (reqType === 'media') return 'video'; // audio/video element loads
  return null;
}

function sizeFromHeaders(details) {
  // For 206 partial content, Content-Length is the range size — use the
  // Content-Range total so the gate sees the whole file.
  if (details.statusCode === 206) {
    const cr = headerValue(details.responseHeaders, 'content-range');
    const m = cr && cr.match(/\/(\d+)\s*$/);
    if (m) return parseInt(m[1], 10);
  }
  const cl = headerValue(details.responseHeaders, 'content-length');
  if (cl) {
    const n = parseInt(cl, 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/* ---------- filename building ---------- */

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '') || 'file';
}

function extFromContentType(contentType) {
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  return MIME_EXT[ct] || '';
}

function buildRelPath(url, kind, contentType) {
  const u = new URL(url);
  let base = (u.pathname.split('/').pop() || 'file').split('?')[0].split('#')[0];
  base = sanitize(decodeURIComponent(base).slice(0, 120));
  const ext = extFromContentType(contentType);
  if (ext && !/\.[a-z0-9]{2,5}$/i.test(base)) base += ext;
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const folder = settings.subfolder
    .replaceAll('{date}', date)
    .replaceAll('{host}', sanitize(u.hostname))
    .replaceAll('{kind}', kind)
    .split('/')
    .map((seg) => sanitize(seg))
    .filter(Boolean)
    .join('/');
  return `${folder}/${base}`;
}

/* ---------- File System Access (custom folder) ---------- */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('nmsaver', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function getDirHandle() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readonly');
    const q = tx.objectStore('handles').get('dir');
    q.onsuccess = () => resolve(q.result || null);
    q.onerror = () => reject(q.error);
  });
}

async function ensurePath(root, relPath) {
  // relPath like "a/b/c.jpg" -> { dir, name }
  const parts = relPath.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  return { dir, name };
}

async function uniquifyName(dir, name) {
  try { await dir.getFileHandle(name); } catch { return name; } // doesn't exist
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 1;
  for (;;) {
    const cand = `${stem} (${i})${ext}`;
    try { await dir.getFileHandle(cand); i++; } catch { return cand; }
  }
}

async function fetchAndWrite(task) {
  const dirHandle = await getDirHandle();
  if (!dirHandle) throw new Error('no-folder');
  const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('no-permission');
  const res = await fetch(task.url, { credentials: 'include' });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const buf = await res.arrayBuffer();
  const rel = buildRelPath(task.url, task.kind, task.contentType);
  const { dir, name } = await ensurePath(dirHandle, rel);
  const finalName = await uniquifyName(dir, name);
  const fh = await dir.getFileHandle(finalName, { create: true });
  const w = await fh.createWritable();
  await w.write(buf);
  await w.close();
  return buf.byteLength;
}

/* ---------- download pipeline ---------- */

function enqueue(task) {
  queue.push(task);
  processQueue();
}

function processQueue() {
  while (activeCount < settings.maxConcurrent && queue.length) {
    const task = queue.shift();
    activeCount++;
    runTask(task).finally(() => {
      activeCount--;
      processQueue();
    });
  }
}

async function runTask(task) {
  savedUrls.add(task.url); // claim early so repeats don't double-queue
  try {
    let bytes = task.sizeBytes;
    if (settings.useCustomFolder) {
      bytes = await fetchAndWrite(task);
    } else {
      await downloadsSave(task);
      // byte count confirmed on completion via onChanged; use header meanwhile
    }
    sessionSaved++;
    if (bytes) sessionBytes += bytes;
    updateBadge(); persistSoon();
    await addLog({ url: task.url, kind: task.kind, size: bytes || null, status: 'saved', via: settings.useCustomFolder ? 'folder' : 'downloads' });
  } catch (e) {
    await addLog({ url: task.url, kind: task.kind, size: task.sizeBytes, status: 'error', error: String(e && e.message || e) });
    // Fall back to the Downloads pipeline if the custom folder failed
    if (settings.useCustomFolder && !task.retried) {
      task.retried = true;
      const keep = settings.useCustomFolder;
      settings.useCustomFolder = false;
      try { await runTask(task); } finally { settings.useCustomFolder = keep; }
      return;
    }
  }
}

function downloadsSave(task) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: task.url, filename: buildRelPath(task.url, task.kind, task.contentType), conflictAction: 'uniquify', saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (typeof id === 'undefined') reject(new Error('download-rejected'));
        else resolve(id);
      }
    );
  });
}

// downloads.download resolves at START, not completion — finalize via onChanged
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
    chrome.downloads.search({ id: delta.id }, (items) => {
      const it = items && items[0];
      if (!it) return;
      if (delta.state.current === 'interrupted') {
        addLog({ url: it.url, kind: '?', size: it.fileSize || null, status: 'error', error: it.error || 'interrupted' });
      }
      // On complete the bytes were already counted from headers; nothing to do.
    });
  }
});

/* ---------- observer ---------- */

async function onHeadersReceived(details) {
  if (!settings.enabled) return;
  if (details.method !== 'GET') return;
  const url = details.url;
  if (!/^https?:\/\//i.test(url)) return; // skip blob:, data:, etc.
  if (savedUrls.has(url)) return;

  const contentType = headerValue(details.responseHeaders, 'content-type');
  const kind = classifyKind(contentType, details.type);
  if (!kind || !settings.types[kind]) return;

  const sizeBytes = sizeFromHeaders(details);
  const minBytes = settings.minSizeKB * 1024;
  if (sizeBytes !== null) {
    if (sizeBytes < minBytes) {
      await addLog({ url, kind, size: sizeBytes, status: 'skipped-size' });
      return;
    }
  } else if (!settings.saveUnknownSize) {
    await addLog({ url, kind, size: null, status: 'skipped-unknown' });
    return;
  }

  enqueue({ url, kind, contentType, sizeBytes });
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => { onHeadersReceived(details).catch((e) => console.warn('[nmsaver]', e)); },
  { urls: ['<all_urls>'], types: ['image', 'media', 'xmlhttprequest'] },
  ['responseHeaders']
);

/* ---------- messages from popup ---------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.cmd === 'getState') {
      const { log = [] } = await chrome.storage.local.get('log');
      sendResponse({ settings, sessionSaved, sessionBytes, queueLen: queue.length, activeCount, log: log.slice(0, 20) });
    } else if (msg.cmd === 'setSettings') {
      settings = { ...settings, ...msg.settings, types: { ...settings.types, ...(msg.settings.types || {}) } };
      await saveSettings();
      sendResponse({ ok: true, settings });
    } else if (msg.cmd === 'resetStats') {
      sessionSaved = 0; sessionBytes = 0; updateBadge(); persistSoon();
      sendResponse({ ok: true });
    } else if (msg.cmd === 'clearDedup') {
      savedUrls.clear();
      await chrome.storage.local.set({ savedUrls: [] });
      sendResponse({ ok: true });
    } else if (msg.cmd === 'clearLog') {
      await chrome.storage.local.set({ log: [] });
      sendResponse({ ok: true });
    }
  })();
  return true; // async response
});

loadState();
