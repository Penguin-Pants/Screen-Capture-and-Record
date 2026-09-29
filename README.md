# Screen Recorder

Firefox extension that records your screen, with your webcam and microphone, and saves small videos that are easy to share. All processing stays on your device.

For screenshots (full page, visible area, selected area, PNG, JPEG and PDF), use the companion extension [FullShot](https://github.com/Penguin-Pants/FullShot).

This project started from ScreenCapture Pro 1.0.1 (first commit of this repository). See [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md) for the analysis of the original.

## Features

**Record**
- Screen, window or tab, with optional microphone
- Optional webcam: you see yourself while you record, and your camera shows as a round bubble in a corner of the saved video
- Quality presets (resolution limit, frame rate, bitrate) with an estimate in MB per minute. Default: up to 1080p, 30 fps, about 15 MB per minute
- Live file size while recording; pause and resume; countdown; toolbar badge

**After recording** (a review screen, or "Save at once" in Settings)
- Choose where the camera bubble goes (any corner), its size, or hide it
- Save the recording as it is, or a smaller copy from a preset (High 1080p, Medium 720p, Small 480p, Tiny 360p), each with its estimated size
- WebM, or MP4 where the browser can encode H.264
- Saved files have a duration index, so video players can seek in them

**Permissions**
- Only `downloads` and `storage`. The extension cannot read the websites you visit. Firefox asks you before it shares your screen, camera or microphone.

## Requirements

- Firefox 130 or later (the camera bubble and smaller copies use the WebCodecs API)
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

Page tests run the extension pages in Chromium, served over a local HTTP server, with a stub of the Firefox `browser` API (`test/browser-stub.js`) and fake screen, camera and microphone streams. Set `CHROMIUM_PATH` if Chromium is not at the Playwright default path. Without Chromium, the page tests are skipped.

## Load the extension in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `src/manifest.json`.

A temporary add-on is removed when Firefox closes. To install it permanently, sign the build on [addons.mozilla.org](https://addons.mozilla.org/developers/) (unlisted is OK), or use Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to `false`.

The add-on ID is `screen-capture-and-record@penguin-pants`, from the earlier name of the extension (Screen Capture and Record). Keep it: Firefox and addons.mozilla.org use the ID to update installed copies.

## Manual test in Firefox

The automated tests run in Chromium. Do these checks in Firefox after a change to the recorder:

1. **Open:** click the toolbar button (or press `Alt+Shift+R`). The recorder opens. Click it again: the same tab comes to the front.
2. **Record:** tick **Include microphone**, record 10 s, pause and resume once, stop. The review screen opens. The microphone indicator in the Firefox address bar goes off.
3. **Size:** save a **Medium** copy. The file is smaller than the recording, and seeking works in a video player.
4. **Camera:** tick **Include camera**, allow the camera, record 10 s while you talk. After you stop, move the bubble to another corner, then save. The saved video shows you in that corner, in sync with your voice. The camera light goes off after you stop.
5. **Save at once:** in Settings, set **After recording** to **Save at once**. Record and stop: the file saves without the review step.

## Project layout

```
src/            Extension source (load this folder in Firefox)
  background.js   Toolbar button and recording badge
  common.js       Settings, presets, size estimates, file names, downloads
  recorder.*      Recorder page: record, review, camera bubble, export
  options.*       Settings page
  vendor/         Third-party code, unmodified (Mediabunny)
scripts/        Maintenance scripts (npm run vendor)
test/           Unit tests (Node) and page tests (Chromium)
docs/           Reverse-engineering report of the original extension
```

## Known limitations

- Firefox gives no system or tab audio to `getDisplayMedia`. Recordings can include the microphone only.
- The camera bubble is added when you save, so a video with the camera always takes a short export step.
- With the camera, **Full size** needs a video encoder that takes the full size of the recording. On a very large screen (for example 4K), some systems cannot do this. The review then turns off **Full size** and you choose a smaller size.
- Size estimates are approximate. Encoders can go a little above the target bitrate (estimates add 10%), and screens with little motion often make smaller files.

## Third-party code

- [Mediabunny](https://mediabunny.dev/) 1.61.0 (MPL-2.0) in `src/vendor/mediabunny`, copied unmodified from the npm package by `npm run vendor`. The recorder uses it to add a duration index to recordings, to draw the camera bubble and to make smaller copies.
