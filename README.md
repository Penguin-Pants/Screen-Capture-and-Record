# Screen Capture and Record

Firefox extension for screenshots, screen recording and image annotation. All processing stays on your device.

Based on ScreenCapture Pro 1.0.1. The original source is in the first commit of this repository. See [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md) for the analysis of the original and the status of each defect.

## Features

**Capture**
- Selected area, visible area or full page
- Full page renders the document directly (no scrolling and stitching), at full screen resolution
- Keyboard shortcuts: `Alt+Shift+A` area, `Alt+Shift+S` visible, `Alt+Shift+F` full page

**After capture** (choose in the popup or in Settings)
- Open in the editor (default)
- Save to the Downloads folder (PNG or JPEG, optional subfolder, optional Save As dialog)
- Copy to the clipboard

**Editor**
- Shapes, arrows, text, highlight, blur, pixelate, crop, resize, rotate, filters, image layers
- Save, Save As, Copy, zoom, undo and redo

**Recorder**
- Screen, window or tab, with optional microphone
- Quality presets (resolution limit, frame rate, bitrate) with an estimate in MB per minute
- Live file size while recording; pause and resume; countdown; toolbar badge
- After recording, a review screen: save the recording as it is, or a smaller copy from a preset (each with its estimated size), as WebM or MP4 where the browser can encode it
- Settings: default quality, and "review first" or "save at once"

## Requirements

- Firefox 115 or later
- Node.js 18 or later (development only)

## Setup

```sh
npm install
```

## Commands

| Command | Action |
| --- | --- |
| `npm test` | Unit tests and page tests (page tests need Chromium, see below) |
| `npm run lint` | Run `web-ext lint` on `src/` |
| `npm start` | Start Firefox with the extension loaded (`web-ext run`) |
| `npm run build` | Make an unsigned ZIP in `dist/` |
| `npm run vendor` | Copy third-party browser code from `node_modules` to `src/vendor` |

Page tests run the extension pages in Chromium with a stub of the Firefox `browser` API (`test/browser-stub.js`). Set `CHROMIUM_PATH` if Chromium is not at the Playwright default path. Without Chromium, the page tests are skipped.

## Load the extension in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `src/manifest.json`.

A temporary add-on is removed when Firefox closes. To install it permanently, sign the build on [addons.mozilla.org](https://addons.mozilla.org/developers/) (unlisted is OK), or use Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to `false`.

## Manual test in Firefox

The automated tests cannot call Firefox-only APIs (`tabs.captureTab`, notifications, real downloads, clipboard). Do these checks after each change to the capture code:

1. **Area:** click the toolbar icon, then **Selected area**. Drag a box. The editor opens with the exact area. Press `Esc` during selection to cancel.
2. **Visible:** press `Alt+Shift+S`. The editor opens with the visible area.
3. **Full page:** open a long page (for example a Wikipedia article). Press `Alt+Shift+F`. Check that the header shows once, the bottom is not repeated and text is sharp on a HiDPI screen.
4. **Save to Downloads:** in the popup, set **After capture** to **Save to Downloads**. Capture. A notification shows. Click it to show the file.
5. **Clipboard:** set **After capture** to **Copy to clipboard**. Capture, then paste in another app.
6. **Recorder:** record 10 s with the microphone, pause and resume once, stop. The review screen opens and the microphone indicator in the Firefox address bar goes off. Save a "Medium" copy: the file is smaller than the recording and seeking works in a video player.
7. **Protected page:** open `about:addons`. The popup capture buttons are disabled.

## Project layout

```
src/            Extension source (load this folder in Firefox)
  background.js   Message router, shortcuts, capture delivery, badge
  capture.js      Visible, area and full-page capture (tabs.captureTab)
  common.js       Settings, file names, encoding, downloads, clipboard
  overlay.js      Area selection overlay (injected on demand)
  popup.*         Toolbar popup
  editor.*        Image editor
  recorder.*      Screen recorder
  options.*       Settings page
  vendor/         Third-party code, unmodified (Mediabunny)
scripts/        Maintenance scripts (npm run vendor)
test/           Unit tests (Node) and page tests (Chromium, served over local HTTP)
docs/           Reverse-engineering report
```

## Known limitations

- Firefox gives no system or tab audio to `getDisplayMedia`. Recordings can include the microphone only.
- Smaller copies need the WebCodecs API (Firefox 130 or later). Older versions can save the recording as it is.
- Size estimates are approximate. Encoders can go a little above the target bitrate (estimates add 10%), and screens with little motion often make smaller files.
- Full page captures the main document scroll. Pages that scroll inside an inner element capture only the visible part of that element.

## Third-party code

- [Mediabunny](https://mediabunny.dev/) 1.61.0 (MPL-2.0) in `src/vendor/mediabunny`, copied unmodified from the npm package by `npm run vendor`. The recorder uses it to add a duration index to recordings and to make smaller copies.
