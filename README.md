# NetMedia Saver

A Chrome (Manifest V3) extension that watches network traffic the way DevTools'
**Network tab media/image filters** do, and **auto-saves images, video and audio
above a configurable minimum file size** into an organized local folder — while
you scroll, with no clicks per file.

## Install (load unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the extension, then click its icon to configure

No build step — it's plain HTML/JS.

## How it works

- `chrome.webRequest.onHeadersReceived` observes every image / media / XHR
  request (URL, MIME type, `Content-Length`, `Content-Range`) — the same
  metadata DevTools shows.
- A request is saved when: the global toggle is on **for its tab** (by default
  only the tab the extension was enabled on captures — opt other tabs in via
  *Capture on this tab*), its type is enabled, and its size is **≥ the minimum
  size** (default 200 KB) and **≤ the maximum size** when one is set.
  Files with no `Content-Length` are saved too unless you turn that off.
- **Downloads-subfolder mode (default):** files are saved via
  `chrome.downloads.download` into `Downloads/<subfolder>/`, e.g.
  `Downloads/netsaver/2026-09-30/example.com/image/photo.jpg`.
  The subfolder template supports `{date}`, `{host}`, `{kind}`.
- **Custom-folder mode:** click *Choose folder…* once in the popup. Chrome
  then writes straight into that folder silently (the grant is stored in
  IndexedDB and re-checked each session).
- Already-saved URLs are remembered so re-requested thumbnails don't
  double-download. The toolbar badge counts files saved.
- **Skip files already in the folder (v1.1):** each save is recorded by its
  relative path + size. Re-requested files that already landed in the folder
  are skipped instead of saved again (`skipped-duplicate` in the log).
  Match by *filename in any subfolder* (same size, within 1%) or by
  *exact folder + filename*. In custom-folder mode the check hits the real
  folder on disk, so files you placed there by hand are skipped too.
- **Per-tab enable (v1.1):** the popup's *This tab* section pauses or resumes
  capture for just the current tab; the global toggle still overrides
  everything. The toolbar tooltip reflects the effective state per tab.

## What's new in 1.4.0

- **Extra folders to remember:** the Duplicates section now has an "Extra
  folders to remember" list with an **Add folder…** button. "Cache existing
  files" scans these folders too (in both save modes), so files already in
  them won't be re-saved. Extra folders are stored read-only, namespaced in
  the cache (`extra/<FolderName>/…`) so they can't clobber the save folder's
  entries, and basename dedup still matches across all of them. Adding the
  save folder itself or the same folder twice is refused.

## What's new in 1.3.0

- **Development-mode cache inspector:** when the extension is loaded unpacked,
  the popup gains a *Development* section showing where the dedup cache lives
  (`chrome.storage.local`, keys `savedFiles` / `savedUrls`), live cached-file
  and cached-URL counts, the resolved save location, and a scrollable list of
  cached filenames with sizes (most recent first, capped at 200). The save
  location has **Copy location** and **Open folder** buttons — open launches
  the Downloads folder (Chrome offers no API to target the subfolder
  directly; in custom-folder mode open is hidden since Chrome can't open
  arbitrary folders). Hidden on normal installs. Requires the `management`
  permission (for install-type detection) and `clipboardWrite`.

## What's new in 1.2.0

- **Typed min size + optional max size:** the slider is now a type-in field
  (KB, presets kept as quick-set chips); an optional max-size field sets an
  upper bound — empty means no limit. Oversize skips log as `skipped-too-large`.
  Both gates apply only when the size is known from `Content-Length` /
  `Content-Range`.
- **Capture defaults to the enabling tab:** the extension now starts **off**.
  Flipping the global switch on records the current tab as the capture tab;
  other tabs stay off unless explicitly opted in via *Capture on this tab*.
  (Upgrades from v1.x keep the old capture-everywhere behavior until the
  switch is toggled once.)
- **Cache existing files button:** one click scans the save folder and
  remembers every file already there. In custom-folder mode it recursively
  walks the real folder (so hand-placed files are caught); in
  Downloads-subfolder mode it scans download history on demand.

## What's new in 1.1.0

- Skip-already-saved-files: `savedFiles` map (path → url/size) persisted with
  the dedup cache, basename index, `skipExisting` / `skipScope` settings,
  real-folder check in custom-folder mode, best-effort backfill from download
  history on startup (`forget saved files` clears it all).
- Per-tab capture switch, backed by the `activeTab` permission (no browsing
  history access — deliberately not the `tabs` permission).

## Settings (popup)

| Setting | What it does |
|---|---|
| On/off toggle | Off by default; turning it on makes the current tab the capture tab |
| Min / Max file size | Type-in KB fields (presets for min); max empty = no upper limit |
| Images / Video / Audio | Which MIME families to capture |
| Save files with unknown size | Off = skip responses with no `Content-Length` |
| Downloads subfolder | Path template under Downloads |
| Choose folder… | One-time picker for any local folder |
| reset / forget saved files / clear | Session stats, dedup cache + saved-files index, recent log |
| Skip files already in the folder | On by default = never re-save a file that's already in the folder |
| Match by | Filename in any subfolder (default; size must match within 1%) vs exact folder + filename |
| Cache existing files | One-click scan: remembers files already in the save folder |
| Capture on this tab | Opt the current tab in/out (only the enabling tab captures by default) |

## Hard limits (platform, not bugs)

- **webRequest cannot read response bodies** — bytes are re-fetched from the
  URL. `blob:`/`data:` URLs, one-time signed URLs, and MSE-streamed media
  (YouTube/Netflix-style) can't be captured this way.
- Silent auto-save is confined to **Downloads** unless you pick a custom
  folder once (Chromium-only File System Access API).
- Video that arrives as many `206` range requests: the size gate uses the
  `Content-Range` total, and the full URL (not the range) is downloaded.
- `chrome.downloads.download` resolves at download *start*; completion is
  tracked via `chrome.downloads.onChanged`.
- Needs `<all_urls>` host permission to observe traffic — that's what makes
  the network filter possible. Per-tab enable uses `activeTab` (not `tabs`),
  so the extension never sees browsing history — only the tab you clicked the
  icon on.
- **Duplicate detection in Downloads-subfolder mode** relies on the
  extension's own save log plus download history — a file you drop into the
  folder by hand is invisible there and may be saved again. Custom-folder
  mode checks the real folder, so it catches hand-placed files.

## Files

- `manifest.json` — MV3 manifest
- `background.js` — service worker: observer, size gate, dedup, download queue, custom-folder writer
- `popup.html` / `popup.css` / `popup.js` — settings UI + recent-saves log
- `icons/` — extension icons

## License

MIT
