// Page tests: run the extension pages in Chromium with a stub of the
// Firefox "browser" API (test/browser-stub.js). Firefox-only behavior
// (captureTab, notifications, real downloads) is not covered here.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

const SRC = path.join(__dirname, '..', 'src');
const STUB = path.join(__dirname, 'browser-stub.js');
const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
].filter(Boolean);
const executablePath = CHROMIUM_CANDIDATES.find((candidate) => fs.existsSync(candidate));
const skip = !chromium || !executablePath ? 'Chromium or playwright-core not available (set CHROMIUM_PATH)' : false;

const pageUrl = (file, query = '') => pathToFileURL(path.join(SRC, file)).href + query;

let browser;
test.before(async () => {
  if (skip) return;
  browser = await chromium.launch({ executablePath, args: ['--autoplay-policy=no-user-gesture-required'] });
});
test.after(async () => {
  if (browser) await browser.close();
});

async function openPage(file, query = '', init) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addInitScript({ path: STUB });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto(pageUrl(file, query));
  return { page, context, errors };
}

const pixel = (page, x, y) => page.evaluate(([px, py]) => Array.from(ctx.getImageData(px, py, 1, 1).data), [x, y]);

// Map canvas pixel coordinates to page coordinates for mouse events.
async function canvasPoint(page, x, y) {
  return page.evaluate(([px, py]) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + canvas.clientLeft + (px * canvas.clientWidth) / canvas.width,
      y: rect.top + canvas.clientTop + (py * canvas.clientHeight) / canvas.height
    };
  }, [x, y]);
}

async function drag(page, from, to, steps = 8) {
  const a = await canvasPoint(page, ...from);
  const b = await canvasPoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

async function openEditorWithCapture() {
  const opened = await openPage('editor.html', '?capture=abc');
  await opened.page.waitForFunction(() => canvas.style.display === 'block' && canvas.width === 400);
  return opened;
}

async function addGreenLayer(page) {
  await page.evaluate(async () => {
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = 50;
    layerCanvas.height = 50;
    const layerCtx = layerCanvas.getContext('2d');
    layerCtx.fillStyle = '#00ff00';
    layerCtx.fillRect(0, 0, 50, 50);
    const blob = await new Promise((resolve) => layerCanvas.toBlob(resolve));
    addImageLayer(new File([blob], 'layer.png', { type: 'image/png' }));
  });
  await page.waitForFunction(() => layers.length === 1);
}

test('editor opens a capture sent by the background page', { skip }, async () => {
  const { page, context, errors } = await openEditorWithCapture();
  assert.deepEqual(await pixel(page, 10, 10), [255, 0, 0, 255]);
  assert.deepEqual(await pixel(page, 390, 10), [0, 0, 255, 255]);
  const calls = await page.evaluate(() => window.__calls.messages);
  assert.deepEqual(calls[0], { action: 'getCapture', id: 'abc' });
  assert.deepEqual(errors, []);
  await context.close();
});

test('editor shows a message when the capture is gone', { skip }, async () => {
  const { page, context } = await openPage('editor.html', '?capture=missing');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('no longer available'));
  assert.equal(await page.evaluate(() => canvas.style.display), 'none');
  await context.close();
});

test('moving a layer keeps drawings made before the layer', { skip }, async () => {
  const { page, context, errors } = await openEditorWithCapture();
  // Draw a filled white rectangle at the top left.
  await page.click('#btnRectFilled');
  await page.evaluate(() => { currentColor = '#ffffff'; });
  await drag(page, [20, 20], [80, 80]);
  assert.deepEqual(await pixel(page, 50, 50), [255, 255, 255, 255]);

  // Add a layer (centered at 175..225) and move it to the right.
  await addGreenLayer(page);
  assert.deepEqual(await pixel(page, 200, 150), [0, 255, 0, 255]);
  await page.click('#btnMove');
  await drag(page, [200, 150], [300, 250]);

  assert.deepEqual(await pixel(page, 50, 50), [255, 255, 255, 255], 'drawing is still there');
  assert.deepEqual(await pixel(page, 300, 250), [0, 255, 0, 255], 'layer moved');
  assert.deepEqual(await pixel(page, 190, 150), [255, 0, 0, 255], 'old layer area shows the image again');

  // Undo returns the layer to its first place and keeps it movable.
  await page.click('#btnUndo');
  assert.deepEqual(await pixel(page, 200, 150), [0, 255, 0, 255]);
  assert.deepEqual(await pixel(page, 300, 250), [0, 0, 255, 255]);
  assert.equal(await page.evaluate(() => layers.length), 1);
  await drag(page, [200, 150], [100, 250]);
  assert.deepEqual(await pixel(page, 50, 50), [255, 255, 255, 255]);
  assert.deepEqual(await pixel(page, 100, 250), [0, 255, 0, 255]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('drawing after a layer merges the layer into the image', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await addGreenLayer(page);
  await page.click('#btnRect');
  await drag(page, [300, 20], [350, 60]);
  assert.equal(await page.evaluate(() => layers.length), 0);
  assert.deepEqual(await pixel(page, 200, 150), [0, 255, 0, 255]);
  await context.close();
});

test('blur mixes colors across an edge and pixelate makes blocks', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await page.click('#btnBlur');
  await drag(page, [150, 100], [250, 200]);
  const [r, , b] = await pixel(page, 200, 150);
  assert.ok(r > 40 && b > 40, `edge pixel is a mix of red and blue, got r=${r} b=${b}`);
  assert.deepEqual(await pixel(page, 100, 150), [255, 0, 0, 255], 'outside the area is unchanged');

  await page.click('#btnPixelate');
  await drag(page, [0, 0], [100, 100]);
  assert.deepEqual(await pixel(page, 5, 5), [255, 0, 0, 255]);
  await context.close();
});

test('rotation by any angle keeps the whole image', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await page.evaluate(() => rotateCanvas(45));
  const size = await page.evaluate(() => [canvas.width, canvas.height]);
  const expected = Math.round((400 + 300) * Math.SQRT1_2);
  assert.deepEqual(size, [expected, expected]);
  await page.evaluate(() => rotateCanvas(90));
  await page.click('#btnUndo');
  assert.deepEqual(await page.evaluate(() => [canvas.width, canvas.height]), [expected, expected]);
  await context.close();
});

test('highlight keeps the same transparency where the stroke overlaps', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await page.evaluate(() => { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 400, 300); saveState(); currentColor = '#000000'; });
  await page.click('#btnHighlight');
  const a = await canvasPoint(page, 50, 150);
  const b = await canvasPoint(page, 350, 150);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.move(a.x, a.y, { steps: 10 });
  }
  await page.mouse.up();
  const [value] = await pixel(page, 200, 150);
  // One pass at 0.35 alpha over white gives about 166.
  assert.ok(value > 150 && value < 180, `expected one layer of highlight, got ${value}`);
  await context.close();
});

test('text tool adds text once, at the last clicked point', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await page.click('#btnText');
  const first = await canvasPoint(page, 30, 60);
  await page.mouse.click(first.x, first.y);
  await page.click('#modalBackdrop', { position: { x: 5, y: 5 } });
  const second = await canvasPoint(page, 220, 200);
  await page.mouse.click(second.x, second.y);
  const before = await page.evaluate(() => history.length);
  await page.fill('#textInput', 'Hello');
  await page.press('#textInput', 'Enter');
  assert.equal(await page.evaluate(() => history.length), before + 1, 'one history step');
  const firstArea = await page.evaluate(() => Array.from(ctx.getImageData(25, 20, 80, 45).data).some((v, i) => i % 4 === 1 && v > 0));
  assert.equal(firstArea, false, 'no text at the first point');
  await context.close();
});

test('save uses the capture name and settings, copy uses PNG', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await page.click('#btnSave');
  await page.waitForFunction(() => window.__calls.downloads.length === 1);
  let download = await page.evaluate(() => window.__calls.downloads[0]);
  assert.equal(download.filename, 'area-test.png');
  assert.equal(download.type, 'image/png');
  assert.equal(download.saveAs, false);

  await page.evaluate(() => saveSettings({ imageFormat: 'jpeg', downloadFolder: 'Shots', jpegQuality: 80 }));
  await page.click('#btnSaveAs');
  await page.waitForFunction(() => window.__calls.downloads.length === 2);
  download = await page.evaluate(() => window.__calls.downloads[1]);
  assert.equal(download.filename, 'Shots/area-test.jpg');
  assert.equal(download.type, 'image/jpeg');
  assert.equal(download.saveAs, true);

  await page.keyboard.press('Control+c');
  await page.waitForFunction(() => window.__calls.clipboard.length === 1);
  assert.equal(await page.evaluate(() => window.__calls.clipboard[0].type), 'png');
  await context.close();
});

test('revert restores the original image and can be undone', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await page.evaluate(() => { rotateCanvas(90); window.confirm = () => true; });
  await page.click('#btnClear');
  assert.deepEqual(await page.evaluate(() => [canvas.width, canvas.height]), [400, 300]);
  await page.click('#btnUndo');
  assert.deepEqual(await page.evaluate(() => [canvas.width, canvas.height]), [300, 400]);
  await context.close();
});

test('zoom fits large images and 100% shows actual size', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await page.evaluate(() => resizeCanvas(4000, 3000));
  const fitWidth = await page.evaluate(() => canvas.clientWidth);
  assert.ok(fitWidth < 1400, `fit width ${fitWidth}`);
  await page.click('#btnZoomActual');
  assert.equal(await page.evaluate(() => canvas.clientWidth), 4000);
  // Drawing at 100% zoom maps to the right canvas pixel.
  await page.evaluate(() => { canvas.parentElement.scrollTo(0, 0); });
  await page.click('#btnRectFilled');
  await page.evaluate(() => { currentColor = '#00ff00'; });
  await drag(page, [100, 100], [140, 140]);
  assert.deepEqual(await pixel(page, 120, 120), [0, 255, 0, 255]);
  await context.close();
});

// Full-page stitching, with captureTab() replaced by a synthetic page:
// stripe n covers CSS y from n*100 to n*100+99 and has color n*10.
test('full-page capture stitches tiles at device pixel ratio without gaps', { skip }, async () => {
  const { page, context, errors } = await openPage('options.html');
  await page.addScriptTag({ path: path.join(SRC, 'capture.js') });
  const result = await page.evaluate(async () => {
    const cssWidth = 1200;
    const cssHeight = 9000;
    const dpr = 2;
    const scrolls = [];
    browser.tabs.executeScript = async (tabId, { code }) => {
      if (code.includes('scrollWidth')) return [{ width: cssWidth, height: cssHeight, scrollX: 0, scrollY: 1234, viewportHeight: 800, dpr }];
      scrolls.push(code);
      return [true];
    };
    const tileCalls = [];
    browser.tabs.captureTab = async (tabId, { rect, scale }) => {
      tileCalls.push({ ...rect, scale });
      const tile = document.createElement('canvas');
      tile.width = Math.round(rect.width * scale);
      tile.height = Math.round(rect.height * scale);
      const tctx = tile.getContext('2d');
      for (let y = rect.y; y < rect.y + rect.height; y++) {
        const stripe = Math.floor(y / 100);
        tctx.fillStyle = `rgb(${(stripe * 10) % 256}, 0, 0)`;
        tctx.fillRect(0, (y - rect.y) * scale, tile.width, scale);
      }
      return tile.toDataURL('image/png');
    };
    const { blob } = await captureFullPage({ id: 1 }, { loadLazyContent: true });
    const image = await blobToCanvas(blob);
    const ictx = image.getContext('2d');
    const samples = [];
    for (let cssY = 50; cssY < cssHeight; cssY += 100) {
      samples.push([cssY, ictx.getImageData(10, cssY * dpr, 1, 1).data[0]]);
    }
    const seams = tileCalls.slice(1).map((t) => ictx.getImageData(10, t.y * dpr, 1, 1).data[3]);
    return { width: image.width, height: image.height, tiles: tileCalls.length, samples, seams, lastScroll: scrolls[scrolls.length - 1] };
  });
  assert.equal(result.width, 2400);
  assert.equal(result.height, 18000);
  assert.ok(result.tiles > 1, 'the page needs more than one tile');
  for (const [cssY, red] of result.samples) {
    assert.equal(red, (Math.floor(cssY / 100) * 10) % 256, `stripe at CSS y=${cssY}`);
  }
  assert.ok(result.seams.every((alpha) => alpha === 255), 'no transparent seam between tiles');
  assert.match(result.lastScroll, /top: 1234/, 'scroll position is restored');
  assert.deepEqual(errors, []);
  await context.close();
});

test('options page saves settings and lists shortcuts', { skip }, async () => {
  const { page, context, errors } = await openPage('options.html');
  await page.waitForFunction(() => document.querySelectorAll('#shortcuts tr').length === 3);
  await page.selectOption('#afterCapture', 'clipboard');
  await page.selectOption('#imageFormat', 'jpeg');
  await page.fill('#downloadFolder', '../Shots:/2026');
  await page.press('#downloadFolder', 'Tab');
  await page.waitForFunction(() => window.__store.settings && window.__store.settings.downloadFolder === 'Shots/2026');
  const settings = await page.evaluate(() => window.__store.settings);
  assert.equal(settings.afterCapture, 'clipboard');
  assert.equal(settings.imageFormat, 'jpeg');
  assert.equal(await page.inputValue('#downloadFolder'), 'Shots/2026');
  assert.equal(await page.isDisabled('#jpegQuality'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('popup sends capture requests and disables them on protected pages', { skip }, async () => {
  let opened = await openPage('popup.html');
  await opened.page.waitForFunction(() => document.querySelector('[data-command="capture-area"]').textContent === 'Alt+Shift+A');
  await opened.page.evaluate(() => { window.close = () => {}; });
  await opened.page.click('[data-capture="fullpage"]');
  const messages = await opened.page.evaluate(() => window.__calls.messages);
  assert.deepEqual(messages.at(-1), { action: 'capture', mode: 'fullpage', tabId: 7 });
  await opened.context.close();

  opened = await openPage('popup.html', '', () => { window.__activeTabUrl = 'about:addons'; });
  await opened.page.waitForFunction(() => document.getElementById('restrictedNotice').classList.contains('show'));
  assert.equal(await opened.page.isDisabled('[data-capture="area"]'), true);
  assert.deepEqual(opened.errors, []);
  await opened.context.close();
});

// Fake screen and microphone streams: an animated canvas and an oscillator.
const fakeMedia = () => {
  window.__opened = [];
  navigator.mediaDevices.getDisplayMedia = async () => {
    const source = document.createElement('canvas');
    source.width = 320;
    source.height = 240;
    const sctx = source.getContext('2d');
    let frame = 0;
    setInterval(() => { sctx.fillStyle = `hsl(${frame++ * 10}, 80%, 50%)`; sctx.fillRect(0, 0, 320, 240); }, 30);
    const stream = source.captureStream(30);
    window.__opened.push(stream);
    return stream;
  };
  navigator.mediaDevices.getUserMedia = async () => {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    window.__opened.push(destination.stream);
    return destination.stream;
  };
};

test('recorder records, pauses, saves and stops every track', { skip }, async () => {
  const { page, context, errors } = await openPage('recorder.html', '', fakeMedia);
  await page.waitForFunction(() => document.getElementById('formatSelect').options.length > 0);
  await page.selectOption('#countdownSelect', '0');
  await page.check('#micCheck');
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  await page.waitForTimeout(1200);
  await page.click('#pauseBtn');
  assert.equal(await page.textContent('#recLabel'), 'Paused');
  const pausedAt = await page.textContent('#timer');
  await page.waitForTimeout(1200);
  assert.equal(await page.textContent('#timer'), pausedAt, 'timer stops while paused');
  await page.click('#pauseBtn');
  await page.waitForTimeout(800);
  await page.click('#stopBtn');
  await page.waitForFunction(() => window.__calls.downloads.length === 1);

  const download = await page.evaluate(() => window.__calls.downloads[0]);
  assert.match(download.filename, /^recording-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.(webm|mp4)$/);
  assert.ok(download.size > 1000, `recording has data (${download.size} bytes)`);
  const states = await page.evaluate(() => window.__calls.messages.filter((m) => m.action === 'recordingState').map((m) => m.state));
  assert.deepEqual(states, ['recording', 'paused', 'recording', 'idle']);
  const liveTracks = await page.evaluate(() => window.__opened.flatMap((s) => s.getTracks()).filter((t) => t.readyState !== 'ended').length);
  assert.equal(liveTracks, 0, 'screen and microphone tracks are stopped');
  assert.equal(await page.evaluate(() => document.getElementById('result').classList.contains('active')), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('recorder countdown can be cancelled by ending the share', { skip }, async () => {
  const { page, context } = await openPage('recorder.html', '', fakeMedia);
  await page.waitForFunction(() => document.getElementById('formatSelect').options.length > 0);
  await page.selectOption('#countdownSelect', '3');
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('countdown').classList.contains('active'));
  await page.click('#stopBtn', { force: true }).catch(() => {});
  await page.evaluate(() => stopRecording());
  await page.waitForFunction(() => !document.getElementById('countdown').classList.contains('active'));
  assert.equal(await page.evaluate(() => window.__calls.downloads.length), 0);
  const liveTracks = await page.evaluate(() => window.__opened.flatMap((s) => s.getTracks()).filter((t) => t.readyState !== 'ended').length);
  assert.equal(liveTracks, 0);
  await context.close();
});

test('remove background clears the edge color and smooths the cut edge', { skip }, async () => {
  const { page, context, errors } = await openEditorWithCapture();
  const result = await page.evaluate(() => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(100, 100, 100, 100);
    saveState();
    const start = performance.now();
    removeBackground(30);
    const alpha = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
    return { ms: performance.now() - start, bg: alpha(10, 10), inside: alpha(150, 150), edge: alpha(100, 150), corner: alpha(100, 100) };
  });
  assert.equal(result.bg, 0, 'background is transparent');
  assert.equal(result.inside, 255, 'object inside stays opaque');
  assert.ok(result.edge > 0 && result.edge < 255, `edge pixel has partial alpha, got ${result.edge}`);
  assert.ok(result.corner < result.edge, 'corner pixel is more transparent than a side pixel');
  assert.deepEqual(errors, []);
  await context.close();
});

test('full-page capture restores the scroll position when a step fails', { skip }, async () => {
  const { page, context } = await openPage('options.html');
  await page.addScriptTag({ path: path.join(SRC, 'capture.js') });
  const result = await page.evaluate(async () => {
    const codes = [];
    browser.tabs.executeScript = async (tabId, { code }) => {
      codes.push(code);
      if (code.includes('scrollWidth')) return [{ width: 800, height: 3000, scrollX: 0, scrollY: 777, viewportHeight: 600, dpr: 1 }];
      if (code.includes('innerHeight')) throw new Error('lazy pass failed');
      return [true];
    };
    browser.tabs.captureTab = async () => { throw new Error('should not capture'); };
    let message = '';
    try {
      await captureFullPage({ id: 1 }, { loadLazyContent: true });
    } catch (error) {
      message = error.message;
    }
    return { message, last: codes[codes.length - 1] };
  });
  assert.equal(result.message, 'lazy pass failed');
  assert.match(result.last, /top: 777/);
  await context.close();
});
