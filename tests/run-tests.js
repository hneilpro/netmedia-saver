/* NetMedia Saver unit tests — runs background.js (the real service worker
 * source) in a vm sandbox with mocked chrome.* APIs. Covers the v1.2
 * behavior: typed min / optional max gates, origin-tab capture default,
 * basename dedup default, cacheFiles/scanExisting handlers.
 * Run: node tests/run-tests.js  (exit 0 = all pass)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- chrome mock ---------- */
const store = {};            // chrome.storage.local backing
const downloadCalls = [];    // chrome.downloads.download invocations
let downloadSearchResults = [];
const listeners = {};

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
    download: (opts, cb) => { downloadCalls.push(opts); cb(101); },
  },
  tabs: {
    onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } },
    query: async () => [],
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
const tick = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  await tick(); // let loadState() settle

  // 1. Defaults: basename dedup on, no max gate, off until first explicit enable
  const s0 = nms.getSettings();
  ok(s0.skipExisting === true, 'default skipExisting is on');
  ok(s0.skipScope === 'basename', 'default skipScope is basename (filename in any subfolder)');
  ok(s0.maxSizeKB === 0, 'default maxSizeKB is 0 (no limit)');
  ok(s0.enabledTabId === -1, 'default enabledTabId is -1');
  ok(s0.enabled === false, 'default is off until the first explicit enable');
  ok(nms.effectiveEnabled(7) === false, 'fresh install captures nothing until enabled');

  // 2. Legacy upgrade path: enabled=true stored, no origin recorded -> old behavior
  await msg({ cmd: 'setSettings', settings: { enabled: true } }); // no tabId
  ok(nms.getSettings().enabledTabId === -1, 'no origin recorded without a tab id');
  ok(nms.effectiveEnabled(7) === true && nms.effectiveEnabled(8) === true,
    'upgraded installs keep capture-everywhere until re-enabled');

  // 3. Origin-tab default: enable on tab 7 -> only tab 7 captures
  await msg({ cmd: 'setSettings', settings: { enabled: true }, tabId: 7 });
  ok(nms.getSettings().enabledTabId === 7, 'enabling records the origin tab');
  ok(nms.effectiveEnabled(7) === true, 'origin tab captures');
  ok(nms.effectiveEnabled(8) === false, 'other tabs do NOT capture by default');
  ok(nms.effectiveEnabled(-1) === true, 'non-tab requests follow the global switch');
  await msg({ cmd: 'setTabEnabled', tabId: 8, enabled: true });
  ok(nms.effectiveEnabled(8) === true, 'explicit per-tab opt-in still works');
  await msg({ cmd: 'setSettings', settings: { enabled: false }, tabId: 7 });
  ok(nms.effectiveEnabled(7) === false && nms.effectiveEnabled(8) === false, 'global off overrides every tab');
  await msg({ cmd: 'setSettings', settings: { enabled: true }, tabId: 9 });
  ok(nms.getSettings().enabledTabId === 9, 're-enabling moves the origin tab');
  ok(nms.effectiveEnabled(9) === true && nms.effectiveEnabled(7) === false, 'new origin captures, old one does not');

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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('failures:', failures.join('; ')); process.exit(1); }
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
