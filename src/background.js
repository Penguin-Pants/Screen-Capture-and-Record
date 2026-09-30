// Background page: the toolbar button opens the recorder, and the badge
// shows the recording state. It needs no tab or website permissions.
'use strict';

const RECORDER_PAGE = 'recorder.html';
// The tab that last reported a recording state, to clear the badge when it closes.
let recorderTabId = null;
// The recorder tab this page opened last. While its page loads, a click
// shows this tab instead of opening a second recorder.
let openedRecorderId = null;
// While that tab still loads, a click waits up to this long for the
// recorder page in it (see waitForRecorderPage).
const LOADING_WAIT_MS = 5000;
// Toolbar clicks are handled one after the other (see openRecorder).
let openQueue = Promise.resolve();

browser.browserAction.onClicked.addListener(() => {
  openRecorder().catch((error) => console.error('Could not open the recorder:', error));
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (message && message.action === 'recordingState') {
    if (sender.tab) recorderTabId = sender.tab.id;
    setRecordingBadge(message.state);
  }
  return undefined;
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === openedRecorderId) openedRecorderId = null;
  if (tabId === recorderTabId) {
    recorderTabId = null;
    setRecordingBadge('idle');
  }
});

// Show the open recorder tab, or open a new one. Clicks wait for the one
// before, so fast clicks cannot open two recorders.
function openRecorder() {
  const run = openQueue.then(showOrOpenRecorder);
  openQueue = run.catch(() => {});
  return run;
}

const isRecorderView = (view) => view.location.pathname.endsWith(`/${RECORDER_PAGE}`);
const hasRecorderPage = (tabId) => browser.extension.getViews({ type: 'tab', tabId }).some(isRecorderView);

// extension.getViews() lists only live pages of this extension, so a tab
// that navigated away is never picked.
async function showOrOpenRecorder() {
  const recorder = browser.extension.getViews({ type: 'tab' }).find(isRecorderView);
  if (recorder && typeof recorder.focusRecorder === 'function') {
    await recorder.focusRecorder();
    return;
  }
  // No recorder page can show itself yet. Show the tab this page opened, but
  // only when it has the recorder page. A tab that loaded another page is
  // not used.
  if (openedRecorderId !== null && await waitForRecorderPage(openedRecorderId)) {
    const tab = await browser.tabs.update(openedRecorderId, { active: true }).catch(() => null);
    if (tab) {
      await browser.windows.update(tab.windowId, { focused: true });
      return;
    }
  }
  const tab = await browser.tabs.create({ url: browser.runtime.getURL(RECORDER_PAGE) });
  openedRecorderId = tab.id;
}

// True when the tab has the recorder page. While the tab still loads, its
// page may not exist yet (the tab URL is not visible without the "tabs"
// permission), so wait for it, up to LOADING_WAIT_MS.
async function waitForRecorderPage(tabId) {
  const until = Date.now() + LOADING_WAIT_MS;
  while (!hasRecorderPage(tabId)) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    // Closed, loaded, or too slow. Check once more: the page can be new.
    if (!tab || tab.status !== 'loading' || Date.now() >= until) return hasRecorderPage(tabId);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function setRecordingBadge(state) {
  const badges = {
    recording: { text: 'REC', color: '#F04444' },
    paused: { text: '||', color: '#6b6b6b' },
    idle: { text: '', color: '#6b6b6b' }
  };
  const badge = badges[state] || badges.idle;
  browser.browserAction.setBadgeText({ text: badge.text });
  browser.browserAction.setBadgeBackgroundColor({ color: badge.color });
}
