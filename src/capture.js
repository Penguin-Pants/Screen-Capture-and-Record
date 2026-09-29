// Capture functions for the background page.
// Firefox 82+ can render any rectangle of the document with tabs.captureTab()
// (ImageDetails.rect and scale). This removes the need to scroll and stitch
// viewport screenshots, so fixed headers do not repeat and HiDPI is exact.
'use strict';

// Firefox canvas limits: 32767 px per side and about 500 MB per surface.
const CANVAS_MAX_SIDE = 32767;
const CANVAS_MAX_AREA = 120e6;
// Pixels rendered per captureTab() call. Smaller tiles use less memory.
const TILE_MAX_AREA = 16e6;

const PAGE_METRICS_CODE = `(() => {
  const root = document.documentElement;
  const body = document.body || root;
  return {
    width: Math.max(root.scrollWidth, body.scrollWidth, root.clientWidth),
    height: Math.max(root.scrollHeight, body.scrollHeight, root.clientHeight),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1
  };
})();`;

// Scroll through the page once so lazy images and infinite lists load,
// then go to the top so fixed and sticky elements show once, at the top.
const LOAD_LAZY_CONTENT_CODE = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const step = Math.max(200, window.innerHeight);
  const end = Math.min(document.documentElement.scrollHeight, step * 60);
  for (let y = 0; y < end; y += step) {
    window.scrollTo({ top: y, left: window.scrollX, behavior: 'instant' });
    await wait(100);
  }
  window.scrollTo({ top: 0, left: window.scrollX, behavior: 'instant' });
  await wait(300);
  return true;
})();`;

function scrollToCode(x, y) {
  return `window.scrollTo({ top: ${Number(y) || 0}, left: ${Number(x) || 0}, behavior: 'instant' });`;
}

// Decide the output scale and the capture tiles for a page of
// width x height CSS pixels. Pure function, so tests can run it in Node.
function planFullPage(width, height, dpr) {
  width = Math.max(1, Math.ceil(width));
  height = Math.max(1, Math.ceil(height));
  const scale = Math.min(
    dpr,
    CANVAS_MAX_SIDE / width,
    CANVAS_MAX_SIDE / height,
    Math.sqrt(CANVAS_MAX_AREA / (width * height))
  );
  const outWidth = Math.max(1, Math.floor(width * scale));
  const outHeight = Math.max(1, Math.floor(height * scale));
  const tileDeviceHeight = Math.max(256, Math.floor(TILE_MAX_AREA / outWidth));
  const tileCssHeight = Math.max(1, Math.floor(tileDeviceHeight / scale));

  const tiles = [];
  for (let y = 0; y < height; y += tileCssHeight) {
    const tileHeight = Math.min(tileCssHeight, height - y);
    // Round edges in device pixels so neighbor tiles share an edge (no gap).
    const top = Math.round(y * scale);
    const bottom = Math.min(outHeight, Math.round((y + tileHeight) * scale));
    tiles.push({ rect: { x: 0, y, width, height: tileHeight }, drawY: top, drawHeight: bottom - top });
  }
  return { scale, outWidth, outHeight, reduced: scale < dpr, tiles };
}

async function captureDataUrlToBlob(dataUrl) {
  if (!dataUrl) throw new Error('Firefox returned an empty capture.');
  return dataUrlToBlob(dataUrl);
}

async function captureVisible(tab) {
  const dataUrl = await browser.tabs.captureTab(tab.id, { format: 'png' });
  return { blob: await captureDataUrlToBlob(dataUrl), kind: 'screenshot' };
}

// rect is in document CSS pixels (scroll offset included).
async function captureRect(tab, rect, scale) {
  const dataUrl = await browser.tabs.captureTab(tab.id, {
    format: 'png',
    rect: {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    },
    scale
  });
  return { blob: await captureDataUrlToBlob(dataUrl), kind: 'area' };
}

async function captureFullPage(tab, { loadLazyContent = true } = {}) {
  const [before] = await browser.tabs.executeScript(tab.id, { code: PAGE_METRICS_CODE });
  if (loadLazyContent) {
    await browser.tabs.executeScript(tab.id, { code: LOAD_LAZY_CONTENT_CODE });
  } else {
    await browser.tabs.executeScript(tab.id, { code: scrollToCode(before.scrollX, 0) });
  }

  try {
    // Measure again: lazy content can make the page taller.
    const [page] = await browser.tabs.executeScript(tab.id, { code: PAGE_METRICS_CODE });
    const plan = planFullPage(page.width, page.height, page.dpr);

    const canvas = document.createElement('canvas');
    canvas.width = plan.outWidth;
    canvas.height = plan.outHeight;
    const ctx = canvas.getContext('2d');

    for (const tile of plan.tiles) {
      const dataUrl = await browser.tabs.captureTab(tab.id, { format: 'png', rect: tile.rect, scale: plan.scale });
      const bitmap = await createImageBitmap(await captureDataUrlToBlob(dataUrl));
      ctx.drawImage(bitmap, 0, tile.drawY, plan.outWidth, tile.drawHeight);
      bitmap.close();
    }

    const blob = await encodeCanvas(canvas, 'png');
    return { blob, kind: 'fullpage', reduced: plan.reduced };
  } finally {
    await browser.tabs.executeScript(tab.id, { code: scrollToCode(before.scrollX, before.scrollY) }).catch(() => {});
  }
}

if (typeof module !== 'undefined') {
  module.exports = { planFullPage, CANVAS_MAX_SIDE, CANVAS_MAX_AREA, TILE_MAX_AREA };
}
