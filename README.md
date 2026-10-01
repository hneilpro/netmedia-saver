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

Works in **Microsoft Edge** too (Chromium) — same steps via `edge://extensions`.

No build step — it's plain HTML/JS.

## v1.8.0 — duplicate + partial-file fixes (Instagram)

- **True atomic dedup claims:** the URL check + claim now run in the
  synchronous prefix of the network observer — before the first `await` — so
  two near-simultaneous requests for the same URL can no longer both slip
  through and produce `photo (1).jpg` copies. (The v1.6 comment's atomicity
  reasoning was wrong: the first `await` is the tab-enabled check, which sits
  *before* the old claim.) Claims are rolled back when a later gate rejects
  the file, so nothing is permanently marked from a rejected request.
- **Srcset coalescing:** Instagram serves one image at several resolutions as
  different signed URLs under one basename, with sizes more than 1% apart —
  the old basename dedup let them all through and Chrome renamed the extras
  to `photo (1).jpg`. Now, the first candidate for a basename is held for a
  short debounce (~0.5 s) so srcset siblings arriving in the same burst can
  be compared *before* anything starts downloading; only the **largest** is
  then kept (by file size, tie-break by probed dimensions) and the rest log
  as `skipped-duplicate`. A larger latecomer replaces a still-queued smaller
  download (its claim is released); if the smaller one already started
  downloading it can't be taken back, so the latecomer is skipped instead. A
  basename seen in the last ~2.5 s is not re-saved. The window is in-memory
  only (not a setting); afterwards the old behavior returns — a genuinely
  different-sized same-basename file saves again.
- **Byte-range URLs are stripped before download:** Instagram video requests
  carry `bytestart`/`byteend` query params (206 partial content). Re-fetching
  that URL verbatim saved only the requested byte range — a corrupt partial
  file that looked like a failed save. Those params (and `range=`) are now
  stripped from the download/fetch URL. The size gate still uses the
  `Content-Range` total, so the minimum-size filter keeps working on videos.

## v1.7.0 — where to capture: this tab, website whitelist, website blacklist

The popup's **Where to capture** section offers three scopes (global switch stays
the master on/off):

- **This tab only** (default): only the tab the extension was enabled on
  captures — opt other tabs in via *Capture on this tab*.
- **Whitelist — only these sites**: capture on any tab whose page host matches
  a listed domain (`x.com` also matches `sub.x.com`). Matching is by the page
  you're on, not the CDN the file is hosted from.
- **Blacklist — everywhere except these**: capture on every tab except listed
  sites.

Type a domain (or hit **Add this site** for the current tab); entries normalize
(`HTTPS://Mail.Example.com:8080/a` → `mail.example.com`) and duplicates are
refused. The per-tab *Capture on this tab* checkbox is an explicit override
that wins over the lists in every mode. Requires the warning-free `tabs`
permission so the service worker can see page hosts.

## How it works

- `chrome.webRequest.onHeadersReceived` observes every image / media / XHR
  request (URL, MIME type, `Content-Length`, `Content-Range`) — the same
  metadata DevTools shows.
- A request is saved when: the global toggle is on **for its tab** (by default
  only the tab the extension was enabled on captures — opt other tabs in via
  *Capture on this tab*), its type is enabled, and its size is **≥ the minimum
  size** (default 75 KB) and **≤ the maximum size** when one is set.
  Files with no `Content-Length` are saved too unless you turn that off.
  Images additionally pass the **dimension filter** (on by default: ≥ 600×600 px;
  optional maximums) — see below.
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

## What's new in 1.5.0

- **Stream-segment skip:** DASH/HLS-style video/audio arrives as many small
  fMP4 media segments (moof+mdat, no init segment) that each look like an
  ordinary `video/mp4` response in the headers — saving one produced the
  "corrupted" files. Segments (`.m4s` URLs, `seg-12`/`chunk-3`-style names,
  `video/iso.segment` content type) are now skipped with a `skipped-segment`
  log entry. MPEG-TS (`.ts`) segments still save — they're playable alone.
- **Image dimension filter:** images can now be filtered by pixel size as well
  as file size — min/max width and height, max optional (empty = no limit).
  Defaults: on, minimum 600×600 px. The check costs one tiny `Range` request
  (first 64 KB) per image; JPEG/PNG/GIF/WebP/BMP headers are parsed locally
  with no dependencies. Images whose dimensions can't be read are saved
  anyway — the probe never blocks a save. Too-small/too-big skips log as
  `skipped-dims` with the detected dimensions.
- **Default min file size lowered** 200 KB → 75 KB (existing installs keep
  their saved value; change it in the popup).

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
| Min / Max file size | Type-in KB fields (presets for min, default 75 KB); max empty = no upper limit |
| Image dimensions | Optional min/max width/height filter for images (default on, min 600×600 px); max empty = no upper limit |
| Skip stream segments | On = DASH/HLS fMP4 media segments are skipped instead of saved as unplayable files |
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
  (YouTube/Netflix-style) can't be captured this way. DASH/HLS **media
  segments** (fMP4 chunks) are detected and skipped rather than saved as
  unplayable files — capturing such streams properly needs a dedicated
  downloader (e.g. yt-dlp) pointed at the page URL.
- The **image dimension probe** adds one small `Range` request per image
  (first 64 KB, parsed locally). Servers that block ranged requests simply
  yield unknown dimensions, and the image is saved anyway.
- Silent auto-save is confined to **Downloads** unless you pick a custom
  folder once (Chromium-only File System Access API).
- Video that arrives as many `206` range requests: the size gate uses the
  `Content-Range` total, and the byte-range query params (`bytestart` /
  `byteend` / `range`) are stripped from the download URL so the full file is
  fetched, not the partial range.
- `chrome.downloads.download` resolves at download *start*; completion is
  tracked via `chrome.downloads.onChanged`.

### Instagram notes (platform realities, not bugs)

- The extension can only save what the browser actually **requests**.
  Instagram's `srcset` means the full-resolution variant is often never
  fetched — only the displayed resolution hits the network — so don't expect
  originals. If an image never appears in the log at all, the browser simply
  never requested it (cached render, or a resolution below your filters).
- Video delivered as `blob:` URLs or MSE streams can't be re-fetched by
  design (webRequest can't read bodies); those never save, whatever the
  settings.
- Instagram profile-grid thumbnails are small: with the default image
  dimension filter (≥ 600×600 px) they log as `skipped-dims`. Lower the
  minimums if you want the thumbnails too.
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
