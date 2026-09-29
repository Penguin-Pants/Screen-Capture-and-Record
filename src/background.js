// Background page: message router, keyboard commands, capture delivery
// and the recording badge. Loads after common.js and capture.js.
'use strict';

const CAPTURE_TTL_MS = 10 * 60 * 1000;
const EDITOR_URL = browser.runtime.getURL('editor.html');
const RECORDER_URL = browser.runtime.getURL('recorder.html');

// Captures waiting for (or shown in) an editor tab: id -> { blob, name, created, editorTabId }
const captureStore = new Map();
// Notification ID -> download ID, so a click on the notification shows the file.
const notificationDownloads = new Map();
let recorderTabId = null;

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message && message.action) {
    case 'capture':
      // Answer at once so the popup can close. The capture runs on here.
      runCapture(message.mode, message.tabId);
      return Promise.resolve({ ok: true });
    case 'areaSelected':
      if (sender.tab) captureArea(sender.tab, message.rect, message.scale);
      return undefined;
    case 'getCapture':
      return getCapture(message.id, sender.tab);
    case 'openRecorder':
      return openRecorder();
    case 'recordingState':
      if (sender.tab) recorderTabId = sender.tab.id;
      setRecordingBadge(message.state);
      return undefined;
    default:
      return undefined;
  }
});

browser.commands.onCommand.addListener((command) => {
  const modes = { 'capture-visible': 'visible', 'capture-fullpage': 'fullpage', 'capture-area': 'area' };
  if (modes[command]) runCapture(modes[command]);
});

browser.tabs.onRemoved.addListener((tabId) => {
  for (const [id, entry] of captureStore) {
    if (entry.editorTabId === tabId) captureStore.delete(id);
  }
  if (tabId === recorderTabId) {
    recorderTabId = null;
    setRecordingBadge('idle');
  }
});

browser.notifications.onClicked.addListener((notificationId) => {
  const downloadId = notificationDownloads.get(notificationId);
  if (downloadId !== undefined) browser.downloads.show(downloadId).catch(() => {});
});

browser.notifications.onClosed.addListener((notificationId) => {
  notificationDownloads.delete(notificationId);
});

async function getTargetTab(tabId) {
  if (tabId !== undefined) return browser.tabs.get(tabId);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function describeError(error, tab) {
  if (tab && isRestrictedUrl(tab.url)) {
    return 'Firefox does not let extensions capture this page. Try a normal web page.';
  }
  if (/permission|cannot access|scripted/i.test(error.message)) {
    return 'Firefox does not let extensions access this page. Try a normal web page.';
  }
  return error.message || String(error);
}

async function runCapture(mode, tabId) {
  let tab;
  try {
    tab = await getTargetTab(tabId);
    if (mode === 'area') {
      await browser.tabs.executeScript(tab.id, { file: '/overlay.js' });
      return; // overlay.js sends "areaSelected" when the selection is done.
    }
    const settings = await getSettings();
    let result;
    if (mode === 'fullpage') {
      result = await captureFullPage(tab, { loadLazyContent: settings.loadLazyContent });
    } else {
      result = await captureVisible(tab);
    }
    await deliver(result, tab, settings);
  } catch (error) {
    console.error('Capture failed:', error);
    notify('Capture failed', describeError(error, tab));
  }
}

async function captureArea(tab, rect, scale) {
  try {
    const result = await captureRect(tab, rect, scale);
    await deliver(result, tab, await getSettings());
  } catch (error) {
    console.error('Area capture failed:', error);
    notify('Capture failed', describeError(error, tab));
  }
}

async function deliver({ blob, kind, reduced }, tab, settings) {
  const name = `${kind}-${fileTimestamp()}`;
  if (reduced) {
    notify('Page is very large', 'The full-page image was scaled down to fit the browser canvas limit.');
  }

  if (settings.afterCapture === 'clipboard') {
    await copyImageBlob(blob);
    notify('Copied to clipboard', 'Paste the image where you need it.');
    return;
  }

  if (settings.afterCapture === 'download') {
    let output = blob;
    if (settings.imageFormat === 'jpeg') {
      output = await encodeCanvas(await blobToCanvas(blob), 'jpeg', settings.jpegQuality);
    }
    const filename = buildFilename(name, extensionForMimeType(output.type), settings.downloadFolder);
    const downloadId = await downloadBlob(output, filename, settings.saveAs);
    if (downloadId !== null) {
      const notificationId = await notify('Screenshot saved', `${filename}\nClick to show the file.`);
      if (notificationId) notificationDownloads.set(notificationId, downloadId);
    }
    return;
  }

  await openInEditor(blob, name, tab);
}

async function openInEditor(blob, name, tab) {
  sweepCaptureStore();
  const id = crypto.randomUUID();
  captureStore.set(id, { blob, name, created: Date.now(), editorTabId: null });
  const created = await browser.tabs.create({
    url: `${EDITOR_URL}?capture=${id}`,
    windowId: tab.windowId,
    index: tab.index + 1,
    openerTabId: tab.id
  });
  const entry = captureStore.get(id);
  if (entry) entry.editorTabId = created.id;
}

async function getCapture(id, senderTab) {
  const entry = captureStore.get(id);
  if (!entry) return null;
  if (senderTab) entry.editorTabId = senderTab.id;
  return { name: entry.name, dataUrl: await blobToDataUrl(entry.blob) };
}

// Drop captures whose editor tab never opened.
function sweepCaptureStore() {
  const now = Date.now();
  for (const [id, entry] of captureStore) {
    if (entry.editorTabId === null && now - entry.created > CAPTURE_TTL_MS) captureStore.delete(id);
  }
}

async function openRecorder() {
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url && t.url.startsWith(RECORDER_URL));
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: RECORDER_URL });
  }
  return { ok: true };
}

function setRecordingBadge(state) {
  const badges = {
    recording: { text: 'REC', color: '#d93025' },
    paused: { text: '||', color: '#6b6b6b' },
    idle: { text: '', color: '#6b6b6b' }
  };
  const badge = badges[state] || badges.idle;
  browser.browserAction.setBadgeText({ text: badge.text });
  browser.browserAction.setBadgeBackgroundColor({ color: badge.color });
}

async function notify(title, message) {
  try {
    return await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon96.png'),
      title,
      message
    });
  } catch (error) {
    console.warn(`${title}: ${message}`);
    return null;
  }
}
