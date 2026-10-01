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
  return idbSet('dir', handle);
}
function idbSet(key, val) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function idbGet(key) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const q = db.transaction('handles', 'readonly').objectStore('handles').get(key);
    q.onsuccess = () => resolve(q.result ?? null);
    q.onerror = () => reject(q.error);
  }));
}
/* Extra folders to include in "cache existing files": [{ name, handle }]. */
async function getExtraFolders() {
  return (await idbGet('extraFolders')) || [];
}
async function setExtraFolders(arr) {
  await idbSet('extraFolders', arr);
  await push({ extraFolderNames: arr.map((f) => f.name) });
}
async function removeExtraFolder(i) {
  const extras = await getExtraFolders();
  extras.splice(i, 1);
  await setExtraFolders(extras);
  refresh();
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
let devSaveLocText = '';
let devListLoaded = false;
let lastExtraNames = null;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
  const imgD = settings.imgDims || {};
  $('imgDimsEnabled').checked = imgD.enabled !== false;
  if (document.activeElement !== $('imgMinW')) $('imgMinW').value = imgD.minW || 0;
  if (document.activeElement !== $('imgMinH')) $('imgMinH').value = imgD.minH || 0;
  if (document.activeElement !== $('imgMaxW')) $('imgMaxW').value = imgD.maxW > 0 ? imgD.maxW : '';
  if (document.activeElement !== $('imgMaxH')) $('imgMaxH').value = imgD.maxH > 0 ? imgD.maxH : '';
  const imgLogic = $('imgDimsLogic');
  imgLogic.value = imgD.logic === 'or' ? 'or' : 'and';
  imgLogic.disabled = !(imgD.enabled !== false);
  $('tImage').checked = settings.types.image;
  $('tVideo').checked = settings.types.video;
  $('tAudio').checked = settings.types.audio;
  $('skipSegments').checked = settings.skipSegments !== false;
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

  // Extra folders to include in "cache existing files" (re-render only on change
  // so the 2s refresh can't swallow a click on a Remove button).
  const namesKey = JSON.stringify(settings.extraFolderNames || []);
  if (namesKey !== lastExtraNames) {
    lastExtraNames = namesKey;
    const ef = $('extraFolders');
    ef.innerHTML = '';
    for (const [i, name] of (settings.extraFolderNames || []).entries()) {
      const li = document.createElement('li');
      const nm = document.createElement('span');
      nm.className = 'nm'; nm.textContent = name; nm.title = name;
      const rm = document.createElement('button');
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => removeExtraFolder(i));
      li.append(nm, rm);
      ef.appendChild(li);
    }
    if (!ef.children.length) ef.innerHTML = '<li class="dim">None added yet.</li>';
  }

  // Development-only cache inspection (unpacked installs)
  const dev = $('devSection');
  if (st.devMode) {
    dev.hidden = false;
    const cs = st.cacheStats || { files: 0, urls: 0 };
    $('devFiles').textContent = `${cs.files} files`;
    $('devUrls').textContent = `${cs.urls} urls`;
    const extraN = (settings.extraFolderNames || []).length;
    devSaveLocText = (settings.useCustomFolder
      ? `Custom folder: ${settings.customFolderName || '(no folder chosen yet)'}`
      : `Downloads/${settings.subfolder.replaceAll('{date}', todayStr())}`)
      + (extraN ? ` (+ ${extraN} extra folder${extraN === 1 ? '' : 's'})` : '');
    $('devSaveLoc').textContent = devSaveLocText;
    $('devOpenFolder').style.display = settings.useCustomFolder ? 'none' : '';
    if (!devListLoaded) loadDevList();
  } else {
    dev.hidden = true;
  }

  const ul = $('log'); ul.innerHTML = '';
  for (const e of st.log) {
    const li = document.createElement('li');
    const cls = e.status === 'saved' ? 'ok' : e.status.startsWith('skipped') ? 'skip' : 'err';
    const size = e.size ? fmtBytes(e.size) : '?';
    const name = decodeURIComponent((e.url.split('/').pop() || e.url).split('?')[0]).slice(0, 60);
    li.innerHTML = `<span class="${cls}">●</span> ${e.kind} · ${size} · ${escapeHtml(name)}`;
    li.title = e.url + (e.detail ? `\n${e.detail}` : '') + (e.error ? `\n${e.error}` : '');
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Dev-mode: list of cached files (most recent first, capped by the SW). */
async function loadDevList() {
  const ul = $('devFileList');
  ul.innerHTML = '<li class="dim">Loading…</li>';
  try {
    const r = await chrome.runtime.sendMessage({ cmd: 'getCachedFiles' });
    const files = (r && r.files) || [];
    $('devListCount').textContent = r ? `showing ${files.length} of ${r.total}` : '';
    ul.innerHTML = '';
    if (!files.length) ul.innerHTML = '<li class="dim">Nothing cached yet.</li>';
    for (const f of files) {
      const li = document.createElement('li');
      li.textContent = `${f.size != null ? fmtBytes(f.size) : '?'} · ${f.relPath}`;
      ul.appendChild(li);
    }
    devListLoaded = true;
  } catch (e) {
    ul.innerHTML = '<li class="dim">Could not load the list.</li>';
  }
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch (e) {
    // Fallback for contexts where the async clipboard API is unavailable.
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('copy failed');
  }
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

function clampInt(v) {
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
  $('skipSegments').addEventListener('change', (e) => push({ skipSegments: e.target.checked }).then(refresh));
  $('saveUnknown').addEventListener('change', (e) => push({ saveUnknownSize: e.target.checked }));
  const pushDims = (patch) => push({ imgDims: { ...(settings.imgDims || {}), ...patch } });
  const dimVal = (k, isMax) => {
    const v = (settings.imgDims || {})[k] || 0;
    return isMax ? (v > 0 ? v : '') : v;
  };
  $('imgDimsEnabled').addEventListener('change', (e) => pushDims({ enabled: e.target.checked }).then(refresh));
  $('imgDimsLogic').addEventListener('change', (e) => pushDims({ logic: e.target.value }).then(refresh));
  for (const [id, key, isMax] of [['imgMinW', 'minW', false], ['imgMinH', 'minH', false], ['imgMaxW', 'maxW', true], ['imgMaxH', 'maxH', true]]) {
    $(id).addEventListener('change', (e) => {
      const raw = String(e.target.value).trim();
      if (isMax && raw === '') { pushDims({ [key]: 0 }).then(refresh); return; } // empty = no limit
      const v = clampInt(raw);
      if (v === null) { e.target.value = dimVal(key, isMax); return; } // invalid — restore
      pushDims({ [key]: v }).then(refresh);
    });
  }
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
  $('devRefreshList').addEventListener('click', () => { devListLoaded = false; loadDevList(); });
  $('devCopyLoc').addEventListener('click', async () => {
    const s = $('devLocStatus');
    try {
      await copyText(devSaveLocText);
      s.textContent = 'Copied.';
    } catch (e) {
      s.textContent = 'Copy failed.';
    }
    setTimeout(() => { s.textContent = ''; }, 2000);
  });
  $('devOpenFolder').addEventListener('click', () => {
    // Opens the Downloads root — Chrome offers no API to target the subfolder.
    chrome.downloads.showDefaultFolder();
  });

  $('addExtraFolder').addEventListener('click', async () => {
    try {
      // Read-only is enough: extra folders are scanned, never written to.
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      const extras = await getExtraFolders();
      const same = async (h) => h && h.isSameEntry && await h.isSameEntry(dir).catch(() => false);
      if (await same(await idbGet('dir'))) {
        alert('That is already the save folder — it is always scanned.');
        return;
      }
      for (const f of extras) {
        if (await same(f.handle)) { alert('That folder is already in the list.'); return; }
      }
      extras.push({ name: dir.name, handle: dir });
      await setExtraFolders(extras);
      refresh();
    } catch (e) {
      if (e && e.name !== 'AbortError') alert('Could not use that folder: ' + (e.message || e));
    }
  });

  $('cacheExisting').addEventListener('click', async () => {
    const btn = $('cacheExisting'), st = $('cacheStatus');
    btn.disabled = true;
    st.textContent = 'Scanning…';
    try {
      let total = 0;
      const skipped = [];
      const pending = [];
      async function flush() {
        if (!pending.length) return;
        const r = await chrome.runtime.sendMessage({ cmd: 'cacheFiles', files: pending.splice(0, pending.length) });
        total += (r && r.added) || 0;
      }
      // Walk one folder root, shipping [relPath, size] entries to the SW in chunks.
      async function walkRoot(handle, prefix, label) {
        let perm = await handle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
        if (perm !== 'granted') throw new Error(`permission denied for "${label}"`);
        async function walk(dir, dirPrefix) {
          for await (const [name, h] of dir.entries()) {
            const rel = dirPrefix ? `${dirPrefix}/${name}` : name;
            if (h.kind === 'file') {
              let size = null;
              try { size = (await h.getFile()).size; } catch (e) { /* unreadable — cache by name only */ }
              pending.push([prefix ? `${prefix}/${rel}` : rel, size]);
              st.textContent = `Scanning ${label}… ${total + pending.length} files`;
              if (pending.length >= 500) await flush();
            } else if (h.kind === 'directory') {
              await walk(h, rel);
            }
          }
        }
        await walk(handle, '');
      }
      const roots = [];
      if (settings.useCustomFolder) {
        const main = await idbGet('dir');
        if (main) roots.push({ handle: main, prefix: '', label: 'save folder' });
      } else {
        const r = await chrome.runtime.sendMessage({ cmd: 'scanExisting' });
        total += (r && r.added) || 0;
      }
      // Extra folders are namespaced in the cache so they can't clobber the
      // save folder's entries; basename dedup still matches across them.
      for (const f of await getExtraFolders()) {
        roots.push({ handle: f.handle, prefix: `extra/${f.name}`, label: f.name });
      }
      if (settings.useCustomFolder && !roots.length) throw new Error('no folder chosen yet');
      for (const root of roots) {
        try {
          await walkRoot(root.handle, root.prefix, root.label);
        } catch (e) {
          skipped.push(root.label);
        }
      }
      await flush();
      let done = total ? `Cached ${total} existing file${total === 1 ? '' : 's'} — they won't be re-saved.` : 'Nothing new found.';
      if (skipped.length) done += ` (${skipped.length} folder${skipped.length === 1 ? '' : 's'} skipped — permission denied)`;
      st.textContent = done;
      if (total && settings && !$('devSection').hidden) { devListLoaded = false; loadDevList(); }
    } catch (e) {
      st.textContent = 'Scan failed: ' + (e && e.message || e);
    } finally {
      btn.disabled = false;
    }
  });
  window.addEventListener('unload', () => clearInterval(t));
});
