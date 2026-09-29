# ScreenCapture Pro 1.0.1: Reverse-Engineering Report

> **Note:** this report describes the original extension. Since then, this repository became a video-only recorder. The screenshot features (visible area, selected area, full page) and the image editor were removed; screenshots are the job of the companion extension [FullShot](https://github.com/Penguin-Pants/FullShot). Rows about screenshots and the editor in [Status in 2.0.0](#status-in-200) describe fixes made before that change.

## Summary

- The XPI contains plain, unminified JavaScript. No bundler, transpiler or obfuscation is present. The files in `src/` are the original files, byte for byte.
- The extension uses Manifest V2 and the Firefox `browser.*` API (with a `chrome.*` fallback).
- There is no build step. Firefox loads `src/` directly.
- Captures are processed locally. The only external URL is a PayPal donation link.
- Several features have bugs or are dead code. See [Known defects](#known-defects).
- Version 2.0.0 of this repository fixes most of them. See [Status in 2.0.0](#status-in-200).

## Source package

| Item | Value |
| --- | --- |
| Name | ScreenCapture Pro |
| Version | 1.0.1 |
| Add-on ID | `screencapture-pro@extension.local` |
| Signature | Mozilla AMO production signing (`META-INF/`, removed from `src/`) |
| Manifest | V2, `strict_min_version` 109.0 |
| License in package | None. `options.html` states "Open Source" but gives no license. |

## File map

| File | Role | Loaded by |
| --- | --- | --- |
| `manifest.json` | Extension manifest | Firefox |
| `background.js` | Persistent background script. Capture, crop, stitch, notifications, history. | `background.scripts` |
| `content.js` | Area-selection overlay (message `startAreaCapture`). Not used by the popup. | `content_scripts` on `<all_urls>` |
| `area-selector.js` | Older area-selection overlay | **Nothing. Dead file.** |
| `popup.html` / `popup.js` | Toolbar popup with 5 actions | `browser_action.default_popup` |
| `recorder.html` / `recorder.js` | Screen recorder page (tab) | Popup opens it in a new tab |
| `editor.html` / `editor.js` | Image editor page (tab) | Popup opens it in a new tab |
| `options.html` / `options.js` | About and donation page | `options_ui` |
| `icons/*.png` | 16, 32, 48, 128 px icons | Manifest |

## Permissions

| Permission | Used for |
| --- | --- |
| `<all_urls>` | `tabs.captureVisibleTab` and `tabs.executeScript` on any page |
| `activeTab` | Redundant with `<all_urls>` |
| `tabs` | Read `tab.url` to block internal pages |
| `downloads` | Save visible-area captures |
| `storage` | `captureHistory` list in `storage.local` |
| `notifications` | Success and failure messages |

## Feature flows

### Capture visible area (popup)

1. `popup.js` calls `tabs.captureVisibleTab` (PNG data URL).
2. It converts the data URL to a `Blob` and an object URL.
3. It calls `downloads.download` with filename `screenshot-<timestamp>.png`.

### Capture selected area (popup)

1. `popup.js` injects a large inline script with `tabs.executeScript`. This script builds the overlay. (It duplicates the code in `content.js`.)
2. On mouse up, the page script sends `captureViewportForCrop` with the selection rectangle (CSS pixels).
3. `background.js` `captureAndCropArea()` waits 200 ms, captures the visible tab, then injects a second script.
4. The second script crops the image with a canvas (it multiplies by `devicePixelRatio`) and downloads it with an `<a download>` link **inside the web page**.

### Capture full page (popup)

1. `popup.js` sends `captureFullPage` to the background.
2. `background.js` reads page size, then scrolls one viewport at a time. It waits 1500 ms per step and captures each step.
3. It injects a script that stitches the captures on a canvas in the page and downloads the result with an `<a download>` link.
4. If page height is more than 30000 px, it saves only the visible area.

### Keyboard shortcut

- Command `capture-visible` (`Ctrl+Shift+S`) calls `captureVisibleArea()` in `background.js`. It passes the PNG data URL directly to `downloads.download`.

### Screen recording

1. The popup opens `recorder.html` in a new tab.
2. `recorder.js` calls `getDisplayMedia` (video 1920x1080 ideal, optional audio).
3. If "Include microphone" is set, it calls `getUserMedia` and mixes audio with `AudioContext` when both sources exist.
4. `MediaRecorder` records WebM (VP8 or VP9, Opus) at 2.5 Mbps video and 128 kbps audio, in 1 s chunks.
5. On stop, it downloads `recording-<timestamp>.webm` and shows an `alert`.

### Editor

- Opens an image from a file, drag and drop or clipboard paste. It can also create a blank canvas.
- Drawing tools: draw, line, arrow, double arrow, rectangle, filled rectangle, circle, filled circle, star, text, highlight, blur, pixelate, eraser, color picker, move (layers), crop.
- Image operations: resize, rotate, flip, brightness, contrast, saturation, grayscale, sepia, invert, sharpen, vintage, vignette, noise, watermark, add image layer, remove background (flood fill from edges).
- Undo and redo keep up to 50 PNG data URL snapshots.
- Shortcuts: `Ctrl+Z` undo, `Ctrl+Y` redo, `Ctrl+S` save.
- Save writes `edited-<timestamp>.png`.

### Remnants of a paid version

- `editor.html` marks 17 tools with class `premium`. `editor.js` `updatePremiumButtons()` removes this class at load.
- `recorder.js` replaces the subtitle with "Unlimited recordings".
- These lines do nothing now. They can be removed.

## Message protocol

Messages go from sender to `background.js` unless noted.

| Action | Sender | Status |
| --- | --- | --- |
| `captureViewportForCrop` | Script injected by `popup.js` | Used |
| `captureFullPage` | `popup.js` | Used |
| `recordingStopped` | `recorder.js` | Used (shows notification) |
| `captureVisibleTab` | `area-selector.js` | Dead (sender is not loaded) |
| `cropAndSave` | None | Dead |
| `openEditor` | None | Dead |
| `startAreaCapture` (to `content.js`) | None | Dead |
| `ping` (to `content.js`) | None | Dead |

## Storage

| Key | Area | Shape | Read by |
| --- | --- | --- | --- |
| `captureHistory` | `storage.local` | Array (max 100) of `{ type, filename, timestamp, url? }` | Nothing. History is written but never shown. |

## Known defects

Line numbers refer to the original 1.0.1 files (first commit). Items marked **(verify)** come from code reading. Test them in Firefox before you fix them.

### Capture

1. **Full-page stitching is wrong on high-DPI screens.** The canvas uses CSS pixels but the captures use device pixels (`background.js:282`, `:296`). On a 2x screen, the output is cropped and misaligned.
2. **Full-page last segment overlaps.** The last `scrollTo` is clamped by the browser, but the image is drawn at `i * viewportHeight` (`background.js:296`). The bottom of the page is misaligned or repeated.
3. **Full-page capture is slow.** It waits 1500 ms per viewport (`background.js:264`). A 10-screen page takes more than 15 s.
4. **Sticky and fixed headers repeat** in each full-page segment. There is no code to hide them.
5. **Keyboard shortcut and the >30000 px fallback pass a `data:` URL to `downloads.download`** (`background.js:195`, `:244`). Firefox can refuse `data:` URLs there. The popup converts to a blob for this reason. **(verify)**
6. **`Ctrl+Shift+S` is also the Firefox built-in screenshot shortcut.** The two can conflict. **(verify)**
7. **Area and full-page files download from inside the web page** (`<a download>` injected in the page). Page CSP or download rules can block this. The page can also detect the injected link. **(verify)**
8. **Success notification shows before the file is saved.** The history filename timestamp also differs from the real filename (`background.js:163`, `:331`).
9. **Popup-injected overlay leaks an `Escape` key listener** on each use (`popup.js:229`).
10. **Area selection works only in the viewport.** You cannot scroll while you select.

### Recording

11. **Microphone stays on after stop when audio is mixed.** The original `micStream` tracks are never stopped (`recorder.js:81`, `:109`). The display audio track also stays live.
12. **System audio in Firefox.** `getDisplayMedia` audio support in Firefox is limited. The checkbox is on by default. **(verify)**
13. **No pause and resume, no countdown, no format choice.** Output is WebM only.
14. **Blocking `alert` after each save** (`recorder.js:377`).

### Editor

15. **Moving a layer erases annotations.** `redrawCanvas()` (`editor.js:231`) redraws only the original image plus layers. All drawn shapes and filters are lost.
16. **Undo and redo desync layers.** `restoreState()` (`editor.js:1474`) does not restore `currentImage` or `layers`. A later move or clear uses stale data.
17. **"Blur" is a 10 px pixelate**, not a blur (`editor.js:688`).
18. **Custom rotation clips the image.** Only 90 and 270 resize the canvas (`editor.js:882`).
19. **No direct path from capture to editor.** Captures go to Downloads. You must open the file in the editor by hand.
20. **Undo history uses up to 50 full PNG data URLs.** Memory use is high for large images.
21. **Many actions use `prompt`, `confirm` and `alert`.**

### Other

22. **Options page claims features that do not exist**: "Export as PNG or JPG with quality control" and "Chrome Extensions API" (`options.html:268`, `:287`).
23. **Donation links go to the original author's PayPal** (`popup.js`, `options.js`).
24. **Heavy `console.log` output** in all scripts.
25. **`web-ext lint` warnings**: missing `data_collection_permissions` key, unsafe `innerHTML` in `area-selector.js`.
26. **Manifest V2.** Firefox still supports MV2. A move to MV3 is optional.

## Lint baseline

`npm run lint` (web-ext 8) on `src/`: 0 errors, 1 warning, 1 notice.

- Warning `UNSAFE_VAR_ASSIGNMENT` (`area-selector.js:176`)
- Notice `MISSING_DATA_COLLECTION_PERMISSIONS` (manifest)

The signed XPI also gave `ALREADY_SIGNED`. This goes away because `src/` has no `META-INF/`.

## Status in 2.0.0

| # | Defect | Status |
| --- | --- | --- |
| 1-4 | Full-page HiDPI, overlap, speed, repeated headers | Fixed. `tabs.captureTab()` with `rect` renders the document directly, in tiles, at device pixel ratio. |
| 5 | `data:` URL to `downloads.download` | Fixed. All saves use blob URLs. |
| 6 | `Ctrl+Shift+S` conflict | Fixed. New defaults `Alt+Shift+A/S/F`. |
| 7 | Download from inside the web page | Fixed. The background page saves files. |
| 8 | Early notification, wrong history name | Fixed. Notification after save. History removed (nothing read it). |
| 9 | Leaked `Escape` listener | Fixed. `overlay.js` removes its listener. |
| 10 | Area selection only in viewport | Open. |
| 11 | Microphone stays on | Fixed. All tracks stop. |
| 12 | System audio in Firefox | Confirmed. Firefox gives no audio track. Option is off by default and the page explains it. |
| 13 | No pause, countdown, format choice | Fixed. |
| 14 | `alert` after save | Fixed. Inline result panel. |
| 15 | Layer move erases annotations | Fixed. |
| 16 | Undo desyncs layers | Fixed. |
| 17 | Blur is pixelate | Fixed. Gaussian blur. |
| 18 | Custom rotation clips | Fixed. |
| 19 | No capture-to-editor path | Fixed. Editor is the default after-capture action. |
| 20 | History memory | Improved. Canvas copies inside a 512 MB budget (very large images keep fewer undo steps). Revert decodes the compressed original instead of keeping a full-size copy. |
| 21 | `prompt`, `confirm`, `alert` | Open (some remain in the editor). |
| 22 | False feature claims | Fixed. New settings page. |
| 23 | Donation links | Removed. |
| 24 | Heavy logging | Fixed in rewritten files. |
| 25 | Lint warnings | Fixed. 0 warnings. |
| 26 | Manifest V2 | Open (still MV2, supported by Firefox). |

Also fixed in 2.0.0: highlight opacity build-up, duplicate text after a cancelled text dialog, double history step on crop, unfinished shape preview left on the canvas, pointer offset from the canvas border.

