/* NetMedia Saver popup — settings UI + status. Talks to the service worker via messages. */
const $ = (id) => document.getElementById(id);

function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('nmsaver', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function storeDirHandle(handle) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'dir');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}

let settings = null;
let activeTabId = -1;

async function refresh() {
  // activeTab grants us the current tab after the user clicked the icon.
  let host = '';
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0] && typeof tabs[0].id === 'number') {
      activeTabId = tabs[0].id;
      try { host = new URL(tabs[0].url || '').hostname; } catch (e) { /* ignore */ }
    }
  } catch (e) { /* tabs unavailable */ }

  const st = await chrome.runtime.sendMessage({ cmd: 'getState', tabId: activeTabId });
  settings = st.settings;
  $('enabled').checked = settings.enabled;
  // Don't clobber a field the user is actively typing in (refresh runs every 2s).
  if (document.activeElement !== $('minSize')) $('minSize').value = settings.minSizeKB;
  if (document.activeElement !== $('maxSize')) $('maxSize').value = settings.maxSizeKB > 0 ? settings.maxSizeKB : '';
  $('tImage').checked = settings.types.image;
  $('tVideo').checked = settings.types.video;
  $('tAudio').checked = settings.types.audio;
  $('saveUnknown').checked = settings.saveUnknownSize;
  if (document.activeElement !== $('subfolder')) $('subfolder').value = settings.subfolder;
  $('locDl').checked = !settings.useCustomFolder;
  $('locCustom').checked = settings.useCustomFolder;
  $('folderName').textContent = settings.customFolderName || '';
  $('skipExisting').checked = !!settings.skipExisting;
  $('skipScope').value = settings.skipScope || 'basename';

  // This tab
  $('tabHost').textContent = host;
  const te = $('tabEnabled');
  te.checked = st.tabEnabled !== false;
  const globalOff = !settings.enabled;
  te.disabled = globalOff || activeTabId < 0;
  $('tabHint').textContent = globalOff
    ? 'Global switch is off — capture is paused everywhere.'
    : (activeTabId < 0
        ? 'Could not identify the current tab.'
        : 'Only the tab the extension was enabled on captures by default — tick the box to add this tab.');

  $('statFiles').textContent = `${st.sessionSaved} files`;
  $('statBytes').textContent = fmtBytes(st.sessionBytes);
  $('statQueue').textContent = st.queueLen || st.activeCount ? `${st.activeCount} active · ${st.queueLen} queued` : '';
  document.querySelectorAll('.chips button').forEach((b) =>
    b.classList.toggle('on', parseInt(b.dataset.kb, 10) === settings.minSizeKB));

  const ul = $('log'); ul.innerHTML = '';
  for (const e of st.log) {
    const li = document.createElement('li');
    const cls = e.status === 'saved' ? 'ok' : e.status.startsWith('skipped') ? 'skip' : 'err';
    const size = e.size ? fmtBytes(e.size) : '?';
    const name = decodeURIComponent((e.url.split('/').pop() || e.url).split('?')[0]).slice(0, 60);
    li.innerHTML = `<span class="${cls}">●</span> ${e.kind} · ${size} · ${escapeHtml(name)}`;
    li.title = e.url + (e.error ? `\n${e.error}` : '');
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function push(patch) {
  // Always include the active tab: the SW records it as the capture tab
  // when the global switch is turned on.
  const r = await chrome.runtime.sendMessage({ cmd: 'setSettings', settings: patch, tabId: activeTabId });
  settings = r.settings;
}

function clampKB(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

document.addEventListener('DOMContentLoaded', () => {
  refresh();
  const t = setInterval(refresh, 2000);

  $('enabled').addEventListener('change', (e) => push({ enabled: e.target.checked }));
  $('minSize').addEventListener('change', (e) => {
    const v = clampKB(e.target.value);
    if (v === null) { e.target.value = settings.minSizeKB; return; } // invalid — restore
    push({ minSizeKB: v }).then(refresh);
  });
  $('maxSize').addEventListener('change', (e) => {
    const raw = String(e.target.value).trim();
    if (raw === '') { push({ maxSizeKB: 0 }).then(refresh); return; } // empty = no limit
    const v = clampKB(raw);
    if (v === null) { e.target.value = settings.maxSizeKB > 0 ? settings.maxSizeKB : ''; return; }
    push({ maxSizeKB: v }).then(refresh);
  });
  document.querySelectorAll('.chips button').forEach((b) =>
    b.addEventListener('click', () => push({ minSizeKB: +b.dataset.kb }).then(refresh)));
  $('tImage').addEventListener('change', (e) => push({ types: { image: e.target.checked } }));
  $('tVideo').addEventListener('change', (e) => push({ types: { video: e.target.checked } }));
  $('tAudio').addEventListener('change', (e) => push({ types: { audio: e.target.checked } }));
  $('saveUnknown').addEventListener('change', (e) => push({ saveUnknownSize: e.target.checked }));
  $('skipExisting').addEventListener('change', (e) => push({ skipExisting: e.target.checked }).then(refresh));
  $('skipScope').addEventListener('change', (e) => push({ skipScope: e.target.value }).then(refresh));
  $('tabEnabled').addEventListener('change', async (e) => {
    if (activeTabId >= 0) {
      await chrome.runtime.sendMessage({ cmd: 'setTabEnabled', tabId: activeTabId, enabled: e.target.checked });
    }
    refresh();
  });
  $('subfolder').addEventListener('change', (e) => push({ subfolder: e.target.value.trim() || 'netsaver/{date}' }));
  $('locDl').addEventListener('change', () => push({ useCustomFolder: false }).then(refresh));

  $('pickFolder').addEventListener('click', async () => {
    try {
      // Must run in this visible page (user gesture) — SW can't open the picker.
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      await storeDirHandle(dir);
      await push({ useCustomFolder: true, customFolderName: dir.name });
      $('locCustom').checked = true;
      refresh();
    } catch (e) {
      if (e && e.name !== 'AbortError') alert('Could not use that folder: ' + (e.message || e));
    }
  });
  $('locCustom').addEventListener('change', async (e) => {
    if (e.target.checked && !$('folderName').textContent) { $('pickFolder').click(); e.target.checked = false; $('locDl').checked = true; }
  });

  $('resetStats').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'resetStats' }).then(refresh));
  $('clearDedup').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'clearDedup' }));
  $('clearLog').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'clearLog' }).then(refresh));

  $('cacheExisting').addEventListener('click', async () => {
    const btn = $('cacheExisting'), st = $('cacheStatus');
    btn.disabled = true;
    st.textContent = 'Scanning…';
    try {
      let total = 0;
      if (settings.useCustomFolder) {
        // Walk the real folder recursively. Runs in the popup (not the SW)
        // because requesting folder permission needs a user gesture.
        total = await walkAndCache((n) => { st.textContent = `Scanning… ${n} files`; });
      } else {
        const r = await chrome.runtime.sendMessage({ cmd: 'scanExisting' });
        total = (r && r.added) || 0;
      }
      st.textContent = total ? `Cached ${total} existing file${total === 1 ? '' : 's'} — they won't be re-saved.` : 'Nothing new found.';
    } catch (e) {
      st.textContent = 'Scan failed: ' + (e && e.message || e);
    } finally {
      btn.disabled = false;
    }
  });
  window.addEventListener('unload', () => clearInterval(t));
});

/* Recursively walk the picked custom folder and ship [relPath, size]
 * entries to the service worker in chunks. Returns total cached count. */
async function walkAndCache(progress) {
  const db = await idbOpen();
  const handle = await new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readonly');
    const q = tx.objectStore('handles').get('dir');
    q.onsuccess = () => resolve(q.result || null);
    q.onerror = () => reject(q.error);
  });
  if (!handle) throw new Error('no folder chosen yet');
  let perm = await handle.queryPermission({ mode: 'read' });
  if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
  if (perm !== 'granted') throw new Error('folder permission denied');

  const pending = [];
  let total = 0;
  async function flush() {
    if (!pending.length) return;
    const r = await chrome.runtime.sendMessage({ cmd: 'cacheFiles', files: pending.splice(0, pending.length) });
    total += (r && r.added) || 0;
  }
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (h.kind === 'file') {
        let size = null;
        try { size = (await h.getFile()).size; } catch (e) { /* unreadable — cache by name only */ }
        pending.push([rel, size]);
        if (progress) progress(total + pending.length);
        if (pending.length >= 500) await flush();
      } else if (h.kind === 'directory') {
        await walk(h, rel);
      }
    }
  }
  await walk(handle, '');
  await flush();
  return total;
}
