// Background page: the toolbar button opens the recorder, and the badge
// shows the recording state. It needs no tab or website permissions.
'use strict';

const RECORDER_PAGE = 'recorder.html';
// The tab that last reported a recording state, to clear the badge when it closes.
let recorderTabId = null;
// The recorder tab this page opened last: { id, openedAt }. While its page
// loads, a click shows this tab instead of opening a second recorder.
let openedRecorder = null;
// Just after a tab opens, its page does not exist yet: a click waits up to
// this long for it (see showOrOpenRecorder).
const OPENING_MS = 1000;
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
  if (openedRecorder && tabId === openedRecorder.id) openedRecorder = null;
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
  // only when it has the recorder page (still loading). Just after the tab
  // opened, the page may not exist yet, so wait for it a moment. A tab that
  // left the page is not used.
  if (openedRecorder) {
    const { id, openedAt } = openedRecorder;
    let hasRecorder = hasRecorderPage(id);
    while (!hasRecorder && Date.now() < openedAt + OPENING_MS) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      hasRecorder = hasRecorderPage(id);
    }
    const tab = hasRecorder ? await browser.tabs.update(id, { active: true }).catch(() => null) : null;
    if (tab) {
      await browser.windows.update(tab.windowId, { focused: true });
      return;
    }
    openedRecorder = null;
  }
  const tab = await browser.tabs.create({ url: browser.runtime.getURL(RECORDER_PAGE) });
  openedRecorder = { id: tab.id, openedAt: Date.now() };
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
