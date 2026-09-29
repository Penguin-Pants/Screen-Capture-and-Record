// Background page: the toolbar button opens the recorder, and the badge
// shows the recording state. It needs no tab or website permissions.
'use strict';

const RECORDER_PAGE = 'recorder.html';
// The tab that last reported a recording state, to clear the badge when it closes.
let recorderTabId = null;
// The recorder tab this page opened, until its page has loaded. A click in
// that time shows this tab instead of opening a second recorder.
let loadingRecorderTabId = null;
// Toolbar clicks are handled one after the other (see openRecorder).
let openQueue = Promise.resolve();

browser.browserAction.onClicked.addListener(() => {
  openRecorder().catch((error) => console.error('Could not open the recorder:', error));
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === loadingRecorderTabId && changeInfo.status === 'complete') loadingRecorderTabId = null;
});

browser.runtime.onMessage.addListener((message, sender) => {
  if (message && message.action === 'recordingState') {
    if (sender.tab) recorderTabId = sender.tab.id;
    setRecordingBadge(message.state);
  }
  return undefined;
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === loadingRecorderTabId) loadingRecorderTabId = null;
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

// extension.getViews() lists only live pages of this extension, so a tab
// that navigated away is never picked.
async function showOrOpenRecorder() {
  const views = browser.extension.getViews({ type: 'tab' });
  const recorder = views.find((view) => view.location.pathname.endsWith(`/${RECORDER_PAGE}`));
  if (recorder && typeof recorder.focusRecorder === 'function') {
    await recorder.focusRecorder();
    return;
  }
  // The recorder tab is still loading (its page cannot show itself yet).
  if (loadingRecorderTabId !== null) {
    const tab = await browser.tabs.update(loadingRecorderTabId, { active: true }).catch(() => null);
    if (tab) {
      await browser.windows.update(tab.windowId, { focused: true });
      return;
    }
    loadingRecorderTabId = null;
  }
  const tab = await browser.tabs.create({ url: browser.runtime.getURL(RECORDER_PAGE) });
  loadingRecorderTabId = tab.id;
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
