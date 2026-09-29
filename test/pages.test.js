// Page tests for the settings page and the background page, in Chromium
// with a stub of the Firefox "browser" API (test/browser-stub.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { skip, SRC, useBrowser } = require('./harness.js');

const openPage = useBrowser();

test('settings page shows the recording, camera and file settings and saves them', { skip }, async () => {
  const { page, context, errors } = await openPage('options.html');
  await page.waitForFunction(() => document.querySelectorAll('#shortcuts tr').length === 1);
  assert.equal(await page.inputValue('#profile'), 'high');
  assert.equal(await page.inputValue('#afterRecording'), 'review');
  assert.equal(await page.inputValue('#cameraPosition'), 'bottom-right');
  assert.equal(await page.inputValue('#cameraSize'), 'medium');
  const label = await page.$eval('#profile option[value="high"]', (option) => option.textContent);
  assert.equal(label, 'High: up to 1920 × 1080, 30 fps (about 15 MB per minute)');
  assert.match(await page.textContent('#shortcuts'), /Open the screen recorder\s*Alt\+Shift\+R/);

  await page.selectOption('#profile', 'small');
  await page.selectOption('#afterRecording', 'save');
  await page.selectOption('#cameraPosition', 'top-left');
  await page.selectOption('#cameraSize', 'large');
  await page.check('#saveAs');
  await page.fill('#downloadFolder', '../Videos:/2026');
  await page.press('#downloadFolder', 'Tab');
  await page.waitForFunction(() => window.__store['setting.downloadFolder'] === 'Videos/2026');
  const stored = await page.evaluate(() => window.__store);
  assert.deepEqual(stored, {
    'setting.profile': 'small',
    'setting.afterRecording': 'save',
    'setting.cameraPosition': 'top-left',
    'setting.cameraSize': 'large',
    'setting.saveAs': true,
    'setting.downloadFolder': 'Videos/2026'
  });
  assert.equal(await page.inputValue('#downloadFolder'), 'Videos/2026');
  assert.deepEqual(errors, []);
  await context.close();
});

test('settings saved at the same time do not overwrite each other', { skip }, async () => {
  const { page, context } = await openPage('options.html');
  const settings = await page.evaluate(async () => {
    await Promise.all([
      saveSettings({ profile: 'medium' }),
      saveSettings({ camera: true }),
      saveSettings({ downloadFolder: 'Clips' })
    ]);
    return getSettings();
  });
  assert.equal(settings.profile, 'medium');
  assert.equal(settings.camera, true);
  assert.equal(settings.downloadFolder, 'Clips');
  assert.equal(settings.afterRecording, 'review', 'unchanged settings keep their default');
  await context.close();
});

test('toolbar button shows the open recorder or opens a new one; badge follows the recording', { skip }, async () => {
  const { page, context, errors } = await openPage('options.html');
  await page.addScriptTag({ path: path.join(SRC, 'background.js') });
  const result = await page.evaluate(async () => {
    // No recorder open: a new tab.
    await openRecorder();
    const created = window.__calls.tabsCreated.map((options) => options.url);

    // A recorder is open: show it.
    let focused = 0;
    window.__views.push(
      { location: { pathname: '/options.html' } },
      { location: { pathname: '/recorder.html' }, focusRecorder: async () => { focused++; } }
    );
    browser.browserAction.onClicked.listeners[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const onMessage = browser.runtime.onMessage.listeners[0];
    onMessage({ action: 'recordingState', state: 'recording' }, { tab: { id: 5 } });
    onMessage({ action: 'recordingState', state: 'paused' }, { tab: { id: 5 } });
    browser.tabs.onRemoved.listeners[0](5);
    return { created, focused, badge: window.__calls.badge.map((item) => item.text) };
  });
  assert.equal(result.created.length, 1);
  assert.match(result.created[0], /recorder\.html$/);
  assert.equal(result.focused, 1);
  assert.deepEqual(result.badge, ['REC', '||', '']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('fast toolbar clicks open one recorder; a click while it loads shows that tab', { skip }, async () => {
  const { page, context, errors } = await openPage('options.html');
  await page.addScriptTag({ path: path.join(SRC, 'background.js') });
  const result = await page.evaluate(async () => {
    let nextId = 100;
    // A new tab gets its recorder page 20 ms after it opens, unless it goes to
    // another page first (window.__leavesAtOnce).
    browser.tabs.create = async (options) => {
      window.__calls.tabsCreated.push(options);
      const id = nextId++;
      if (!window.__leavesAtOnce) {
        setTimeout(() => window.__views.push({ __tabId: id, location: { pathname: '/recorder.html' } }), 20);
      }
      return { id };
    };
    const state = () => ({
      created: window.__calls.tabsCreated.length,
      shown: window.__calls.tabsUpdated.map((update) => update.id)
    });

    // Fast clicks: one tab (100). The other clicks wait for its page, then show the tab.
    const click = browser.browserAction.onClicked.listeners[0];
    click();
    click();
    await openRecorder(); // a third click, handled after the first two
    const fast = state();
    await new Promise((resolve) => setTimeout(resolve, 50)); // tab 100 has its page now

    // 5 s later, tab 100 still loads the recorder page: a click shows it.
    const now = Date.now;
    Date.now = () => now() + 5000;
    await openRecorder();
    const stillLoading = state();

    // Tab 100 left the recorder page before it loaded: a click opens a new recorder (101).
    window.__views.splice(window.__views.findIndex((view) => view.__tabId === 100), 1);
    window.__leavesAtOnce = true;
    await openRecorder();
    const left = state();

    // Tab 101 went to another page before its recorder page existed. A click in
    // its first second does not show it: it opens a new recorder (102).
    window.__leavesAtOnce = false;
    await openRecorder();
    const leftAtOnce = state();

    // The recorder page in tab 102 is ready: the page itself comes to the front.
    await new Promise((resolve) => setTimeout(resolve, 50));
    let focused = 0;
    const ready = window.__views.find((view) => view.__tabId === 102);
    if (ready) ready.focusRecorder = async () => { focused++; };
    await openRecorder();
    return { fast, stillLoading, left, leftAtOnce, ready: state(), focused };
  });
  assert.deepEqual(result.fast, { created: 1, shown: [100, 100] }, 'one recorder tab');
  assert.deepEqual(result.stillLoading, { created: 1, shown: [100, 100, 100] });
  assert.deepEqual(result.left, { created: 2, shown: [100, 100, 100] }, 'a tab that left the page is not shown');
  assert.deepEqual(result.leftAtOnce, { created: 3, shown: [100, 100, 100] }, 'not even in its first second');
  assert.deepEqual(result.ready, result.leftAtOnce);
  assert.equal(result.focused, 1);
  assert.deepEqual(errors, []);
  await context.close();
});
