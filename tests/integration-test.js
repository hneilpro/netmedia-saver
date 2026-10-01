#!/usr/bin/env node
/* NetMedia Saver INTEGRATION test — runs the REAL background.js in a vm with
 * a chrome mock whose downloads.download performs REAL HTTP fetches and REAL
 * file writes (mirroring Chrome: uniquify on conflict, onChanged on
 * completion/interruption), plus a fake File System Access rooted at a real
 * temp dir for custom-folder mode. A local HTTP server serves real image
 * bytes; onHeadersReceived events are built from REAL response headers.
 * Every scenario uses a distinct fixture basename so query-stripped relPath
 * dedup can't leak between tests.
 * Run: node tests/integration-test.js   (exit 0 = all pass)
 */
const fs = require('fs'), vm = require('vm'), path = require('path'),
  http = require('http'), os = require('os');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log('  FAIL:', name); }
}
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const DLDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-int-'));
const SITEDIR = '/tmp/nms-live/site';
// distinct fixtures per scenario (copies made at startup)
const FIX = {
  race: 'race.jpg',            // concurrent same-URL race
  photo1: 'sig1/photo.jpg', photo2: 'sig2/photo.jpg', // signed dup URLs
  doomed: 'doomed.jpg',        // interrupted download
  big: 'big-dims.png',         // OR: dims pass, size fails -> saved
  small: 'small-dims.png',     // OR: both fail -> skipped-filters
  and: 'and-dims.png',         // AND: size fails -> skipped-size
  folder: 'folder.jpg',        // custom-folder write
  fail: 'fail.jpg',            // custom-folder write failure
};
fs.copyFileSync(path.join(SITEDIR, 'race.jpg'), path.join(SITEDIR, FIX.doomed));
fs.copyFileSync(path.join(SITEDIR, 'big-dims.png'), path.join(SITEDIR, FIX.and));
fs.copyFileSync(path.join(SITEDIR, 'race.jpg'), path.join(SITEDIR, FIX.folder));
fs.copyFileSync(path.join(SITEDIR, 'race.jpg'), path.join(SITEDIR, FIX.fail));

// ---------- local HTTP server with real image bytes ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let f = path.join(SITEDIR, u.pathname);
  if (u.pathname === '/sig1/photo.jpg' || u.pathname === '/sig2/photo.jpg') f = path.join(SITEDIR, 'sig1/photo.jpg');
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = parseInt(m[1], 10), end = m[2] ? parseInt(m[2], 10) : data.length - 1;
      const slice = data.slice(start, Math.min(end + 1, data.length));
      res.writeHead(206, {
        'Content-Type': f.endsWith('.png') ? 'image/png' : 'image/jpeg',
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${start + slice.length - 1}/${data.length}`,
        'Accept-Ranges': 'bytes',
      });
      res.end(slice); return;
    }
    res.writeHead(200, {
      'Content-Type': f.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'Content-Length': data.length, 'Accept-Ranges': 'bytes',
    });
    res.end(data);
  });
});

// ---------- chrome mock with REAL downloads ----------
const store = {};
const listeners = {};
let nextDlId = 1;
const interruptSet = new Set();
function listFiles(root) {
  const out = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name); f.isDirectory() ? walk(p) : out.push(path.relative(root, p)); } };
  if (fs.existsSync(root)) walk(root);
  return out;
}
const chrome = {
  runtime: { lastError: null,
    onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listeners.message = fn; } } },
  storage: { local: {
    get: (keys) => {
      if (typeof keys === 'string') return Promise.resolve({ [keys]: store[keys] });
      if (Array.isArray(keys)) { const o = {}; keys.forEach((x) => { o[x] = store[x]; }); return Promise.resolve(o); }
      return Promise.resolve({ ...store });
    },
    set: (o) => { Object.assign(store, o); return Promise.resolve(); },
  } },
  downloads: {
    onChanged: { addListener(fn) { listeners.dlChanged = fn; } },
    search(q, cb) { cb([]); },
    download(opts, cb) {
      const id = nextDlId++;
      const dest = path.join(DLDIR, opts.filename);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Chrome's uniquify: "name (1).ext" on conflict
      let final = dest;
      if (fs.existsSync(final)) {
        const ext = path.extname(final), base = final.slice(0, -ext.length);
        let n = 1; while (fs.existsSync(`${base} (${n})${ext}`)) n++;
        final = `${base} (${n})${ext}`;
      }
      setTimeout(() => {
        fetch(opts.url).then(async (r) => {
          if (interruptSet.has(opts.url)) {
            // interrupted mid-write: only the first 10 bytes land
            const buf = Buffer.from(await r.arrayBuffer()).slice(0, 10);
            fs.writeFileSync(final + '.partial', buf);
            listeners.dlChanged({ id, state: { current: 'interrupted' } });
            return;
          }
          const buf = Buffer.from(await r.arrayBuffer());
          fs.writeFileSync(final, buf);
          listeners.dlChanged({ id, state: { current: 'complete' } });
        }).catch(() => listeners.dlChanged({ id, state: { current: 'interrupted' } }));
      }, 10);
      cb(id);
    },
    erase(q, cb) {
      // erase() removes the history entry AND deletes the partial from disk
      listFiles(DLDIR).forEach((f) => {
        if (f.endsWith('.partial')) fs.unlinkSync(path.join(DLDIR, f));
      });
      cb();
    },
  },
  webRequest: { onHeadersReceived: { addListener(fn) { listeners.headers = fn; } } },
  tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
    query(q, cb) { cb([{ id: 7 }]); } },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
  management: { getSelf: async () => ({ installType: 'development' }) },
};

// ---------- fake File System Access (custom-folder mode) ----------
const CUSTOMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-custom-'));
let failNextWrite = false;
function makeDirHandle(realPath) {
  return {
    queryPermission: async () => 'granted',
    getDirectoryHandle: async (name, opts) => {
      const p = path.join(realPath, name);
      if (!fs.existsSync(p)) {
        if (!opts || !opts.create) throw new Error('not-found');
        fs.mkdirSync(p, { recursive: true });
      }
      return makeDirHandle(p);
    },
    getFileHandle: async (name, opts) => {
      const p = path.join(realPath, name);
      if (!fs.existsSync(p)) {
        if (!opts || !opts.create) throw new Error('not-found');
        fs.writeFileSync(p, Buffer.alloc(0));
      }
      return {
        createWritable: async () => {
          const chunks = [];
          return {
            write: async (data) => {
              if (failNextWrite) { failNextWrite = false; throw new Error('simulated write failure'); }
              chunks.push(Buffer.from(data));
            },
            close: async () => { fs.writeFileSync(p, Buffer.concat(chunks)); },
          };
        },
      };
    },
    removeEntry: async (name) => { fs.unlinkSync(path.join(realPath, name)); },
  };
}
const indexedDB = {
  open: () => {
    const req = {};
    setTimeout(() => {
      req.result = {
        createObjectStore: () => {},
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const q = {};
              setTimeout(() => { q.result = makeDirHandle(CUSTOMDIR); q.onsuccess && q.onsuccess(); }, 0);
              return q;
            },
          }),
        }),
      };
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  },
};

async function main() {
  await new Promise((r) => server.listen(8124, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:8124';

  const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const mod = { exports: {} };
  const sandbox = { chrome, module: mod, console, setTimeout, clearTimeout,
    setInterval, clearInterval, URL, fetch, indexedDB };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'background.js' });
  const nms = mod.exports;
  const msg = (m) => new Promise((res) => nms.onMessage(m, { tab: { id: 7 } }, res));

  // Build a REAL onHeadersReceived event from a real HTTP response's headers.
  async function realEvent(url) {
    const r = await fetch(url, { method: 'HEAD' });
    const headers = [];
    r.headers.forEach((v, k) => headers.push({ name: k, value: v }));
    return { url, method: 'GET', tabId: 7, type: 'xmlhttprequest', responseHeaders: headers };
  }
  const fire = (url) => realEvent(url).then((d) => listeners.headers(d));

  await msg({ cmd: 'setSettings', settings: { enabled: true, minSizeKB: 75, maxSizeKB: 0,
    imgDims: { enabled: true, minW: 600, minH: 600, maxW: 0, maxH: 0, logic: 'and' } } });

  // 1. Concurrent same-URL race -> exactly one file, no (1) rename, full bytes
  await Promise.all([fire(`${BASE}/${FIX.race}`), fire(`${BASE}/${FIX.race}`)]);
  await tick(2500);
  let files = listFiles(DLDIR);
  ok(files.filter((f) => f.endsWith('race.jpg')).length === 1, 'race: exactly one race.jpg on disk');
  ok(!files.some((f) => f.includes('(1)')), 'race: no uniquify-renamed (1) file');
  ok(fs.statSync(path.join(DLDIR, files.find((f) => f.endsWith('race.jpg')))).size === 903894,
    'race: full 903894 bytes on disk');

  // 2. Same basename under different signed URLs -> one file, no (1)
  await Promise.all([fire(`${BASE}/${FIX.photo1}?stp=aaa`), fire(`${BASE}/${FIX.photo2}?stp=bbb`)]);
  await tick(2500);
  files = listFiles(DLDIR);
  ok(files.filter((f) => f.endsWith('photo.jpg')).length === 1, 'signed URLs: exactly one photo.jpg');
  ok(!files.some((f) => f.includes('(1)')), 'signed URLs: no (1) rename');

  // 3. Interrupted download -> partial erased, dedup rolled back, retry works
  const doomedUrl = `${BASE}/${FIX.doomed}?v=1`;
  interruptSet.add(doomedUrl);
  await fire(doomedUrl);
  await tick(2500);
  files = listFiles(DLDIR);
  ok(!files.some((f) => f.endsWith('.partial')), 'interrupted: partial file erased from disk');
  const st1 = await msg({ cmd: 'getState' });
  ok(st1.log.some((e) => e.status === 'interrupted'), 'interrupted: logged as interrupted');
  interruptSet.delete(doomedUrl);
  await fire(doomedUrl);
  await tick(2500);
  files = listFiles(DLDIR);
  const doomed = files.filter((f) => f.endsWith('doomed.jpg') && !f.includes('(1)'));
  ok(doomed.length === 1 && fs.statSync(path.join(DLDIR, doomed[0])).size === 903894,
    'interrupted: retry re-downloaded the full file');

  // 4. AND/OR filters against real files + real Range-based dimension probe
  await msg({ cmd: 'setSettings', settings: { minSizeKB: 200,
    imgDims: { enabled: true, minW: 600, minH: 600, maxW: 0, maxH: 0, logic: 'or' } } });
  await fire(`${BASE}/${FIX.big}`);   // 800x600, 2791B: size fails, dims pass -> saved
  await fire(`${BASE}/${FIX.small}`); // 100x100, 292B: both fail -> skipped-filters
  await tick(2500);
  files = listFiles(DLDIR);
  ok(files.some((f) => f.endsWith('big-dims.png')), 'OR: big-dims.png saved (dims pass, size fails)');
  ok(!files.some((f) => f.endsWith('small-dims.png')), 'OR: small-dims.png not saved');
  const st2 = await msg({ cmd: 'getState' });
  ok(st2.log.some((e) => e.status === 'skipped-filters'), 'OR: double failure logged as skipped-filters');

  await msg({ cmd: 'setSettings', settings: {
    imgDims: { enabled: true, minW: 600, minH: 600, maxW: 0, maxH: 0, logic: 'and' } } });
  await fire(`${BASE}/${FIX.and}`); // fresh basename, size fails -> skipped-size (no dims probe)
  await tick(1500);
  const st3 = await msg({ cmd: 'getState' });
  ok(st3.log.some((e) => e.status === 'skipped-size' && e.url.endsWith(FIX.and)), 'AND: and-dims.png skipped-size');
  files = listFiles(DLDIR);
  ok(!files.some((f) => f.endsWith('and-dims.png')), 'AND: and-dims.png not saved');

  // 5. Custom-folder mode: real fetchAndWrite, folder dedup, write-failure cleanup
  await msg({ cmd: 'setSettings', settings: { minSizeKB: 75, useCustomFolder: true,
    imgDims: { enabled: false } } });
  await fire(`${BASE}/${FIX.folder}?v=f1`);
  await tick(1500);
  let cfiles = listFiles(CUSTOMDIR);
  const cf = cfiles.filter((f) => f.endsWith('folder.jpg'));
  ok(cf.length === 1, `custom folder: folder.jpg written (${JSON.stringify(cfiles)})`);
  ok(cf.length === 1 && fs.statSync(path.join(CUSTOMDIR, cf[0])).size === 903894,
    'custom folder: full bytes written');
  // different URL, same file -> skipped as duplicate already in folder, no second write
  await fire(`${BASE}/${FIX.folder}?v=f2`);
  await tick(1500);
  cfiles = listFiles(CUSTOMDIR);
  ok(cfiles.filter((f) => f.endsWith('folder.jpg')).length === 1, 'custom folder: no duplicate write');
  const st5 = await msg({ cmd: 'getState' });
  ok(st5.log.some((e) => e.status === 'skipped-duplicate' && e.url.includes('v=f2')),
    'custom folder: repeat logged as skipped-duplicate');
  // write failure -> no truncated file left behind
  failNextWrite = true;
  await fire(`${BASE}/${FIX.fail}?v=f1`);
  await tick(1500);
  cfiles = listFiles(CUSTOMDIR);
  const bad = cfiles.filter((f) => f.endsWith('fail.jpg'));
  ok(!bad.length || bad.every((f) => fs.statSync(path.join(CUSTOMDIR, f)).size === 903894),
    'custom folder: no truncated fail.jpg left after write failure');
  const st6 = await msg({ cmd: 'getState' });
  ok(st6.log.some((e) => e.status === 'error' && e.url.includes(FIX.fail)),
    'custom folder: write failure logged as error');

  console.log(`\n${pass} passed, ${fail} failed\n(dl dir: ${DLDIR}, custom dir: ${CUSTOMDIR})`);
  if (fail) { console.log('failures:', failures); process.exitCode = 1; }
  server.close();
}

main().catch((e) => { console.error('INTEGRATION FAIL:', e); server.close(); process.exit(1); });
