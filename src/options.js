// Settings page. Each control saves at once.
'use strict';

const savedBadge = document.getElementById('saved');
let savedTimer = null;

function showSaved() {
  savedBadge.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedBadge.classList.remove('show'), 1200);
}

function fillSelect(select, items) {
  for (const item of items) select.add(new Option(item.label, item.id));
}

function profileLabel(profile) {
  const size = profile.maxWidth ? `up to ${profile.maxWidth} × ${profile.maxHeight}` : 'full screen size';
  const perMinute = formatBytes(bytesPerMinute(profile, VOICE_AUDIO_BITS_PER_SECOND));
  return `${profile.label}: ${size}, ${profile.frameRate} fps (about ${perMinute} per minute)`;
}

async function init() {
  fillSelect(document.getElementById('profile'), RECORDING_PROFILES.map((profile) => ({ id: profile.id, label: profileLabel(profile) })));
  fillSelect(document.getElementById('cameraPosition'), CAMERA_POSITIONS);
  fillSelect(document.getElementById('cameraSize'), CAMERA_SIZES);

  const settings = await getSettings();
  settings.profile = getRecordingProfile(settings.profile).id;

  const bindings = {
    profile: 'value',
    afterRecording: 'value',
    cameraPosition: 'value',
    cameraSize: 'value',
    downloadFolder: 'value',
    saveAs: 'checked'
  };

  for (const [name, property] of Object.entries(bindings)) {
    const input = document.getElementById(name);
    input[property] = settings[name];
    const eventName = input.type === 'text' ? 'change' : 'input';
    input.addEventListener(eventName, async () => {
      let value = input[property];
      if (name === 'downloadFolder') {
        value = sanitizeFolder(value);
        input.value = value;
      }
      await saveSettings({ [name]: value });
      showSaved();
    });
  }

  const table = document.getElementById('shortcuts');
  for (const command of await browser.commands.getAll()) {
    const row = table.insertRow();
    row.insertCell().textContent = command.description || 'Open the screen recorder';
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

init();
