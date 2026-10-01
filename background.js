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
 * v1.5: skip DASH/HLS fMP4 media segments (unplayable alone) with a clear
 * skipped-segment log status; optional image dimension gates (min/max
 * width/height) via a tiny Range-request header probe — unknown dimensions
 * never block a save. Default min file size lowered 200KB -> 75KB.
 * v1.6: atomic in-flight dedup claims (fixes the "photo.jpg / photo (1).jpg /
 * photo (2).jpg" duplicates: two webRequest events for the same file used to
 * pass the dedup check before either download started, and Chrome's `uniquify`
 * then renamed the second copy); interrupted downloads are erased (partial
 * file deleted) and their dedup records rolled back so a re-request retries
 * cleanly; download-history backfill no longer seeds interrupted entries;
 * custom-folder writes delete truncated files on failure; image filters gain
 * an AND/OR combine mode ("File size AND dimensions" vs "File size OR
 * dimensions").
 */

const DEFAULTS = {
  enabled: false,          // the first explicit enable defines the capture tab (enabledTabId)
  minSizeKB: 75,           // minimum file size gate
  maxSizeKB: 0,            // maximum file size gate; 0 = no limit
  types: { image: true, video: true, audio: true },
  skipSegments: true,      // skip DASH/HLS fMP4 media segments (unplayable without the init segment)
  imgDims: {               // image dimension gates; max* = 0 means no upper limit
    enabled: true, minW: 600, minH: 600, maxW: 0, maxH: 0,
    logic: 'and',           // 'and' = size AND dims must pass; 'or' = either passes
  },
  saveUnknownSize: true,   // save when no Content-Length is present
  subfolder: 'netsaver/{date}', // template: {date} {host} {kind}
  useCustomFolder: false,  // true = write into File System Access dir handle
  customFolderName: '',    // display name of picked folder
  extraFolderNames: [],   // display names of extra folders to include in "cache existing files" (handles in IndexedDB)
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
let installType = 'normal';  // 'development' when loaded unpacked (via chrome.management)
let queue = [];
let activeCount = 0;
let sessionSaved = 0;
let sessionBytes = 0;
// v1.6: in-flight claims. MV3 dispatches each onHeadersReceived event as its
// own task, so the synchronous prefix of onHeadersReceived (everything before
// the first await) runs atomically. Claiming the URL + save path there closes
// the race where two events for the same file — an identical URL re-fired, or
// different URLs mapping to one save path (Instagram serves one basename under
// many signed query strings) — both passed the dedup check before either
// download started, and Chrome's `uniquify` then renamed the second copy to
// "photo (1).jpg".
let inflightPaths = new Map(); // relPath -> [{ size }] claimed but not finished
const pendingDownloads = new Map(); // chrome.downloads id -> { url, relPath }

/* ---------- storage ---------- */

async function loadState() {
  const s = await chrome.storage.local.get(['settings', 'savedUrls', 'savedFiles', 'stats', 'tabStates']);
  if (s.settings) settings = {
    ...DEFAULTS, ...s.settings,
    types: { ...DEFAULTS.types, ...((s.settings.types) || {}) },
    imgDims: { ...DEFAULTS.imgDims, ...((s.settings.imgDims) || {}) },
  };
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

  // Detect unpacked (development) installs so the popup can show dev-only
  // cache inspection. Needs the "management" permission.
  try {
    if (chrome.management && chrome.management.getSelf) {
      const self = await chrome.management.getSelf();
      if (self && self.installType) installType = self.installType;
    }
  } catch (e) { /* management unavailable — stay 'normal' */ }

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
      // v1.6: never seed interrupted or in-progress entries — the old code
      // cached partial files as "saved", so they were never retried.
      if (it.state && it.state !== 'complete') continue;
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

// v1.6: size gate as a pure decision — 'pass' | 'fail-size' | 'fail-too-large' | 'fail-unknown'
function sizeGate(sizeBytes) {
  if (sizeBytes !== null) {
    const minBytes = (settings.minSizeKB || 0) * 1024;
    if (sizeBytes < minBytes) return 'fail-size';
    const maxKB = settings.maxSizeKB || 0;
    if (maxKB > 0 && sizeBytes > maxKB * 1024) return 'fail-too-large';
    return 'pass';
  }
  return settings.saveUnknownSize ? 'pass' : 'fail-unknown';
}

function sizeSkipStatus(gate) {
  return gate === 'fail-too-large' ? 'skipped-too-large'
    : gate === 'fail-unknown' ? 'skipped-unknown' : 'skipped-size';
}

// Claim a URL + save path synchronously (atomic — see the note on
// inflightPaths). The path claim is released when the task finishes (runTask
// finally); the URL claim lives on as the permanent dedup record. Use
// releaseAll() to roll both back when a later gate rejects the file.
function claimInFlight(url, relPath, sizeBytes) {
  savedUrls.add(url);
  const entry = { size: sizeBytes ?? null };
  if (!inflightPaths.has(relPath)) inflightPaths.set(relPath, []);
  inflightPaths.get(relPath).push(entry);
  persistSoon();
  let pathReleased = false;
  const releasePath = () => {
    if (pathReleased) return;
    pathReleased = true;
    const arr = inflightPaths.get(relPath);
    if (arr) {
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length) inflightPaths.delete(relPath);
    }
  };
  return {
    releasePath,
    releaseAll() { releasePath(); savedUrls.delete(url); persistSoon(); },
  };
}

function inFlightMatch(relPath, sizeBytes) {
  const arr = inflightPaths.get(relPath);
  return !!arr && arr.some((e) => sizeClose(e.size, sizeBytes));
}

function removeSavedFile(relPath) {
  if (!relPath || !savedFiles.has(relPath)) return;
  savedFiles.delete(relPath);
  const base = basenameOf(relPath).toLowerCase();
  const arr = basenameIndex.get(base);
  if (arr) {
    const i = arr.findIndex((e) => e.relPath === relPath);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) basenameIndex.delete(base);
  }
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

/* ---------- stream-segment detection (v1.5) ---------- */

// DASH/HLS-style players fetch video/audio as many small fMP4 media segments
// (moof+mdat, no init segment). Each one arrives as video/mp4 over XHR and
// would pass the size gate — but a lone segment is unplayable, so saving it
// just fills the folder with "corrupted" files. Detect the common shapes and
// skip them with a clear log entry instead. MPEG-TS (.ts) segments are left
// alone: they are individually playable.
function isMediaSegment(url, contentType) {
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  if (ct === 'video/iso.segment' || ct === 'audio/iso.segment') return true;
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); }
  catch (e) { return false; }
  if (path.endsWith('.m4s')) return true;
  // seg-12 / segment_4 / chunk-3 / frag7 style chunk names — digits required
  // so ordinary words like "segment.mp4" don't match
  return /(^|[\/_.~-])(seg|segment|chunk|frag)[-_]?(\d+)(\.|$)/.test(path);
}

/* ---------- image dimension probing (v1.5) ---------- */

// Reads just the head of an image (first 64KB via a Range request) and parses
// its pixel dimensions. Pure parsers, no dependencies. Supported: JPEG, PNG,
// GIF, WebP (VP8/VP8L/VP8X), BMP. Returns { w, h } or null when the format is
// unsupported or the header is unreadable — unknown dimensions NEVER block a
// save (fail open).
const PROBE_BYTES = 65536;

function parseImageDimensions(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = b.length;
  if (n < 10) return null; // smallest header we parse (GIF)
  const u16be = (o) => (b[o] << 8) | b[o + 1];
  const u16le = (o) => b[o] | (b[o + 1] << 8);
  const u32be = (o) => (b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const u32le = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000);
  const ascii = (o, len) => {
    let s = '';
    for (let i = 0; i < len && o + i < n; i++) s += String.fromCharCode(b[o + i]);
    return s;
  };

  // PNG: 8-byte signature, IHDR chunk (BE32 width/height at 16/20)
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG' && n >= 24 && ascii(12, 4) === 'IHDR') {
    return { w: u32be(16), h: u32be(20) };
  }
  // GIF: "GIF87a"/"GIF89a", LE16 width/height at 6/8
  if (n >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return { w: u16le(6), h: u16le(8) };
  }
  // WebP: "RIFF"...."WEBP", then a VP8 / VP8L / VP8X chunk
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const fourcc = ascii(12, 4);
    if (fourcc === 'VP8 ' && n >= 30) {
      // lossy bitstream: 3-byte frame tag + start code 9D 01 2A at 23,
      // then 14-bit width/height at 26/28
      if (b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
        return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
      }
    } else if (fourcc === 'VP8L' && n >= 25) {
      // lossless: signature 0x2F at 20, then packed (w-1)/(h-1), 14 bits each
      if (b[20] === 0x2f) {
        const packed = u32le(21);
        return { w: (packed & 0x3fff) + 1, h: ((packed >> 14) & 0x3fff) + 1 };
      }
    } else if (fourcc === 'VP8X' && n >= 30) {
      // extended: 24-bit (canvas-1) width at 24, height at 27
      return {
        w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
        h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
      };
    }
    return null;
  }
  // BMP: "BM", DIB header; LE32 width/height at 18/22 (|height|: top-down)
  if (b[0] === 0x42 && b[1] === 0x4d && n >= 26 && u32le(14) >= 40) {
    const w = u32le(18);
    const h = u32le(22);
    const hh = h > 0x7fffffff ? 0x100000000 - h : h; // int32 abs
    return { w, h: hh };
  }
  // JPEG: SOI, then walk markers to a SOF segment (BE16 h/w at +5/+7)
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 <= n) {
      if (b[o] !== 0xff) break;
      const m = b[o + 1];
      if (m === 0xd9) break; // EOI
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { o += 2; continue; } // standalone
      const len = u16be(o + 2);
      if (len < 2 || o + 2 + len > n) break; // truncated header — give up
      const isSOF = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (isSOF) return { h: u16be(o + 5), w: u16be(o + 7) };
      o += 2 + len;
    }
  }
  return null;
}

// One tiny Range request per image; results cached per URL. Any failure
// (no fetch, network error, timeout, unparseable) resolves to null so the
// file is saved anyway.
const dimCache = new Map(); // url -> {w,h} | null
let probeActive = 0;
const probeWaiters = [];
function probeAcquire() {
  if (probeActive < 4) { probeActive++; return Promise.resolve(); }
  return new Promise((res) => probeWaiters.push(res));
}
function probeRelease() {
  probeActive--;
  const w = probeWaiters.shift();
  if (w) { probeActive++; w(); }
}

async function probeImageDimensions(url) {
  if (dimCache.has(url)) return dimCache.get(url);
  if (typeof fetch !== 'function') return null;
  await probeAcquire();
  try {
    const dims = await Promise.race([
      (async () => {
        const res = await fetch(url, {
          headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
          credentials: 'include',
        });
        if (!res.ok || !res.body || typeof res.body.getReader !== 'function') return null;
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
          if (total >= PROBE_BYTES) break;
        }
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        const buf = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { buf.set(c, o); o += c.length; }
        return parseImageDimensions(buf);
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe-timeout')), 8000)),
    ]);
    if (dimCache.size > 2000) dimCache.clear();
    dimCache.set(url, dims || null);
    return dims || null;
  } catch (e) {
    return null;
  } finally {
    probeRelease();
  }
}

function dimsPass(dims, cfg) {
  if (!dims) return true; // unknown dimensions — save the file
  const minW = cfg.minW | 0, minH = cfg.minH | 0, maxW = cfg.maxW | 0, maxH = cfg.maxH | 0;
  if (minW > 0 && dims.w < minW) return false;
  if (minH > 0 && dims.h < minH) return false;
  if (maxW > 0 && dims.w > maxW) return false;
  if (maxH > 0 && dims.h > maxH) return false;
  return true;
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
  try {
    const w = await fh.createWritable();
    await w.write(buf);
    await w.close();
  } catch (e) {
    // v1.6: don't leave a truncated file behind when the write fails.
    try { await dir.removeEntry(finalName); } catch (e2) { /* ignore */ }
    throw e;
  }
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
      const dlId = await downloadsSave(task);
      pendingDownloads.set(dlId, { url: task.url, relPath: savedRelPath });
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
  } finally {
    // The URL stays claimed as the permanent dedup record; only the
    // in-flight path claim is released.
    if (task.claim) task.claim.releasePath();
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

// downloads.download resolves at START, not completion — finalize via onChanged.
// The resolved id is tracked so an interrupted download can be cleaned up.
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const st = delta.state.current;
  if (st !== 'complete' && st !== 'interrupted') return;
  const pend = pendingDownloads.get(delta.id);
  pendingDownloads.delete(delta.id);
  if (st === 'interrupted') {
    (async () => {
      // v1.6: an interrupted download leaves a partial file behind. erase()
      // removes the history entry AND deletes the partial from disk
      // (removeFile only works on completed items). Then roll back the dedup
      // records — the old code kept them, so a re-request believed the
      // partial was a good copy and never retried.
      try {
        await new Promise((resolve, reject) => {
          try {
            chrome.downloads.erase({ id: delta.id }, () => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve();
            });
          } catch (e) { reject(e); }
        });
      } catch (e) { /* partial may already be gone — keep going */ }
      if (pend) {
        removeSavedFile(pend.relPath);
        savedUrls.delete(pend.url);
        persistSoon();
      }
      chrome.downloads.search({ id: delta.id }, (items) => {
        const it = items && items[0];
        addLog({
          url: (it && it.url) || (pend && pend.url) || '',
          kind: '?',
          size: (it && it.fileSize) || null,
          status: 'interrupted',
          error: (it && it.error) || 'interrupted',
          detail: 'partial file removed; a later request will retry it',
        });
      });
    })().catch((e) => console.warn('[nmsaver]', e));
  }
  // On complete the bytes were already counted from headers; nothing to do.
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

  // v1.5: DASH/HLS fMP4 media segments look like ordinary video/mp4 responses
  // in the headers but are unplayable without the init segment — skip them
  // instead of filling the folder with "corrupted" files.
  if ((kind === 'video' || kind === 'audio') && settings.skipSegments && isMediaSegment(url, contentType)) {
    savedUrls.add(url); // don't re-log repeats of the same chunk
    persistSoon();
    await addLog({ url, kind, size: sizeBytes, status: 'skipped-segment' });
    return;
  }

  const relPath = buildRelPath(url, kind, contentType);

  // Duplicate suppression. Everything from here to the claim is synchronous,
  // so the check and the claim are atomic with respect to other
  // onHeadersReceived events (single-threaded event loop) — the fix for the
  // (1)/(2) renamed duplicates.
  if (settings.skipExisting) {
    if (isDuplicate(relPath, sizeBytes)) {
      await addLog({ url, kind, size: sizeBytes, status: 'skipped-duplicate' });
      return;
    }
    if (inFlightMatch(relPath, sizeBytes)) {
      await addLog({ url, kind, size: sizeBytes, status: 'skipped-duplicate', detail: 'already being saved' });
      return;
    }
  }

  const imgCfg = settings.imgDims;
  const dimsOn = kind === 'image' && imgCfg && imgCfg.enabled;
  const logic = imgCfg && imgCfg.logic === 'or' ? 'or' : 'and';
  const gate = sizeGate(sizeBytes);

  if (!dimsOn) {
    // Videos, audio, or the dimension filter switched off: the size gate alone
    // decides, exactly as before.
    if (gate !== 'pass') {
      await addLog({ url, kind, size: sizeBytes, status: sizeSkipStatus(gate) });
      return;
    }
    const claim = claimInFlight(url, relPath, sizeBytes);
    enqueue({ url, kind, contentType, sizeBytes, relPath, claim });
    return;
  }

  if (logic === 'and') {
    // Default: BOTH the file-size gate and the dimension gate must pass.
    if (gate !== 'pass') {
      await addLog({ url, kind, size: sizeBytes, status: sizeSkipStatus(gate) });
      return;
    }
    const claim = claimInFlight(url, relPath, sizeBytes);
    // v1.5: optional image dimension gates — one tiny Range request per image.
    // Unknown dimensions never block the save.
    const dims = await probeImageDimensions(url);
    if (dims && !dimsPass(dims, imgCfg)) {
      claim.releaseAll();
      await addLog({ url, kind, size: sizeBytes, status: 'skipped-dims', detail: `${dims.w}×${dims.h}px` });
      return;
    }
    enqueue({ url, kind, contentType, sizeBytes, relPath, claim });
    return;
  }

  // logic === 'or': save when the size gate OR the dimension gate passes.
  if (gate === 'pass') {
    const claim = claimInFlight(url, relPath, sizeBytes);
    enqueue({ url, kind, contentType, sizeBytes, relPath, claim });
    return;
  }
  const claim = claimInFlight(url, relPath, sizeBytes);
  const dims = await probeImageDimensions(url);
  if (dims && dimsPass(dims, imgCfg)) {
    enqueue({ url, kind, contentType, sizeBytes, relPath, claim });
    return;
  }
  // Neither gate passed. Unknown dimensions can't satisfy the OR side, so they
  // count as a fail here (the size side already failed).
  claim.releaseAll();
  const maxTxt = settings.maxSizeKB > 0 ? `..${settings.maxSizeKB}KB` : '';
  const sizePart = sizeBytes === null ? 'size unknown' : `${Math.round(sizeBytes / 1024)}KB not in ${settings.minSizeKB}KB${maxTxt}`;
  const dimsPart = dims ? `${dims.w}×${dims.h}px out of range` : 'dims unknown';
  await addLog({ url, kind, size: sizeBytes, status: 'skipped-filters', detail: `${sizePart}; ${dimsPart}` });
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
    const out = { settings, sessionSaved, sessionBytes, queueLen: queue.length, activeCount, log: log.slice(0, 20), tabEnabled,
      devMode: installType === 'development',
      cacheStats: { urls: savedUrls.size, files: savedFiles.size } };
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
  } else if (msg.cmd === 'getCachedFiles') {
    // Dev-mode inspection: most recent cached files (cap the payload).
    const entries = [...savedFiles.entries()].slice(-200).reverse()
      .map(([relPath, v]) => ({ relPath, size: v.size ?? null }));
    sendResponse({ ok: true, total: savedFiles.size, files: entries });
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
    getDefaults: () => DEFAULTS,
    getSavedFiles: () => savedFiles,
    getSavedUrls: () => savedUrls,
    getInflightPaths: () => inflightPaths,
    getPendingDownloads: () => pendingDownloads,
    getTabEnabled: () => tabEnabled,
    getQueue: () => queue,
    getInstallType: () => installType,
    effectiveEnabled,
    isDuplicate,
    addSavedFile,
    removeSavedFile,
    claimInFlight,
    inFlightMatch,
    sizeGate,
    sizeSkipStatus,
    classifyKind,
    sizeFromHeaders,
    isMediaSegment,
    parseImageDimensions,
    probeImageDimensions,
    dimsPass,
    buildRelPath,
    basenameOf,
    backfillFromDownloads,
    onHeadersReceived,
    onMessage,
  };
}
