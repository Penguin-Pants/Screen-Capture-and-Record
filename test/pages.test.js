// Page tests for the editor, popup, options page and capture code. They run
// in Chromium with a stub of the Firefox "browser" API. Firefox-only
// behavior (captureTab, notifications, real downloads) is not covered here.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { skip, SRC, useBrowser } = require('./harness.js');

const openPage = useBrowser();

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
  await page.waitForFunction(() => canvas.width === 400 && canvas.height === 300 && history.length === 3);
  assert.deepEqual(await pixel(page, 10, 10), [255, 0, 0, 255], 'original pixels are back');
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

test('remove background with tolerance 0 removes the exact background color', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  const alpha = await page.evaluate(() => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(100, 100, 100, 100);
    removeBackground(0);
    return [ctx.getImageData(10, 10, 1, 1).data[3], ctx.getImageData(150, 150, 1, 1).data[3]];
  });
  assert.deepEqual(alpha, [0, 255]);
  await context.close();
});

test('undo history stays inside the memory budget', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  const stateBytes = 400 * 300 * 4;
  // Room for two states: one undo step.
  await page.evaluate((bytes) => { HISTORY_LIMITS.bytes = bytes; }, stateBytes * 2.5);
  await page.evaluate(() => { applyGrayscale(); applyInvert(); applySepia(); });
  let info = await page.evaluate(() => ({ length: history.length, step: historyStep, undo: btnUndo.disabled }));
  assert.deepEqual(info, { length: 2, step: 1, undo: false });

  // Room for less than two states: no undo, and the button says why.
  await page.evaluate((bytes) => { HISTORY_LIMITS.bytes = bytes; }, stateBytes * 1.5);
  await page.evaluate(() => applyInvert());
  info = await page.evaluate(() => ({ length: history.length, undo: btnUndo.disabled, title: btnUndo.title }));
  assert.equal(info.length, 1);
  assert.equal(info.undo, true);
  assert.match(info.title, /too large/);
  await context.close();
});

test('cancelling an adjustment keeps layers movable', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await addGreenLayer(page);
  await page.click('#btnBrightness');
  await page.evaluate(() => {
    const slider = document.getElementById('adjustSlider');
    slider.value = '80';
    slider.dispatchEvent(new Event('input'));
  });
  await page.click('#btnCancelAdjust');
  assert.equal(await page.evaluate(() => layers.length), 1);
  assert.deepEqual(await pixel(page, 10, 10), [255, 0, 0, 255], 'preview is undone');
  await page.click('#btnMove');
  await drag(page, [200, 150], [300, 250]);
  assert.deepEqual(await pixel(page, 300, 250), [0, 255, 0, 255], 'layer still moves');
  await context.close();
});

test('a backdrop click or Escape cancels the open adjustment', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  const preview = async () => {
    await page.click('#btnBrightness');
    await page.evaluate(() => {
      const slider = document.getElementById('adjustSlider');
      slider.value = '-100';
      slider.dispatchEvent(new Event('input'));
    });
  };
  const state = () => page.evaluate(() => ({
    slider: document.getElementById('sliderModal').classList.contains('active'),
    backdrop: document.getElementById('modalBackdrop').classList.contains('active')
  }));

  await preview();
  await page.click('#modalBackdrop', { position: { x: 5, y: 5 } });
  assert.deepEqual(await state(), { slider: false, backdrop: false });
  assert.deepEqual(await pixel(page, 10, 10), [255, 0, 0, 255]);

  await preview();
  await page.keyboard.press('Control+z');
  assert.deepEqual(await state(), { slider: true, backdrop: true }, 'shortcuts are ignored while the dialog is open');
  await page.keyboard.press('Escape');
  assert.deepEqual(await state(), { slider: false, backdrop: false });
  assert.deepEqual(await pixel(page, 10, 10), [255, 0, 0, 255]);
  await context.close();
});

test('resize keeps transparent pixels transparent', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  const alpha = await page.evaluate(() => {
    ctx.clearRect(0, 0, 100, 100);
    saveState();
    resizeCanvas(200, 150);
    return [ctx.getImageData(10, 10, 1, 1).data[3], ctx.getImageData(150, 100, 1, 1).data[3]];
  });
  assert.deepEqual(alpha, [0, 255]);
  await context.close();
});

test('a layer drag that leaves the canvas is saved in the history', { skip }, async () => {
  const { page, context } = await openEditorWithCapture();
  await addGreenLayer(page);
  await page.click('#btnMove');
  const from = await canvasPoint(page, 200, 150);
  const inside = await canvasPoint(page, 350, 150);
  const box = await page.evaluate(() => canvas.getBoundingClientRect().toJSON());
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(inside.x, inside.y, { steps: 5 });
  await page.mouse.move(box.right + 40, inside.y, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => ({ length: history.length, x: layers[0].x }));
  await page.click('#btnUndo');
  const undone = await page.evaluate(() => ({ layers: layers.length, x: layers[0] && layers[0].x }));
  assert.equal(undone.layers, 1, 'undo keeps the layer');
  assert.equal(undone.x, 175, 'undo returns the layer to its first place');
  assert.ok(after.x > 175);
  await context.close();
});

test('background drops a capture when the editor tab cannot open', { skip }, async () => {
  const { page, context, errors } = await openPage('options.html');
  for (const file of ['capture.js', 'background.js']) {
    await page.addScriptTag({ path: path.join(SRC, file) });
  }
  const result = await page.evaluate(async () => {
    browser.tabs.create = async () => { throw new Error('No such window'); };
    let message = '';
    try {
      await openInEditor(new Blob(['x'], { type: 'image/png' }), 'area-x', { id: 1, index: 0, windowId: 5 });
    } catch (error) {
      message = error.message;
    }
    return { message, size: captureStore.size };
  });
  assert.deepEqual(result, { message: 'No such window', size: 0 });
  assert.deepEqual(errors, []);
  await context.close();
});
