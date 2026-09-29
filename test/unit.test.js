'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planFullPage, CANVAS_MAX_SIDE, CANVAS_MAX_AREA, TILE_MAX_AREA } = require('../src/capture.js');
const { sanitizeFolder, buildFilename, fileTimestamp, extensionForMimeType, isRestrictedUrl } = require('../src/common.js');

function assertTilesCover(plan, cssHeight) {
  let cssY = 0;
  let deviceY = 0;
  for (const tile of plan.tiles) {
    assert.equal(tile.rect.y, cssY, 'tiles are contiguous in CSS pixels');
    assert.equal(tile.drawY, deviceY, 'tiles are contiguous in device pixels');
    assert.ok(tile.rect.width * plan.scale * tile.rect.height * plan.scale <= TILE_MAX_AREA * 1.05, 'tile fits the area budget');
    cssY += tile.rect.height;
    deviceY += tile.drawHeight;
  }
  assert.equal(cssY, cssHeight, 'tiles cover the full CSS height');
  assert.equal(deviceY, plan.outHeight, 'tiles cover the full output height');
}

test('planFullPage keeps device pixel ratio for normal pages', () => {
  const plan = planFullPage(1280, 5000, 2);
  assert.equal(plan.scale, 2);
  assert.equal(plan.reduced, false);
  assert.equal(plan.outWidth, 2560);
  assert.equal(plan.outHeight, 10000);
  assertTilesCover(plan, 5000);
});

test('planFullPage handles fractional device pixel ratio without gaps', () => {
  const plan = planFullPage(1366, 7777, 1.25);
  assertTilesCover(plan, 7777);
});

test('planFullPage scales down pages above the canvas side limit', () => {
  const plan = planFullPage(1280, 60000, 1);
  assert.ok(plan.reduced);
  assert.ok(plan.outHeight <= CANVAS_MAX_SIDE);
  assert.ok(plan.outWidth * plan.outHeight <= CANVAS_MAX_AREA);
  assertTilesCover(plan, 60000);
});

test('planFullPage scales down pages above the canvas area limit', () => {
  const plan = planFullPage(8000, 20000, 1);
  assert.ok(plan.reduced);
  assert.ok(plan.outWidth * plan.outHeight <= CANVAS_MAX_AREA);
  assertTilesCover(plan, 20000);
});

test('planFullPage handles a page smaller than one tile', () => {
  const plan = planFullPage(300, 200, 1);
  assert.equal(plan.tiles.length, 1);
  assertTilesCover(plan, 200);
});

test('sanitizeFolder removes unsafe parts', () => {
  assert.equal(sanitizeFolder(''), '');
  assert.equal(sanitizeFolder('Screenshots'), 'Screenshots');
  assert.equal(sanitizeFolder('/a//b/'), 'a/b');
  assert.equal(sanitizeFolder('..\\..\\etc'), 'etc');
  assert.equal(sanitizeFolder('bad:name?*'), 'badname');
  assert.equal(sanitizeFolder('  . / x '), 'x');
});

test('buildFilename joins folder, name and extension', () => {
  assert.equal(buildFilename('area-1', 'png', ''), 'area-1.png');
  assert.equal(buildFilename('area-1', 'jpg', 'Shots/2026'), 'Shots/2026/area-1.jpg');
});

test('fileTimestamp uses local time and safe characters', () => {
  assert.equal(fileTimestamp(new Date(2026, 8, 29, 7, 5, 3)), '2026-09-29_07-05-03');
});

test('extensionForMimeType maps image and video types', () => {
  assert.equal(extensionForMimeType('image/png'), 'png');
  assert.equal(extensionForMimeType('image/jpeg'), 'jpg');
  assert.equal(extensionForMimeType('video/webm;codecs=vp9,opus'), 'webm');
  assert.equal(extensionForMimeType('video/mp4;codecs=avc1'), 'mp4');
});

test('isRestrictedUrl flags pages Firefox protects', () => {
  assert.ok(isRestrictedUrl('about:addons'));
  assert.ok(isRestrictedUrl('moz-extension://abc/editor.html'));
  assert.ok(isRestrictedUrl('https://addons.mozilla.org/en-US/firefox/'));
  assert.ok(!isRestrictedUrl('https://example.com/'));
  assert.ok(!isRestrictedUrl(undefined));
});
