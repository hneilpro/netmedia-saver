/* NetMedia Saver unit tests — runs background.js (the real service worker
 * source) in a vm sandbox with mocked chrome.* APIs. Covers the v1.8
 * behavior (atomic check-and-claim, srcset coalescing, byte-range URL
 * stripping), the v1.6 behavior (interrupted-download cleanup and
 * dedup rollback, AND/OR image filter logic), plus the v1.5 behavior
 * (stream-segment skip, image dimension gates) and the earlier v1.1–v1.4
 * behavior (typed min / optional max gates, origin-tab capture default,
 * basename dedup default, cacheFiles/scanExisting handlers, dev-mode cache
 * inspector).
 * Run: node tests/run-tests.js  (exit 0 = all pass)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- chrome mock ---------- */
const store = {};            // chrome.storage.local backing
const downloadCalls = [];    // chrome.downloads.download invocations
const eraseCalls = [];       // chrome.downloads.erase invocations
let nextDlId = 101;
let downloadSearchResults = [];
const listeners = {};
const mockTabUrls = {}; // tabId -> page URL, backing chrome.tabs.get in tests

function storageGet(keys) {
  const out = {};
  const pick = (k) => { out[k] = store[k]; };
  if (typeof keys === 'string') pick(keys);
  else if (Array.isArray(keys)) keys.forEach(pick);
  else if (keys && typeof keys === 'object') for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
  return Promise.resolve(out);
}

const chrome = {
  storage: {
    local: {
      get: (keys) => storageGet(keys),
      set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
    },
  },
  webRequest: {
    onHeadersReceived: { addListener: (fn) => { listeners.headers = fn; } },
  },
  downloads: {
    onChanged: { addListener: (fn) => { listeners.dlChanged = fn; } },
    search: (q, cb) => cb(downloadSearchResults),
    download: (opts, cb) => { downloadCalls.push(opts); cb(nextDlId++); },
    erase: (q, cb) => { eraseCalls.push(q); cb(); },
    removeFile: (id, cb) => { cb(); },
  },
  tabs: {
    onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } },
    onUpdated: { addListener: (fn) => { listeners.tabUpdated = fn; } },
    query: async () => [],
    get: async (id) => ({ id, url: mockTabUrls[id] || '' }),
  },
  action: {
    setBadgeText: () => {},
    setBadgeBackgroundColor: () => {},
    setTitle: () => {},
  },
  runtime: { onMessage: { addListener: (fn) => { listeners.message = fn; } }, lastError: undefined },
  management: { getSelf: async () => ({ installType: 'development' }) }, // unpacked load
};

/* ---------- load the real SW ---------- */
const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const mod = { exports: {} };
const sandbox = { chrome, module: mod, console, setTimeout, clearTimeout, URL };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'background.js' });
const nms = mod.exports;

/* ---------- tiny test framework ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.error('  FAIL:', name); }
}
function msg(m) {
  return new Promise((resolve) => { nms.onMessage(m, {}, (r) => resolve(r)); });
}
function details({ url, size = null, range = null, tabId = 7, mime = 'image/jpeg', type = 'image' }) {
  const headers = [{ name: 'content-type', value: mime }];
  let statusCode = 200;
  if (range) { statusCode = 206; headers.push({ name: 'content-range', value: range }); }
  else if (size !== null) headers.push({ name: 'content-length', value: String(size) });
  return { method: 'GET', url, tabId, statusCode, type, responseHeaders: headers };
}
const tick = () => new Promise((r) => setTimeout(r, 700)); // outlives the 500ms coalesce debounce + mock download

async function main() {
  await tick(); // let loadState() settle

  // 1. Defaults: basename dedup on, no max gate, off until first explicit enable
  const s0 = nms.getSettings();
  ok(s0.skipExisting === true, 'default skipExisting is on');
  ok(s0.skipScope === 'basename', 'default skipScope is basename (filename in any subfolder)');
  ok(s0.maxSizeKB === 0, 'default maxSizeKB is 0 (no limit)');
  ok(s0.enabledTabId === -1, 'default enabledTabId is -1');
  ok(s0.enabled === false, 'default is off until the first explicit enable');
  ok((await nms.effectiveEnabled(7)) === false, 'fresh install captures nothing until enabled');

  // 2. Legacy upgrade path: enabled=true stored, no origin recorded -> old behavior
  await msg({ cmd: 'setSettings', settings: { enabled: true } }); // no tabId
  ok(nms.getSettings().enabledTabId === -1, 'no origin recorded without a tab id');
  ok((await nms.effectiveEnabled(7)) === true && (await nms.effectiveEnabled(8)) === true,
    'upgraded installs keep capture-everywhere until re-enabled');

  // 3. Origin-tab default: enable on tab 7 -> only tab 7 captures
  await msg({ cmd: 'setSettings', settings: { enabled: true }, tabId: 7 });
  ok(nms.getSettings().enabledTabId === 7, 'enabling records the origin tab');
  ok((await nms.effectiveEnabled(7)) === true, 'origin tab captures');
  ok((await nms.effectiveEnabled(8)) === false, 'other tabs do NOT capture by default');
  ok((await nms.effectiveEnabled(-1)) === true, 'non-tab requests follow the global switch');
  await msg({ cmd: 'setTabEnabled', tabId: 8, enabled: true });
  ok((await nms.effectiveEnabled(8)) === true, 'explicit per-tab opt-in still works');
  await msg({ cmd: 'setSettings', settings: { enabled: false }, tabId: 7 });
  ok((await nms.effectiveEnabled(7)) === false && (await nms.effectiveEnabled(8)) === false, 'global off overrides every tab');
  await msg({ cmd: 'setSettings', settings: { enabled: true }, tabId: 9 });
  ok(nms.getSettings().enabledTabId === 9, 're-enabling moves the origin tab');
  ok((await nms.effectiveEnabled(9)) === true && (await nms.effectiveEnabled(7)) === false, 'new origin captures, old one does not');

  // 4. getState serves the popup without throwing and reports the effective tab state
  const gs = await msg({ cmd: 'getState', tabId: 9 });
  ok(gs && gs.tabId === 9 && gs.tabEnabled === true, 'getState returns the requesting tab\'s effective state');
  const gs2 = await msg({ cmd: 'getState', tabId: 42 });
  ok(gs2 && gs2.tabEnabled === false, 'getState reports non-origin tabs as disabled');

  // 5. Dev mode: unpacked install detected; cache stats served
  ok(nms.getInstallType() === 'development', 'installType detected as development (unpacked)');
  ok(gs.devMode === true, 'getState flags devMode for unpacked installs');
  ok(gs.cacheStats && typeof gs.cacheStats.files === 'number' && typeof gs.cacheStats.urls === 'number',
    'getState includes cache stats');

  // 6. getCachedFiles: most-recent-first listing of the dedup cache
  nms.addSavedFile('netsaver/2026-10-01/x.com/a.jpg', 'https://x.com/a.jpg', 100);
  nms.addSavedFile('netsaver/2026-10-01/x.com/b.jpg', 'https://x.com/b.jpg', 200);
  const cf = await msg({ cmd: 'getCachedFiles' });
  ok(cf && cf.total === nms.getSavedFiles().size, 'getCachedFiles total matches the cache size');
  ok(cf.files[0].relPath === 'netsaver/2026-10-01/x.com/b.jpg', 'getCachedFiles lists most recent first');
  ok(cf.files.every((f) => typeof f.relPath === 'string'), 'getCachedFiles entries carry relPath');
  ok(cf.files.length <= 200, 'getCachedFiles caps the payload');

  // 7. Extra folders: namespaced cacheFiles entries dedup against save-folder files
  nms.addSavedFile('netsaver/2026-10-01/x.com/photo.jpg', 'https://x.com/photo.jpg', 100000);
  const cf2 = await msg({ cmd: 'cacheFiles', files: [['extra/Photos/photo.jpg', 100500]] });
  ok(cf2 && cf2.added === 1, 'cacheFiles accepts namespaced extra-folder entries');
  ok(nms.isDuplicate('netsaver/2026-10-01/x.com/photo.jpg', 100500) === true,
    'basename dedup matches a file known from an extra folder');
  ok(nms.isDuplicate('extra/Photos/photo.jpg', 100000) === true,
    'basename dedup works in both directions across namespaces');
  ok(Array.isArray(nms.getSettings().extraFolderNames),
    'settings carry extraFolderNames (default empty)');

  // 8. Capture scope: website whitelist / blacklist
  ok(nms.normalizeSitePattern('HTTPS://Mail.Example.com:8080/a/b') === 'mail.example.com',
    'site patterns normalize (scheme/port/path stripped, lowercased)');
  ok(nms.normalizeSitePattern('*.example.com') === 'example.com', 'leading *. stripped');
  ok(nms.normalizeSitePattern('  example.com. ') === 'example.com', 'whitespace + trailing dot stripped');
  ok(nms.normalizeSitePattern('localhost') === 'localhost', 'single-label hosts allowed');
  ok(nms.normalizeSitePattern('???') === '', 'garbage rejected');
  ok(nms.normalizeSitePattern('not a site') === '', 'spaces rejected');
  ok(nms.hostMatches('example.com', 'example.com') === true, 'exact host matches');
  ok(nms.hostMatches('a.example.com', 'example.com') === true, 'subdomain matches');
  ok(nms.hostMatches('notexample.com', 'example.com') === false, 'suffix trick does not match');
  ok(nms.hostMatches('', 'example.com') === false, 'empty host never matches');

  mockTabUrls[21] = 'https://x.com/home';
  mockTabUrls[22] = 'https://sub.x.com/';
  mockTabUrls[23] = 'https://other.org/';
  mockTabUrls[24] = 'chrome://newtab/';
  ok((nms.getSettings().captureScope || 'tab') === 'tab', 'default capture scope is this-tab');

  await msg({ cmd: 'setSettings', settings: { enabled: true, captureScope: 'whitelist', siteWhitelist: ['x.com'] }, tabId: 21 });
  ok((await nms.effectiveEnabled(21)) === true, 'whitelist: listed site captures');
  ok((await nms.effectiveEnabled(22)) === true, 'whitelist: subdomain captures');
  ok((await nms.effectiveEnabled(23)) === false, 'whitelist: unlisted site does not capture');
  ok((await nms.effectiveEnabled(24)) === false, 'whitelist: hostless tab does not capture');

  await msg({ cmd: 'setSettings', settings: { captureScope: 'blacklist', siteBlacklist: ['x.com'] } });
  ok((await nms.effectiveEnabled(21)) === false, 'blacklist: listed site does not capture');
  ok((await nms.effectiveEnabled(22)) === false, 'blacklist: subdomain of listed site does not capture');
  ok((await nms.effectiveEnabled(23)) === true, 'blacklist: other sites capture');
  ok((await nms.effectiveEnabled(24)) === true, 'blacklist: hostless tab captures');

  // tabs.onUpdated keeps the host map fresh (no tabs.get fallback needed)
  listeners.tabUpdated(25, {}, { id: 25, url: 'https://deep.sub.x.com/page' });
  ok((await nms.effectiveEnabled(25)) === false, 'blacklist: host tracked via onUpdated is honored');

  // Explicit per-tab choice wins over the lists
  await msg({ cmd: 'setTabEnabled', tabId: 23, enabled: false });
  ok((await nms.effectiveEnabled(23)) === false, 'explicit per-tab off wins over blacklist');
  await msg({ cmd: 'setTabEnabled', tabId: 21, enabled: true });
  ok((await nms.effectiveEnabled(21)) === true, 'explicit per-tab on wins over blacklist');

  // addSite / removeSite
  const a1 = await msg({ cmd: 'addSite', list: 'siteWhitelist', site: 'HTTPS://Instagram.com/' });
  ok(a1.ok === true && a1.site === 'instagram.com', 'addSite normalizes and adds');
  ok(nms.getSettings().siteWhitelist.includes('instagram.com'), 'addSite persists to settings');
  const a2 = await msg({ cmd: 'addSite', list: 'siteWhitelist', site: 'instagram.com' });
  ok(a2.ok === false, 'addSite refuses duplicates');
  const a3 = await msg({ cmd: 'addSite', list: 'siteBlacklist', site: '???' });
  ok(a3.ok === false, 'addSite refuses garbage');
  const a4 = await msg({ cmd: 'removeSite', list: 'siteWhitelist', site: 'instagram.com' });
  ok(a4.ok === true && !nms.getSettings().siteWhitelist.includes('instagram.com'), 'removeSite removes');
  const a5 = await msg({ cmd: 'removeSite', list: 'siteWhitelist', site: 'instagram.com' });
  ok(a5.ok === false, 'removeSite reports missing entries');

  // Back to this-tab scope: previous behavior intact. Restore the fixture
  // state the observer tests below expect (origin tab 9, enabled).
  await msg({ cmd: 'setSettings', settings: { enabled: true, captureScope: 'tab' }, tabId: 9 });
  ok((await nms.effectiveEnabled(9)) === true, 'tab scope restored: origin tab captures');
  ok((await nms.effectiveEnabled(21)) === true, 'per-tab override still applies after switching back');

  // 3. Min gate (typed value): 150KB skipped, 250KB saved
  downloadCalls.length = 0;
  await msg({ cmd: 'setSettings', settings: { minSizeKB: 200, maxSizeKB: 0 } });
  await nms.onHeadersReceived(details({ url: 'https://img.test/small.jpg', size: 150 * 1024, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === 0, '150KB file below 200KB min is skipped');
  ok((store.log || []).some((e) => e.status === 'skipped-size'), 'skip logged as skipped-size');
  await nms.onHeadersReceived(details({ url: 'https://img.test/big.jpg', size: 250 * 1024, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === 1, '250KB file above min is downloaded');

  // 4. Max gate (optional): 2MB skipped when max=1MB; unset max = no upper bound
  await msg({ cmd: 'setSettings', settings: { maxSizeKB: 1024 } });
  const before = downloadCalls.length;
  await nms.onHeadersReceived(details({ url: 'https://img.test/huge.jpg', size: 2 * 1024 * 1024, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === before, '2MB file above 1MB max is skipped');
  ok((store.log || []).some((e) => e.status === 'skipped-too-large'), 'skip logged as skipped-too-large');
  await nms.onHeadersReceived(details({ url: 'https://img.test/mid.jpg', size: 500 * 1024, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === before + 1, '500KB file within min..max is downloaded');
  await msg({ cmd: 'setSettings', settings: { maxSizeKB: 0 } });
  await nms.onHeadersReceived(details({ url: 'https://img.test/huge2.jpg', size: 20 * 1024 * 1024, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === before + 2, 'empty max means no upper limit');

  // 5. Unknown size + max set: still saved (max only applies to known sizes)
  await msg({ cmd: 'setSettings', settings: { maxSizeKB: 1024, saveUnknownSize: true } });
  const b2 = downloadCalls.length;
  await nms.onHeadersReceived(details({ url: 'https://img.test/unknown.jpg', size: null, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === b2 + 1, 'unknown-size file still saved when max is set');

  // 6. 206 partial content: gate sees the Content-Range total
  ok(nms.sizeFromHeaders(details({ url: 'https://v.test/x.mp4', range: 'bytes 0-99/5000' })) === 5000,
    '206 responses use the Content-Range total for the size gate');

  // 7. Basename dedup: same filename in a different subfolder is a duplicate
  nms.addSavedFile('netsaver/2026-10-01/x.com/photo.jpg', 'https://x.com/photo.jpg', 1000);
  ok(nms.isDuplicate('netsaver/2026-10-02/y.com/photo.jpg', 1005) === true, 'same basename + size within 1% in another subfolder is a duplicate');
  ok(nms.isDuplicate('netsaver/2026-10-02/y.com/other.jpg', 1000) === false, 'different basename is not a duplicate');
  const b3 = downloadCalls.length;
  nms.addSavedFile('netsaver/2026-10-01/x.com/bigphoto.jpg', 'https://x.com/bigphoto.jpg', 300 * 1024);
  await nms.onHeadersReceived(details({ url: 'https://y.com/bigphoto.jpg', size: 300 * 1024, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === b3, 're-requested file with known basename is skipped-duplicate');
  ok((store.log || []).some((e) => e.status === 'skipped-duplicate'), 'duplicate skip logged');

  // 8. cacheFiles: chunked upload from the folder walk
  const r1 = await msg({ cmd: 'cacheFiles', files: [['a/b.jpg', 123], ['c.jpg', null]] });
  ok(r1.added === 2, 'cacheFiles adds new entries');
  ok(nms.getSavedFiles().has('a/b.jpg'), 'cached entry retrievable by rel path');
  const r2 = await msg({ cmd: 'cacheFiles', files: [['a/b.jpg', 123]] });
  ok(r2.added === 0, 'cacheFiles ignores already-known files');
  ok(nms.isDuplicate('z/a/b.jpg', 123) === true, 'cached basename dedups across subfolders');

  // 9. scanExisting: on-demand download-history scan
  downloadSearchResults = [
    { filename: 'C:\\Users\\h\\Downloads\\netsaver\\2026-09-30\\x.com\\old.jpg', url: 'https://x.com/old.jpg', fileSize: 777 },
    { filename: '/home/h/Downloads/unrelated.jpg', url: 'https://x.com/u.jpg', fileSize: 1 },
  ];
  const r3 = await msg({ cmd: 'scanExisting' });
  ok(r3.added === 1, 'scanExisting picks up the netsaver/ history entry only');
  ok(nms.getSavedFiles().has('netsaver/2026-09-30/x.com/old.jpg'), 'scanned entry stored by rel path');

  // 10. v1.5 defaults: 75KB min, segment skip on, 600x600 image dims on
  const d15 = nms.getDefaults();
  ok(d15.minSizeKB === 75, 'default minSizeKB is 75KB');
  ok(d15.skipSegments === true, 'segment skipping is on by default');
  ok(d15.imgDims && d15.imgDims.enabled === true && d15.imgDims.minW === 600 && d15.imgDims.minH === 600,
    'image dimension filter defaults to on, min 600x600');
  ok(d15.imgDims.maxW === 0 && d15.imgDims.maxH === 0, 'image dimension maximums default to off (no limit)');

  // 11. isMediaSegment unit tests
  const seg = nms.isMediaSegment;
  ok(seg('https://cdn.test/v/seg-12.m4s', 'video/mp4') === true, '.m4s URL is a segment');
  ok(seg('https://cdn.test/v/seg-12.mp4', 'video/mp4') === true, 'seg-N.mp4 chunk name is a segment');
  ok(seg('https://cdn.test/dash/chunk_ctvideo_cfm4s_seg-1.m4s', 'video/mp4') === true, 'dash chunk name is a segment');
  ok(seg('https://cdn.test/v/frag7.mp4', 'video/mp4') === true, 'fragN name is a segment');
  ok(seg('https://cdn.test/v/stream', 'video/iso.segment') === true, 'video/iso.segment content type is a segment');
  ok(seg('https://cdn.test/a/seg-3.m4s', 'audio/mp4') === true, 'audio .m4s is a segment');
  ok(seg('https://cdn.test/v/movie.mp4', 'video/mp4') === false, 'ordinary mp4 is not a segment');
  ok(seg('https://cdn.test/v/segment.mp4', 'video/mp4') === false, '"segment" without digits is not a segment');
  ok(seg('https://cdn.test/v/clip.ts', 'video/mp2t') === false, '.ts segments are kept (playable alone)');
  ok(seg('https://cdn.test/v/trailer.mp4', 'video/mp4') === false, 'plain name is not a segment');
  ok(seg('not a url', 'video/mp4') === false, 'unparseable URL is not a segment');

  // 12. parseImageDimensions unit tests (crafted headers)
  const parse = nms.parseImageDimensions;
  const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const le16 = (v) => [v & 255, (v >>> 8) & 255];
  const le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const U8 = (arr) => new Uint8Array(arr);
  let dd = parse(U8([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13,
    0x49, 0x48, 0x44, 0x52, ...be32(800), ...be32(600), 8, 2, 0, 0, 0]));
  ok(dd && dd.w === 800 && dd.h === 600, 'PNG dimensions parsed (big-endian)');
  dd = parse(U8([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(320), ...le16(200), 0, 0, 0]));
  ok(dd && dd.w === 320 && dd.h === 200, 'GIF dimensions parsed (little-endian)');
  const app0 = [0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x01, 0xE0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00];
  dd = parse(U8([0xFF, 0xD8, ...app0, ...sof0, 0xFF, 0xD9]));
  ok(dd && dd.w === 640 && dd.h === 480, 'JPEG SOF0 dimensions parsed after APP0');
  dd = parse(U8([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x40, 0x08, 0x01, 0xE0, 0x02, 0x80]));
  ok(dd === null, 'truncated JPEG header yields null (fail open)');
  const w1 = 1919, h1 = 1079; // VP8X stores canvas-1
  dd = parse(U8([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0x00, 0, 0, 0,
    w1 & 255, (w1 >> 8) & 255, (w1 >> 16) & 255, h1 & 255, (h1 >> 8) & 255, (h1 >> 16) & 255]));
  ok(dd && dd.w === 1920 && dd.h === 1080, 'WebP VP8X canvas size parsed');
  const packed = 99 | (99 << 14); // VP8L stores (w-1)/(h-1) packed, 14 bits each
  dd = parse(U8([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x4C, 5, 0, 0, 0, 0x2F, ...le32(packed)]));
  ok(dd && dd.w === 100 && dd.h === 100, 'WebP VP8L packed dimensions parsed');
  dd = parse(U8([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20, 10, 0, 0, 0, 0, 0, 0, 0x9D, 0x01, 0x2A, ...le16(800), ...le16(600)]));
  ok(dd && dd.w === 800 && dd.h === 600, 'WebP VP8 lossy dimensions parsed');
  dd = parse(U8([0x42, 0x4D, 0, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, ...le32(800), ...le32(600), 0, 0]));
  ok(dd && dd.w === 800 && dd.h === 600, 'BMP dimensions parsed');
  ok(parse(U8([1, 2, 3])) === null, 'tiny input yields null');
  ok(parse(U8([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])) === null, 'unknown format yields null');

  // dimsPass gate logic
  ok(nms.dimsPass(null, { minW: 600, minH: 600 }) === true, 'unknown dims pass (fail open)');
  ok(nms.dimsPass({ w: 800, h: 600 }, { minW: 600, minH: 600, maxW: 0, maxH: 0 }) === true, 'dims within min pass');
  ok(nms.dimsPass({ w: 400, h: 600 }, { minW: 600, minH: 600, maxW: 0, maxH: 0 }) === false, 'narrow image fails minW');
  ok(nms.dimsPass({ w: 800, h: 400 }, { minW: 600, minH: 600, maxW: 0, maxH: 0 }) === false, 'short image fails minH');
  ok(nms.dimsPass({ w: 5000, h: 4000 }, { minW: 0, minH: 0, maxW: 4096, maxH: 4096 }) === false, 'huge image fails max gates');
  ok(nms.dimsPass({ w: 5000, h: 4000 }, { minW: 0, minH: 0, maxW: 0, maxH: 0 }) === true, 'zero gates pass everything');

  // 13. segment skip end-to-end
  await msg({ cmd: 'setSettings', settings: { enabled: true, minSizeKB: 0, maxSizeKB: 0, skipSegments: true }, tabId: 9 });
  const sb = downloadCalls.length;
  await nms.onHeadersReceived(details({ url: 'https://cdn.test/v/seg-12.m4s', size: 777128, tabId: 9, mime: 'video/mp4', type: 'xmlhttprequest' }));
  await tick();
  ok(downloadCalls.length === sb, 'fMP4 segment is not downloaded');
  ok((store.log || []).some((e) => e.status === 'skipped-segment'), 'segment skip logged as skipped-segment');
  await nms.onHeadersReceived(details({ url: 'https://cdn.test/v/movie.mp4', size: 5 * 1024 * 1024, tabId: 9, mime: 'video/mp4', type: 'media' }));
  await tick();
  ok(downloadCalls.length === sb + 1, 'ordinary mp4 still downloads when segment skip is on');
  await msg({ cmd: 'setSettings', settings: { skipSegments: false } });
  const sb2 = downloadCalls.length;
  await nms.onHeadersReceived(details({ url: 'https://cdn.test/v/seg-13.m4s', size: 700000, tabId: 9, mime: 'video/mp4', type: 'xmlhttprequest' }));
  await tick();
  ok(downloadCalls.length === sb2 + 1, 'segment downloads when skipSegments is off');

  // 14. image dimension gate end-to-end (mocked Range fetch)
  function rangeFetch(bytes, status = 206) {
    return async () => {
      let pos = 0;
      return {
        ok: status >= 200 && status < 300, status,
        body: {
          getReader: () => ({
            read: async () => {
              if (pos >= bytes.length) return { done: true, value: undefined };
              const end = Math.min(pos + 8192, bytes.length);
              const slice = bytes.slice(pos, end); pos = end;
              return { done: false, value: slice };
            },
            cancel: async () => {},
          }),
        },
      };
    };
  }
  const png800 = U8([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13,
    0x49, 0x48, 0x44, 0x52, ...be32(800), ...be32(600), 8, 2, 0, 0, 0]);
  const png100 = U8([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13,
    0x49, 0x48, 0x44, 0x52, ...be32(100), ...be32(100), 8, 2, 0, 0, 0]);
  await msg({ cmd: 'setSettings', settings: { minSizeKB: 0, maxSizeKB: 0, imgDims: { enabled: true, minW: 600, minH: 600, maxW: 0, maxH: 0 } } });
  sandbox.fetch = rangeFetch(png100);
  const db = downloadCalls.length;
  await nms.onHeadersReceived(details({ url: 'https://img.test/tiny-dim.png', size: 90000, tabId: 9, mime: 'image/png', type: 'image' }));
  await tick();
  ok(downloadCalls.length === db, '100x100 image is skipped by the dimension gate');
  ok((store.log || []).some((e) => e.status === 'skipped-dims' && e.detail === '100×100px'),
    'dimension skip logged with the detected size');
  sandbox.fetch = rangeFetch(png800);
  await nms.onHeadersReceived(details({ url: 'https://img.test/big-dim.png', size: 90000, tabId: 9, mime: 'image/png', type: 'image' }));
  await tick();
  ok(downloadCalls.length === db + 1, '800x600 image passes the dimension gate');
  sandbox.fetch = async () => { throw new Error('net down'); };
  await nms.onHeadersReceived(details({ url: 'https://img.test/unknown-dim.png', size: 90000, tabId: 9, mime: 'image/png', type: 'image' }));
  await tick();
  ok(downloadCalls.length === db + 2, 'image with a failed probe still downloads (fail open)');
  sandbox.fetch = undefined;

  // 15. v1.6: atomic in-flight dedup — same URL fired twice concurrently downloads once
  await msg({ cmd: 'setSettings', settings: { enabled: true, minSizeKB: 0, maxSizeKB: 0, imgDims: { enabled: false } }, tabId: 9 });
  downloadCalls.length = 0;
  const race1 = nms.onHeadersReceived(details({ url: 'https://img.test/race.jpg', size: 90000, tabId: 9 }));
  const race2 = nms.onHeadersReceived(details({ url: 'https://img.test/race.jpg', size: 90000, tabId: 9 }));
  await Promise.all([race1, race2]);
  await tick();
  ok(downloadCalls.length === 1, 'same URL fired twice concurrently downloads exactly once');
  ok(nms.getInflightPaths().size === 0, 'in-flight claim released after the task finishes');

  // 16. v1.6: same basename under different signed URLs, same size, concurrent -> one download
  downloadCalls.length = 0;
  const dup1 = nms.onHeadersReceived(details({ url: 'https://a.test/iflight.jpg?stp=aaa', size: 90000, tabId: 9 }));
  const dup2 = nms.onHeadersReceived(details({ url: 'https://b.test/iflight.jpg?stp=bbb', size: 90000, tabId: 9 }));
  await Promise.all([dup1, dup2]);
  await tick();
  ok(downloadCalls.length === 1, 'same basename + same size from different URLs downloads once (no (1) rename)');
  ok((store.log || []).some((e) => e.status === 'skipped-duplicate' && /kept the larger file/.test(e.detail || '')),
    'srcset-coalesced duplicate logged as skipped-duplicate');

  // 17. v1.8: same basename with genuinely different sizes, fired together ->
  // the coalescer keeps only the largest (see tests 27-30 for both orders,
  // the within-window repeat, and the post-window behavior).
  downloadCalls.length = 0;
  const sz1 = nms.onHeadersReceived(details({ url: 'https://a.test/sizediff.jpg?v=large', size: 500000, tabId: 9 }));
  const sz2 = nms.onHeadersReceived(details({ url: 'https://b.test/sizediff.jpg?v=small', size: 90000, tabId: 9 }));
  await Promise.all([sz1, sz2]);
  await tick();
  ok(downloadCalls.length === 1, 'same basename with different sizes inside the window saves only the largest');
  ok(downloadCalls[0].url === 'https://a.test/sizediff.jpg?v=large', 'the larger variant is the one saved');

  // 18. v1.6: sizeGate unit tests
  const sg = nms.sizeGate;
  await msg({ cmd: 'setSettings', settings: { minSizeKB: 75, maxSizeKB: 1024, saveUnknownSize: true } });
  ok(sg(100 * 1024) === 'pass', 'sizeGate passes within range');
  ok(sg(10 * 1024) === 'fail-size', 'sizeGate fails below min');
  ok(sg(2 * 1024 * 1024) === 'fail-too-large', 'sizeGate fails above max');
  ok(sg(null) === 'pass', 'sizeGate passes unknown size when saveUnknownSize is on');
  await msg({ cmd: 'setSettings', settings: { saveUnknownSize: false } });
  ok(sg(null) === 'fail-unknown', 'sizeGate fails unknown size when saveUnknownSize is off');
  ok(nms.sizeSkipStatus('fail-size') === 'skipped-size', 'sizeSkipStatus maps fail-size');
  ok(nms.sizeSkipStatus('fail-too-large') === 'skipped-too-large', 'sizeSkipStatus maps fail-too-large');
  ok(nms.sizeSkipStatus('fail-unknown') === 'skipped-unknown', 'sizeSkipStatus maps fail-unknown');

  // 19. v1.6: AND/OR filter logic end-to-end
  await msg({ cmd: 'setSettings', settings: {
    enabled: true, minSizeKB: 200, maxSizeKB: 0, saveUnknownSize: false,
    imgDims: { enabled: true, minW: 600, minH: 600, maxW: 0, maxH: 0, logic: 'or' },
  }, tabId: 9 });
  sandbox.fetch = rangeFetch(png800); // 800x600
  const orBase = downloadCalls.length;
  await nms.onHeadersReceived(details({ url: 'https://img.test/or-big-dims.png', size: 100 * 1024, tabId: 9, mime: 'image/png', type: 'image' }));
  await tick();
  ok(downloadCalls.length === orBase + 1, 'OR: small file with big dimensions is saved');
  await nms.onHeadersReceived(details({ url: 'https://img.test/or-big-size.png', size: 300 * 1024, tabId: 9, mime: 'image/png', type: 'image' }));
  await tick();
  ok(downloadCalls.length === orBase + 2, 'OR: file passing the size gate is saved');
  sandbox.fetch = rangeFetch(png100); // 100x100
  await nms.onHeadersReceived(details({ url: 'https://img.test/or-neither.png', size: 100 * 1024, tabId: 9, mime: 'image/png', type: 'image' }));
  await tick();
  ok(downloadCalls.length === orBase + 2, 'OR: file failing both gates is not saved');
  ok((store.log || []).some((e) => e.status === 'skipped-filters'), 'OR double-failure logged as skipped-filters');
  sandbox.fetch = rangeFetch(png800);
  await nms.onHeadersReceived(details({ url: 'https://img.test/or-unknown-size.png', size: null, tabId: 9, mime: 'image/png', type: 'image' }));
  await tick();
  ok(downloadCalls.length === orBase + 3, 'OR: unknown size is rescued by passing dimensions');
  await msg({ cmd: 'setSettings', settings: { imgDims: { enabled: true, minW: 600, minH: 600, maxW: 0, maxH: 0, logic: 'and' } } });
  const andBase = downloadCalls.length;
  await nms.onHeadersReceived(details({ url: 'https://img.test/and-unknown-size.png', size: null, tabId: 9, mime: 'image/png', type: 'image' }));
  await tick();
  ok(downloadCalls.length === andBase, 'AND: unknown size still skipped when saveUnknownSize is off');
  ok((store.log || []).some((e) => e.status === 'skipped-unknown'), 'AND unknown-size skip logged');
  ok(nms.getDefaults().imgDims.logic === 'and', 'default filter logic is AND (existing behavior unchanged)');
  sandbox.fetch = undefined;

  // 20. v1.6: interrupted download -> partial erased, dedup rolled back, retry allowed
  await msg({ cmd: 'setSettings', settings: { enabled: true, minSizeKB: 0, maxSizeKB: 0, imgDims: { enabled: false } }, tabId: 9 });
  downloadSearchResults = [];
  downloadCalls.length = 0; eraseCalls.length = 0;
  await nms.onHeadersReceived(details({ url: 'https://img.test/doomed.jpg', size: 90000, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === 1, 'doomed download starts');
  const doomedId = nextDlId - 1;
  ok(nms.getSavedUrls().has('https://img.test/doomed.jpg'), 'URL claimed while downloading');
  listeners.dlChanged({ id: doomedId, state: { current: 'interrupted' } });
  await tick(); await tick(); await tick();
  ok(eraseCalls.length === 1 && eraseCalls[0].id === doomedId, 'interrupted download is erased (partial removed from disk)');
  ok(!nms.getSavedUrls().has('https://img.test/doomed.jpg'), 'interrupted URL released so a later request retries');
  ok(![...nms.getSavedFiles().keys()].some((k) => k.endsWith('/doomed.jpg')), 'interrupted file removed from the dedup cache');
  ok((store.log || []).some((e) => e.status === 'interrupted'), 'interruption logged');
  downloadCalls.length = 0;
  await nms.onHeadersReceived(details({ url: 'https://img.test/doomed.jpg', size: 90000, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === 1, 're-request after interruption downloads again');
  const retryId = nextDlId - 1;
  ok(nms.getPendingDownloads().has(retryId), 'retry download tracked while in flight');
  listeners.dlChanged({ id: retryId, state: { current: 'complete' } });
  await tick();
  ok(!nms.getPendingDownloads().has(retryId), 'completed download removed from the pending map');

  // 21. v1.6: backfill skips interrupted entries; removeSavedFile unit
  downloadSearchResults = [
    { filename: 'C:\\D\\netsaver\\2026-10-01\\x.com\\ok.jpg', url: 'https://x.com/ok.jpg', fileSize: 5, state: 'complete' },
    { filename: 'C:\\D\\netsaver\\2026-10-01\\x.com\\part.jpg', url: 'https://x.com/part.jpg', fileSize: 5, state: 'interrupted' },
    { filename: 'C:\\D\\netsaver\\2026-10-01\\x.com\\busy.jpg', url: 'https://x.com/busy.jpg', fileSize: 5, state: 'in_progress' },
  ];
  const r4 = await msg({ cmd: 'scanExisting' });
  ok(r4.added === 1, 'scanExisting seeds only the completed entry');
  ok(nms.getSavedFiles().has('netsaver/2026-10-01/x.com/ok.jpg'), 'completed entry cached');
  ok(!nms.getSavedFiles().has('netsaver/2026-10-01/x.com/part.jpg'), 'interrupted entry NOT cached as saved');
  nms.addSavedFile('netsaver/2026-10-01/x.com/gone.jpg', 'https://x.com/gone.jpg', 5000);
  ok(nms.isDuplicate('netsaver/2026-10-02/y.com/gone.jpg', 5000) === true, 'cached file dedups before removal');
  nms.removeSavedFile('netsaver/2026-10-01/x.com/gone.jpg');
  ok(nms.isDuplicate('netsaver/2026-10-02/y.com/gone.jpg', 5000) === false, 'removeSavedFile drops the dedup entry');

  // 22. v1.8: the dedup claim is synchronous — registered before the first await,
  // so two near-simultaneous events for the same URL cannot both pass the check.
  await msg({ cmd: 'setSettings', settings: { enabled: true, minSizeKB: 0, maxSizeKB: 0, imgDims: { enabled: false } }, tabId: 9 });
  downloadCalls.length = 0;
  const url22 = 'https://img.test/sync-claim.jpg';
  const p22 = nms.onHeadersReceived(details({ url: url22, size: 90000, tabId: 9 }));
  ok(nms.getSavedUrls().has(url22) === true,
    'URL is claimed synchronously, before the first await (atomic check-and-claim)');
  await p22; await tick();
  ok(downloadCalls.length === 1, 'synchronously-claimed file still downloads exactly once');

  // 23. v1.8: the claim is rolled back when a later gate rejects the file (disabled tab)
  await msg({ cmd: 'setTabEnabled', tabId: 9, enabled: false });
  const url23 = 'https://img.test/disabled-rollback.jpg';
  await nms.onHeadersReceived(details({ url: url23, size: 90000, tabId: 9 }));
  await tick();
  ok(nms.getSavedUrls().has(url23) === false, 'claim rolled back when the tab gate rejects the file');
  ok(downloadCalls.length === 1, 'disabled tab downloads nothing');
  await msg({ cmd: 'setTabEnabled', tabId: 9, enabled: true });

  // 24. v1.8: stripRangeParams unit tests
  const srp = nms.stripRangeParams;
  ok(srp('https://cdn.test/v.mp4?bytestart=0&byteend=1023&_nc=abc') === 'https://cdn.test/v.mp4?_nc=abc',
    'bytestart/byteend stripped, other params kept');
  ok(srp('https://cdn.test/v.mp4?range=0-99') === 'https://cdn.test/v.mp4',
    'range= param stripped');
  ok(srp('https://cdn.test/v.mp4?a=1&b=2') === 'https://cdn.test/v.mp4?a=1&b=2',
    'URL without range params returned unchanged');
  ok(srp('not a url') === 'not a url', 'unparseable URL passes through');

  // 25. v1.8: a 206 video URL with byte-range params downloads the FULL file
  downloadCalls.length = 0;
  await nms.onHeadersReceived({
    method: 'GET',
    url: 'https://v.test/clip.mp4?bytestart=1048576&byteend=2097151&oh=abc',
    tabId: 9, statusCode: 206, type: 'xmlhttprequest',
    responseHeaders: [
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-range', value: 'bytes 1048576-2097151/5242880' },
    ],
  });
  await tick();
  ok(downloadCalls.length === 1, 'byte-range video URL still downloads');
  ok(downloadCalls[0].url === 'https://v.test/clip.mp4?oh=abc',
    'download URL has bytestart/byteend stripped');
  ok(!/[?&](bytestart|byteend|range)=/.test(downloadCalls[0].url),
    'no range params leak into the download URL');

  // 26. v1.8: betterCandidate unit tests
  const bc = nms.betterCandidate;
  ok(bc({ sizeBytes: 500, dims: null }, { sizeBytes: 100, dims: null }) > 0, 'larger size wins');
  ok(bc({ sizeBytes: 100, dims: null }, { sizeBytes: 500, dims: null }) < 0, 'smaller size loses');
  ok(bc({ sizeBytes: null, dims: null }, { sizeBytes: 100, dims: null }) < 0, 'unknown size loses to known size');
  ok(bc({ sizeBytes: 100, dims: { w: 100, h: 100 } }, { sizeBytes: 100, dims: { w: 200, h: 200 } }) < 0,
    'equal size: larger probed dims win the tie-break');
  ok(bc({ sizeBytes: 100, dims: null }, { sizeBytes: 100, dims: null }) === 0, 'exact tie keeps the first');

  // 27. v1.8: srcset coalescing, large-first order — the smaller latecomer is skipped
  downloadCalls.length = 0;
  const l1 = nms.onHeadersReceived(details({ url: 'https://a.test/burst1.jpg?v=large', size: 500000, tabId: 9 }));
  const l2 = nms.onHeadersReceived(details({ url: 'https://b.test/burst1.jpg?v=small', size: 90000, tabId: 9 }));
  await Promise.all([l1, l2]);
  await tick();
  ok(downloadCalls.length === 1, 'srcset burst (large first) downloads exactly once');
  ok(downloadCalls[0].url === 'https://a.test/burst1.jpg?v=large', 'the larger variant is the one saved');
  ok((store.log || []).some((e) => e.status === 'skipped-duplicate' && e.url === 'https://b.test/burst1.jpg?v=small'),
    'smaller variant logged as skipped-duplicate');

  // 28. v1.8: srcset coalescing, small-first order — the larger latecomer
  // replaces the held smaller candidate (the 500ms debounce hold means the
  // small one never starts before the large one arrives, even with a free
  // worker; maxConcurrent=1 also keeps the queue path exercised).
  await msg({ cmd: 'setSettings', settings: { maxConcurrent: 1 } });
  downloadCalls.length = 0;
  const bA = nms.onHeadersReceived(details({ url: 'https://a.test/blocker.jpg', size: 90000, tabId: 9 }));
  const bS = nms.onHeadersReceived(details({ url: 'https://a.test/burst2.jpg?v=small', size: 90000, tabId: 9 }));
  const bL = nms.onHeadersReceived(details({ url: 'https://b.test/burst2.jpg?v=large', size: 500000, tabId: 9 }));
  await Promise.all([bA, bS, bL]);
  await tick();
  ok(downloadCalls.length === 2, 'blocker + one burst2 variant downloaded');
  ok(downloadCalls[0].url === 'https://a.test/blocker.jpg', 'blocker downloaded first');
  ok(downloadCalls[1].url === 'https://b.test/burst2.jpg?v=large', 'queued smaller task replaced by the larger variant');
  ok(!nms.getSavedUrls().has('https://a.test/burst2.jpg?v=small'), 'replaced smaller URL released from the dedup set');
  ok((store.log || []).some((e) => e.status === 'skipped-duplicate' && e.url === 'https://a.test/burst2.jpg?v=small'
    && /replaced by larger/.test(e.detail || '')), 'replaced smaller variant logged');
  await msg({ cmd: 'setSettings', settings: { maxConcurrent: 5 } });

  // 29. v1.8: a basename saved moments ago is not re-saved inside the window
  downloadCalls.length = 0;
  await nms.onHeadersReceived(details({ url: 'https://a.test/window.jpg?v=1', size: 90000, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === 1, 'first variant saved');
  await nms.onHeadersReceived(details({ url: 'https://b.test/window.jpg?v=2', size: 500000, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === 1, 'same basename saved moments ago is not re-saved inside the window');
  ok((store.log || []).some((e) => e.status === 'skipped-duplicate' && e.url === 'https://b.test/window.jpg?v=2'),
    'within-window repeat logged as skipped-duplicate');

  // 30. v1.8: after the coalesce window expires, a different-sized same-basename
  // file saves again (the old "genuinely different sizes" behavior is kept).
  downloadCalls.length = 0;
  await nms.onHeadersReceived(details({ url: 'https://a.test/expire.jpg?v=1', size: 90000, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === 1, 'first variant saved');
  await new Promise((r) => setTimeout(r, 2600)); // outlive the 2.5s coalesce window
  await nms.onHeadersReceived(details({ url: 'https://b.test/expire.jpg?v=2', size: 500000, tabId: 9 }));
  await tick();
  ok(downloadCalls.length === 2, 'after the window expires, a different-sized same-basename file saves again');

  // 31. v1.8: post-hold queue replace — a larger variant arriving AFTER the
  // debounce fired, while the smaller task is still queued behind a stalled
  // worker, replaces it via the queue-splice path.
  await msg({ cmd: 'setSettings', settings: { maxConcurrent: 1 } });
  downloadCalls.length = 0;
  const realDownload = chrome.downloads.download;
  let releaseBlocker = null;
  chrome.downloads.download = (opts, cb) => {
    if (opts.url.includes('qblock') && !releaseBlocker) {
      const id = nextDlId++;
      downloadCalls.push(opts);
      releaseBlocker = () => cb(id); // stall: worker stays busy
    } else realDownload(opts, cb);
  };
  const qSmallUrl = 'https://a.test/qburst.jpg?v=small';
  const qLargeUrl = 'https://b.test/qburst.jpg?v=large';
  await nms.onHeadersReceived(details({ url: 'https://a.test/qblock.jpg', size: 90000, tabId: 9 }));
  await nms.onHeadersReceived(details({ url: qSmallUrl, size: 90000, tabId: 9 }));
  await tick(); // holds fire: blocker downloading (stalled), small still queued
  ok(downloadCalls.length === 1 && downloadCalls[0].url.includes('qblock'),
    'blocker started while the smaller variant waits queued');
  await nms.onHeadersReceived(details({ url: qLargeUrl, size: 500000, tabId: 9 }));
  await tick();
  ok(!nms.getSavedUrls().has(qSmallUrl), 'queued smaller URL released from the dedup set');
  ok((store.log || []).some((e) => e.status === 'skipped-duplicate' && e.url === qSmallUrl
    && /replaced by larger/.test(e.detail || '')), 'queued smaller task logged as replaced');
  releaseBlocker();
  await tick();
  chrome.downloads.download = realDownload;
  ok(downloadCalls.length === 2, 'blocker + one qburst variant downloaded');
  ok(downloadCalls[1].url === qLargeUrl, 'larger variant replaced the queued smaller task');
  await msg({ cmd: 'setSettings', settings: { maxConcurrent: 5 } });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('failures:', failures.join('; ')); process.exit(1); }
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
