# Screen Capture and Record

Firefox extension for screenshots, screen recording and image annotation.

This project starts from **ScreenCapture Pro 1.0.1** (`screencapture-pro@extension.local`). The original source is in `src/` without changes. See [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md) for the architecture, message flow and known defects.

## Features (as imported)

- Capture the visible area, the full page or a selected area
- Record the screen, a window or a tab, with optional microphone
- Edit images: shapes, arrows, text, blur, pixelate, crop, filters and more

## Requirements

- Node.js 18 or later
- Firefox 109 or later

## Setup

```sh
npm install
```

## Commands

| Command | Action |
| --- | --- |
| `npm run lint` | Run `web-ext lint` on `src/` |
| `npm start` | Start Firefox with the extension loaded (`web-ext run`) |
| `npm run build` | Make an unsigned ZIP in `dist/` |

## Load the extension by hand

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `src/manifest.json`.

A temporary add-on is removed when Firefox closes. To install it permanently, sign the build on [addons.mozilla.org](https://addons.mozilla.org/developers/) (unlisted is OK), or use Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to `false`.

## Project layout

```
src/        Extension source (load this folder in Firefox)
docs/       Reverse-engineering report
dist/       Build output (not committed)
```
