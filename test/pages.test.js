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
    // Fake tabs. A new tab loads, then it has the recorder page after `page` ms,
    // or it has another page after `other` ms (plans in window.__plans).
    const tabs = new Map();
    let nextId = 100;
    window.__plans = [];
    browser.tabs.create = async (options) => {
      window.__calls.tabsCreated.push(options);
      const tab = { id: nextId++, windowId: 3, status: 'loading' };
      tabs.set(tab.id, tab);
      const plan = window.__plans.shift() || { page: 20 };
      setTimeout(() => {
        if (plan.page !== undefined) window.__views.push({ __tabId: tab.id, location: { pathname: '/recorder.html' } });
        tab.status = 'complete';
      }, plan.page ?? plan.other);
      return { id: tab.id };
    };
    browser.tabs.get = async (id) => {
      if (!tabs.has(id)) throw new Error(`Invalid tab ID: ${id}`);
      return { ...tabs.get(id) };
    };
    const close = (id) => {
      tabs.delete(id);
      window.__views = window.__views.filter((view) => view.__tabId !== id);
      browser.tabs.onRemoved.listeners.forEach((listener) => listener(id));
    };
    const state = () => ({
      created: window.__calls.tabsCreated.length,
      shown: window.__calls.tabsUpdated.map((update) => update.id)
    });
    const click = browser.browserAction.onClicked.listeners[0];

    // Fast clicks: one tab (100). The other clicks wait for its page, then show the tab.
    click();
    click();
    await openRecorder(); // a third click, handled after the first two
    const fast = state();

    // A slow recorder page (1.5 s): a fast second click still waits for it (tab 101).
    close(100);
    window.__plans = [{ page: 1500 }];
    click();
    await openRecorder();
    const slow = state();

    // A new tab (102) loads another page: a click does not show it, and opens a new recorder (103).
    close(101);
    window.__plans = [{ other: 200 }];
    click();
    await openRecorder();
    const other = state();

    // The recorder page in tab 103 is ready: the page itself comes to the front.
    await new Promise((resolve) => setTimeout(resolve, 50));
    let focused = 0;
    const ready = window.__views.find((view) => view.__tabId === 103);
    if (ready) ready.focusRecorder = async () => { focused++; };
    await openRecorder();
    return { fast, slow, other, ready: state(), focused };
  });
  assert.deepEqual(result.fast, { created: 1, shown: [100, 100] }, 'one recorder tab');
  assert.deepEqual(result.slow, { created: 2, shown: [100, 100, 101] }, 'no second tab for a slow page');
  assert.deepEqual(result.other, { created: 4, shown: [100, 100, 101] }, 'a tab with another page is not shown');
  assert.deepEqual(result.ready, result.other);
  assert.equal(result.focused, 1);
  assert.deepEqual(errors, []);
  await context.close();
});
