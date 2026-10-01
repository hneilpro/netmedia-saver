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
- A request is saved when: the capture toggle is on, its type is enabled,
  and its size is **≥ the minimum size** (default 200 KB). Files with no
  `Content-Length` are saved too unless you turn that off.
- **Downloads-subfolder mode (default):** files are saved via
  `chrome.downloads.download` into `Downloads/<subfolder>/`, e.g.
  `Downloads/netsaver/2026-09-30/example.com/image/photo.jpg`.
  The subfolder template supports `{date}`, `{host}`, `{kind}`.
- **Custom-folder mode:** click *Choose folder…* once in the popup. Chrome
  then writes straight into that folder silently (the grant is stored in
  IndexedDB and re-checked each session).
- Already-saved URLs are remembered so re-requested thumbnails don't
  double-download. The toolbar badge counts files saved.

## Settings (popup)

| Setting | What it does |
|---|---|
| On/off toggle | Pause/resume capture without unloading |
| Minimum file size | Slider + presets (0–5 MB); the size gate |
| Images / Video / Audio | Which MIME families to capture |
| Save files with unknown size | Off = skip responses with no `Content-Length` |
| Downloads subfolder | Path template under Downloads |
| Choose folder… | One-time picker for any local folder |
| reset / forget saved URLs / clear | Session stats, dedup cache, recent log |

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
  the network filter possible.

## Files

- `manifest.json` — MV3 manifest
- `background.js` — service worker: observer, size gate, dedup, download queue, custom-folder writer
- `popup.html` / `popup.css` / `popup.js` — settings UI + recent-saves log
- `icons/` — extension icons

## License

MIT
