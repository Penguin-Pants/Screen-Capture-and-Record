// Background page: the toolbar button opens the recorder, and the badge
// shows the recording state. It needs no tab or website permissions.
'use strict';

const RECORDER_PAGE = 'recorder.html';
// The tab that last reported a recording state, to clear the badge when it closes.
let recorderTabId = null;

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
  if (tabId === recorderTabId) {
    recorderTabId = null;
    setRecordingBadge('idle');
  }
});

// Show the open recorder tab, or open a new one. extension.getViews()
// lists only live pages of this extension, so a tab that navigated away
// is never picked.
async function openRecorder() {
  const views = browser.extension.getViews({ type: 'tab' });
  const recorder = views.find((view) => view.location.pathname.endsWith(`/${RECORDER_PAGE}`));
  if (recorder && typeof recorder.focusRecorder === 'function') {
    await recorder.focusRecorder();
    return;
  }
  await browser.tabs.create({ url: browser.runtime.getURL(RECORDER_PAGE) });
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
