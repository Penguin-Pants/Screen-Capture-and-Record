// Shared setup for the page tests: a local HTTP server for the repository
// and one Chromium instance per test file. The extension pages run with a
// stub of the Firefox "browser" API (test/browser-stub.js).
'use strict';

const test = require('node:test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const STUB = path.join(__dirname, 'browser-stub.js');
const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
].filter(Boolean);
const executablePath = CHROMIUM_CANDIDATES.find((candidate) => fs.existsSync(candidate));
const skip = !chromium || !executablePath ? 'Chromium or playwright-core not available (set CHROMIUM_PATH)' : false;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

// Chromium does not load ES modules (the vendored library) from file://
// pages, so the tests use HTTP.
function startServer() {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Registers before/after hooks and returns openPage().
function useBrowser() {
  let browser = null;
  let server = null;
  let base = '';

  test.before(async () => {
    if (skip) return;
    server = await startServer();
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath, args: ['--autoplay-policy=no-user-gesture-required'] });
  });
  test.after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  // init: optional function (or list of functions) that runs in the page
  // before its own scripts.
  return async function openPage(file, query = '', init) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript({ path: STUB });
    for (const script of [].concat(init || [])) await context.addInitScript(script);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error));
    await page.goto(`${base}/src/${file}${query}`);
    return { page, context, errors };
  };
}

module.exports = { skip, SRC, useBrowser };
