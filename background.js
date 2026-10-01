/* NetMedia Saver — MV3 service worker
 * Watches network traffic (like DevTools' Media/Img filters) and auto-saves
 * images / video / audio above a configurable minimum size.
 * Architecture: chrome.webRequest observer (metadata) + refetch via
 * chrome.downloads.download, or direct write into a user-picked folder via
 * the File System Access API. webRequest cannot read response bodies, so
 * bytes are re-fetched — blob:/data: URLs and one-time signed URLs can't
 * be captured this way (documented in README).
 *
 * v1.1: skip files already in the folder (savedFiles map + basename index),
 * per-tab enable/disable (tabEnabled map persisted as tabStates).
 * v1.2: optional maximum size gate; typed min/max inputs; capture defaults
 * to the tab the extension was enabled on (settings.enabledTabId);
 * cache-existing-files scan (cacheFiles chunks / scanExisting).
 */

const DEFAULTS = {
  enabled: false,          // the first explicit enable defines the capture tab (enabledTabId)
  minSizeKB: 200,          // minimum file size gate
  maxSizeKB: 0,            // maximum file size gate; 0 = no limit
  types: { image: true, video: true, audio: true },
  saveUnknownSize: true,   // save when no Content-Length is present
  subfolder: 'netsaver/{date}', // template: {date} {host} {kind}
  useCustomFolder: false,  // true = write into File System Access dir handle
  customFolderName: '',    // display name of picked folder
  maxConcurrent: 5,
  dedupLimit: 5000,
  skipExisting: true,      // don't re-save files already in the folder
  skipScope: 'basename',   // 'basename' = same filename in any subfolder; 'exact' = exact folder + filename
  enabledTabId: -1,        // tab the extension was last enabled on; unknown tabs default off unless they are this one
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
let savedFiles = new Map();  // relPath -> { url, size } (persisted)
let basenameIndex = new Map(); // lowercased basename -> [{ relPath, size }]
let tabEnabled = {};         // tabId -> bool (persisted as tabStates)
let queue = [];
let activeCount = 0;
let sessionSaved = 0;
let sessionBytes = 0;

/* ---------- storage ---------- */

async function loadState() {
  const s = await chrome.storage.local.get(['settings', 'savedUrls', 'savedFiles', 'stats', 'tabStates']);
  if (s.settings) settings = { ...DEFAULTS, ...s.settings, types: { ...DEFAULTS.types, ...(s.settings.types || {}) } };
  if (Array.isArray(s.savedUrls)) savedUrls = new Set(s.savedUrls);
  if (Array.isArray(s.savedFiles)) {
    savedFiles = new Map(s.savedFiles);
    rebuildBasenameIndex();
  }
  if (s.tabStates && typeof s.tabStates === 'object') tabEnabled = { ...s.tabStates };
  if (s.stats) { sessionSaved = s.stats.savedCount || 0; sessionBytes = s.stats.savedBytes || 0; }
  updateBadge();

  // Best-effort prune of tab states for tabs that no longer exist.
  try {
    const tabs = await chrome.tabs.query({});
    const live = new Set((tabs || []).map((t) => t.id));
    let changed = false;
    for (const id of Object.keys(tabEnabled)) {
      if (!live.has(Number(id))) { delete tabEnabled[id]; changed = true; }
    }
    if (changed) persistTabStates();
  } catch (e) { /* tabs API unavailable — keep states */ }

  // Best-effort backfill: seed savedFiles from download history so files
  // saved before v1.1 (or while the SW was unloaded) are known.
  await backfillFromDownloads(2000);
}

/* Seed savedFiles from chrome.download history entries under netsaver/.
 * Used at startup (best effort) and on demand via the scanExisting message. */
async function backfillFromDownloads(limit) {
  let added = 0;
  try {
    const items = await new Promise((resolve) => {
      try {
        chrome.downloads.search({ limit }, (res) => resolve(res || []));
      } catch (e) { resolve([]); }
    });
    for (const it of items) {
      const fn = String(it.filename || '').replace(/\\/g, '/');
      const idx = fn.toLowerCase().indexOf('netsaver/');
      if (idx < 0) continue;
      const relPath = fn.slice(idx);
      if (!relPath || savedFiles.has(relPath)) continue;
      addSavedFile(relPath, it.url || '', it.fileSize ?? null);
      added++;
    }
    if (added) persistSoon();
  } catch (e) { /* never block startup */ }
  return added;
}

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

function persistTabStates() {
  try {
    const p = chrome.storage.local.set({ tabStates: tabEnabled });
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* ignore */ }
}

let persistTimer = null;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    const trimmedUrls = [...savedUrls].slice(-settings.dedupLimit);
    savedUrls = new Set(trimmedUrls);
    const trimmedFiles = [...savedFiles.entries()].slice(-settings.dedupLimit);
    savedFiles = new Map(trimmedFiles);
    rebuildBasenameIndex();
    await chrome.storage.local.set({
      savedUrls: trimmedUrls,
      savedFiles: trimmedFiles,
      tabStates: tabEnabled,
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

async function updateTabTitle(tabId) {
  try {
    const on = effectiveEnabled(tabId);
    await chrome.action.setTitle({
      tabId,
      title: `NetMedia Saver — ${on ? 'capturing on this tab' : 'paused on this tab'}`,
    });
  } catch (e) { /* tab gone */ }
}

/* ---------- per-tab enable ---------- */

function effectiveEnabled(tabId) {
  if (!settings.enabled) return false;
  if (tabId == null || tabId < 0) return true; // non-tab requests (e.g. workers) follow the global switch
  if (tabId in tabEnabled) return tabEnabled[tabId];
  if (settings.enabledTabId < 0) return true; // never explicitly enabled (e.g. upgraded v1.x settings) — legacy behavior
  // Default: only the tab the extension was enabled on captures.
  return tabId === settings.enabledTabId;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId in tabEnabled) {
    delete tabEnabled[tabId];
    persistTabStates();
  }
});

/* ---------- duplicate detection ---------- */

function basenameOf(relPath) {
  const i = relPath.lastIndexOf('/');
  return i >= 0 ? relPath.slice(i + 1) : relPath;
}

function sizeClose(a, b) {
  if (a == null || b == null) return true; // unknown size — treat as a match
  return Math.abs(a - b) <= Math.max(a, b) * 0.01; // within 1%
}

function addSavedFile(relPath, url, size) {
  if (!relPath) return;
  const old = savedFiles.get(relPath);
  if (old) {
    const base = basenameOf(relPath).toLowerCase();
    const arr = basenameIndex.get(base);
    if (arr) {
      const i = arr.findIndex((e) => e.relPath === relPath);
      if (i >= 0) arr.splice(i, 1);
    }
  }
  const entry = { url: url || '', size: size ?? null };
  savedFiles.set(relPath, entry);
  const base = basenameOf(relPath).toLowerCase();
  if (!basenameIndex.has(base)) basenameIndex.set(base, []);
  basenameIndex.get(base).push({ relPath, size: entry.size });
}

function rebuildBasenameIndex() {
  basenameIndex = new Map();
  for (const [relPath, v] of savedFiles) {
    const base = basenameOf(relPath).toLowerCase();
    if (!basenameIndex.has(base)) basenameIndex.set(base, []);
    basenameIndex.get(base).push({ relPath, size: v.size ?? null });
  }
}

function isDuplicate(relPath, sizeBytes) {
  if (settings.skipScope === 'exact') {
    return savedFiles.has(relPath);
  }
  const entries = basenameIndex.get(basenameOf(relPath).toLowerCase());
  if (!entries) return false;
  return entries.some((e) => sizeClose(e.size, sizeBytes));
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
  // relPath like "a/b/c.jpg" -> { dir, name, dirPath }
  const parts = relPath.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  return { dir, name, dirPath: parts.join('/') };
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
  const rel = task.relPath || buildRelPath(task.url, task.kind, task.contentType);
  const { dir, name, dirPath } = await ensurePath(dirHandle, rel);
  if (settings.skipExisting) {
    try {
      await dir.getFileHandle(name);
      return { skipped: true, bytes: 0, savedRelPath: rel }; // already in the folder — skip the fetch
    } catch { /* not there — proceed */ }
  }
  const res = await fetch(task.url, { credentials: 'include' });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const buf = await res.arrayBuffer();
  const finalName = await uniquifyName(dir, name);
  const fh = await dir.getFileHandle(finalName, { create: true });
  const w = await fh.createWritable();
  await w.write(buf);
  await w.close();
  return { skipped: false, bytes: buf.byteLength, savedRelPath: dirPath ? `${dirPath}/${finalName}` : finalName };
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
    let savedRelPath = task.relPath;
    if (settings.useCustomFolder) {
      const res = await fetchAndWrite(task);
      if (res.skipped) {
        addSavedFile(task.relPath, task.url, null);
        persistSoon();
        await addLog({ url: task.url, kind: task.kind, size: null, status: 'skipped-duplicate', via: 'folder' });
        return; // skips don't count toward stats
      }
      bytes = res.bytes;
      if (res.savedRelPath) savedRelPath = res.savedRelPath;
    } else {
      await downloadsSave(task);
      // byte count confirmed on completion via onChanged; use header meanwhile
    }
    addSavedFile(savedRelPath, task.url, bytes || null);
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
      { url: task.url, filename: task.relPath || buildRelPath(task.url, task.kind, task.contentType), conflictAction: 'uniquify', saveAs: false },
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
  const tabId = typeof details.tabId === 'number' ? details.tabId : -1;
  if (!effectiveEnabled(tabId)) return; // silently ignore tabs that are disabled
  if (details.method !== 'GET') return;
  const url = details.url;
  if (!/^https?:\/\//i.test(url)) return; // skip blob:, data:, etc.
  if (savedUrls.has(url)) return;

  const contentType = headerValue(details.responseHeaders, 'content-type');
  const kind = classifyKind(contentType, details.type);
  if (!kind || !settings.types[kind]) return;

  const sizeBytes = sizeFromHeaders(details);
  const minBytes = (settings.minSizeKB || 0) * 1024;
  if (sizeBytes !== null) {
    if (sizeBytes < minBytes) {
      await addLog({ url, kind, size: sizeBytes, status: 'skipped-size' });
      return;
    }
    const maxKB = settings.maxSizeKB || 0;
    if (maxKB > 0 && sizeBytes > maxKB * 1024) {
      await addLog({ url, kind, size: sizeBytes, status: 'skipped-too-large' });
      return;
    }
  } else if (!settings.saveUnknownSize) {
    await addLog({ url, kind, size: null, status: 'skipped-unknown' });
    return;
  }

  const relPath = buildRelPath(url, kind, contentType);
  if (settings.skipExisting && isDuplicate(relPath, sizeBytes)) {
    await addLog({ url, kind, size: sizeBytes, status: 'skipped-duplicate' });
    return;
  }

  enqueue({ url, kind, contentType, sizeBytes, relPath });
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => { onHeadersReceived(details).catch((e) => console.warn('[nmsaver]', e)); },
  { urls: ['<all_urls>'], types: ['image', 'media', 'xmlhttprequest'] },
  ['responseHeaders']
);

/* ---------- messages from popup ---------- */

async function onMessage(msg, _sender, sendResponse) {
  if (msg.cmd === 'getState') {
    const { log = [] } = await chrome.storage.local.get('log');
    const out = { settings, sessionSaved, sessionBytes, queueLen: queue.length, activeCount, log: log.slice(0, 20), tabEnabled };
    if (typeof msg.tabId === 'number') {
      out.tabId = msg.tabId;
      out.tabEnabled = effectiveEnabled(msg.tabId);
    }
    sendResponse(out);
  } else if (msg.cmd === 'setSettings') {
    const patch = msg.settings || {};
    settings = { ...settings, ...patch, types: { ...settings.types, ...(patch.types || {}) } };
    if (patch.enabled && typeof msg.tabId === 'number' && msg.tabId >= 0) {
      // The extension was (re-)enabled on this tab — it becomes the capture tab by default.
      settings.enabledTabId = msg.tabId;
    }
    await saveSettings();
    // Global switch flips every per-tab title; refresh the ones we know.
    for (const id of Object.keys(tabEnabled)) updateTabTitle(Number(id));
    if (settings.enabled && settings.enabledTabId >= 0) updateTabTitle(settings.enabledTabId);
    sendResponse({ ok: true, settings });
  } else if (msg.cmd === 'setTabEnabled') {
    const tabId = msg.tabId;
    if (typeof tabId === 'number' && tabId >= 0) {
      tabEnabled[tabId] = !!msg.enabled;
      persistTabStates();
      await updateTabTitle(tabId);
    }
    sendResponse({ ok: true, tabEnabled: effectiveEnabled(tabId) });
  } else if (msg.cmd === 'cacheFiles') {
    // Chunked upload from the popup's recursive walk of the custom folder.
    let added = 0;
    for (const [relPath, size] of (msg.files || [])) {
      if (typeof relPath === 'string' && relPath && !savedFiles.has(relPath)) {
        addSavedFile(relPath, '', size ?? null);
        added++;
      }
    }
    if (added) persistSoon();
    sendResponse({ ok: true, added });
  } else if (msg.cmd === 'scanExisting') {
    // On-demand scan of download history (Downloads-subfolder mode).
    const added = await backfillFromDownloads(5000);
    sendResponse({ ok: true, added });
  } else if (msg.cmd === 'resetStats') {
    sessionSaved = 0; sessionBytes = 0; updateBadge(); persistSoon();
    sendResponse({ ok: true });
  } else if (msg.cmd === 'clearDedup') {
    savedUrls.clear();
    savedFiles = new Map();
    rebuildBasenameIndex();
    await chrome.storage.local.set({ savedUrls: [], savedFiles: [] });
    sendResponse({ ok: true });
  } else if (msg.cmd === 'clearLog') {
    await chrome.storage.local.set({ log: [] });
    sendResponse({ ok: true });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  onMessage(msg, sender, sendResponse).catch((e) => console.warn('[nmsaver]', e));
  return true; // async response
});

loadState();

// Test hook: expose internals under Node (module is undefined in a real service worker).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getSettings: () => settings,
    getSavedFiles: () => savedFiles,
    getSavedUrls: () => savedUrls,
    getTabEnabled: () => tabEnabled,
    getQueue: () => queue,
    effectiveEnabled,
    isDuplicate,
    addSavedFile,
    classifyKind,
    sizeFromHeaders,
    buildRelPath,
    basenameOf,
    backfillFromDownloads,
    onHeadersReceived,
    onMessage,
  };
}
