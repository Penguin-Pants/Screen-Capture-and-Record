// Settings page. Each control saves at once.
'use strict';

const savedBadge = document.getElementById('saved');
let savedTimer = null;

function showSaved() {
  savedBadge.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedBadge.classList.remove('show'), 1200);
}

function updateJpegControls(format) {
  document.getElementById('jpegQuality').disabled = format !== 'jpeg';
}

async function init() {
  const settings = await getSettings();

  const bindings = {
    afterCapture: 'value',
    imageFormat: 'value',
    jpegQuality: 'value',
    downloadFolder: 'value',
    saveAs: 'checked',
    loadLazyContent: 'checked'
  };

  for (const [key, property] of Object.entries(bindings)) {
    const input = document.getElementById(key);
    input[property] = settings[key];
    const eventName = input.type === 'text' ? 'change' : 'input';
    input.addEventListener(eventName, async () => {
      let value = input[property];
      if (key === 'jpegQuality') value = Number(value);
      if (key === 'downloadFolder') {
        value = sanitizeFolder(value);
        input.value = value;
      }
      await saveSettings({ [key]: value });
      if (key === 'imageFormat') updateJpegControls(value);
      if (key === 'jpegQuality') document.getElementById('jpegQualityValue').textContent = value;
      showSaved();
    });
  }

  document.getElementById('jpegQualityValue').textContent = settings.jpegQuality;
  updateJpegControls(settings.imageFormat);

  await initRecordingOptions();

  const table = document.getElementById('shortcuts');
  for (const command of await browser.commands.getAll()) {
    const row = table.insertRow();
    row.insertCell().textContent = command.description || command.name;
    const keyCell = row.insertCell();
    if (command.shortcut) {
      const kbd = document.createElement('kbd');
      kbd.textContent = command.shortcut;
      keyCell.append(kbd);
    } else {
      keyCell.textContent = 'Not set';
    }
  }
}

// Recording defaults live with the recorder settings, so the recorder page
// and this page change the same values.
async function initRecordingOptions() {
  const recorder = await getRecorderSettings();
  const profile = document.getElementById('recordingProfile');
  for (const item of RECORDING_PROFILES) {
    const size = item.maxWidth ? `up to ${item.maxWidth} \u00d7 ${item.maxHeight}` : 'full screen size';
    const perMinute = formatBytes(bytesPerMinute(item, VOICE_AUDIO_BITS_PER_SECOND));
    profile.add(new Option(`${item.label}: ${size}, ${item.frameRate} fps (about ${perMinute} per minute)`, item.id));
  }
  profile.value = getRecordingProfile(recorder.profile).id;
  const afterRecording = document.getElementById('afterRecording');
  afterRecording.value = recorder.afterRecording;

  profile.addEventListener('input', async () => {
    await saveRecorderSettings({ profile: profile.value });
    showSaved();
  });
  afterRecording.addEventListener('input', async () => {
    await saveRecorderSettings({ afterRecording: afterRecording.value });
    showSaved();
  });
}

init();
