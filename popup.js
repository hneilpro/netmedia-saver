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
function fmtKB(kb) { return kb >= 1024 ? `${(kb / 1024).toFixed(kb % 1024 ? 1 : 0)} MB` : `${kb} KB`; }

let settings = null;

async function refresh() {
  const st = await chrome.runtime.sendMessage({ cmd: 'getState' });
  settings = st.settings;
  $('enabled').checked = settings.enabled;
  $('minSize').value = settings.minSizeKB;
  $('minVal').textContent = fmtKB(settings.minSizeKB);
  $('tImage').checked = settings.types.image;
  $('tVideo').checked = settings.types.video;
  $('tAudio').checked = settings.types.audio;
  $('saveUnknown').checked = settings.saveUnknownSize;
  $('subfolder').value = settings.subfolder;
  $('locDl').checked = !settings.useCustomFolder;
  $('locCustom').checked = settings.useCustomFolder;
  $('folderName').textContent = settings.customFolderName || '';
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
  const r = await chrome.runtime.sendMessage({ cmd: 'setSettings', settings: patch });
  settings = r.settings;
}

document.addEventListener('DOMContentLoaded', () => {
  refresh();
  const t = setInterval(refresh, 2000);

  $('enabled').addEventListener('change', (e) => push({ enabled: e.target.checked }));
  $('minSize').addEventListener('input', (e) => { $('minVal').textContent = fmtKB(+e.target.value); });
  $('minSize').addEventListener('change', (e) => push({ minSizeKB: +e.target.value }).then(refresh));
  document.querySelectorAll('.chips button').forEach((b) =>
    b.addEventListener('click', () => push({ minSizeKB: +b.dataset.kb }).then(refresh)));
  $('tImage').addEventListener('change', (e) => push({ types: { image: e.target.checked } }));
  $('tVideo').addEventListener('change', (e) => push({ types: { video: e.target.checked } }));
  $('tAudio').addEventListener('change', (e) => push({ types: { audio: e.target.checked } }));
  $('saveUnknown').addEventListener('change', (e) => push({ saveUnknownSize: e.target.checked }));
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
  window.addEventListener('unload', () => clearInterval(t));
});
