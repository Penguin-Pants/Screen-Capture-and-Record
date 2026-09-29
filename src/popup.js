// Toolbar popup. The background page does all capture work, so the popup
// can close at once.
'use strict';

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const tab = await getActiveTab();

  if (tab && isRestrictedUrl(tab.url)) {
    document.querySelectorAll('[data-capture]').forEach((button) => { button.disabled = true; });
    document.getElementById('restrictedNotice').classList.add('show');
  }

  document.querySelectorAll('[data-capture]').forEach((button) => {
    button.addEventListener('click', async () => {
      await browser.runtime.sendMessage({ action: 'capture', mode: button.dataset.capture, tabId: tab.id });
      window.close();
    });
  });

  const commands = await browser.commands.getAll();
  for (const command of commands) {
    const chip = document.querySelector(`.shortcut[data-command="${command.name}"]`);
    if (chip) chip.textContent = command.shortcut || '';
  }

  const afterCapture = document.getElementById('afterCapture');
  afterCapture.value = (await getSettings()).afterCapture;
  afterCapture.addEventListener('change', () => saveSettings({ afterCapture: afterCapture.value }));
}

document.getElementById('startRecording').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ action: 'openRecorder' });
  window.close();
});

document.getElementById('openEditor').addEventListener('click', async () => {
  await browser.tabs.create({ url: 'editor.html' });
  window.close();
});

document.getElementById('openFolder').addEventListener('click', () => {
  browser.downloads.showDefaultFolder();
  window.close();
});

document.getElementById('openOptions').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

init();
