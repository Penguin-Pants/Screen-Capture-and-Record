// Screen recorder page. Records the screen (and the webcam, if chosen) with
// a quality profile, shows the file size while recording, then shows the
// video with size options before saving.
'use strict';

// MediaRecorder types, best first. VP9 makes smaller files than VP8 at the
// same quality. Firefox records VP8.
const RECORDING_TYPES = [
  { withAudio: 'video/webm;codecs=vp9,opus', videoOnly: 'video/webm;codecs=vp9' },
  { withAudio: 'video/webm;codecs=vp8,opus', videoOnly: 'video/webm;codecs=vp8' },
  { withAudio: 'video/webm', videoOnly: 'video/webm' }
];

const $ = (id) => document.getElementById(id);
const ui = {
  message: $('message'),
  setup: $('setup'),
  live: $('live'),
  result: $('result'),
  profile: $('profileSelect'),
  profileHint: $('profileHint'),
  countdownSelect: $('countdownSelect'),
  mic: $('micCheck'),
  micSetup: $('micSetup'),
  micMeterFill: $('micMeterFill'),
  micHint: $('micHint'),
  micDevice: $('micDevice'),
  micDeviceRow: $('micDeviceRow'),
  computer: $('computerCheck'),
  computerSetup: $('computerSetup'),
  computerMeterFill: $('computerMeterFill'),
  computerHint: $('computerHint'),
  computerDevice: $('computerDevice'),
  computerDeviceRow: $('computerDeviceRow'),
  camera: $('cameraCheck'),
  cameraNote: $('cameraNote'),
  cameraSetup: $('cameraSetup'),
  cameraPreview: $('cameraPreview'),
  cameraDevice: $('cameraDevice'),
  cameraDeviceRow: $('cameraDeviceRow'),
  start: $('startBtn'),
  pause: $('pauseBtn'),
  stop: $('stopBtn'),
  timer: $('timer'),
  liveSize: $('liveSize'),
  liveCamera: $('liveCamera'),
  liveMicMeter: $('liveMicMeter'),
  liveMicMeterFill: $('liveMicMeterFill'),
  liveComputerMeter: $('liveComputerMeter'),
  liveComputerMeterFill: $('liveComputerMeterFill'),
  recIndicator: $('recIndicator'),
  recLabel: $('recLabel'),
  countdown: $('countdown'),
  stage: $('stage'),
  preview: $('preview'),
  previewCamera: $('previewCamera'),
  details: $('details'),
  cameraRow: $('cameraRow'),
  cameraPosition: $('cameraPositionSelect'),
  cameraSize: $('cameraSizeSelect'),
  presets: $('presets'),
  exportNote: $('exportNote'),
  format: $('formatSelect'),
  formatNote: $('formatNote'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  cancelExport: $('cancelExportBtn'),
  saved: $('saved'),
  savedText: $('savedText'),
  showFile: $('showFileBtn'),
  save: $('saveBtn'),
  again: $('againBtn'),
  settingsLink: $('settingsLink')
};

// Recording session state.
let mediaRecorder = null;   // The screen recorder
let cameraRecorder = null;  // The webcam recorder, when the camera is on
let chunks = [];
let cameraChunks = [];
let recordedBytes = 0;
let sourceStreams = [];     // Screen streams. All tracks stop at the end.
let cameraStream = null;    // The webcam stream: preview before and during recording
let cameraRequest = 0;      // Number of the newest camera request (see startCameraPreview)
let cameraPending = null;   // The camera request that waits for an answer, if any
let mixer = null;           // The AudioContext that mixes 2 sound inputs (see mixSound)
let activeMs = 0;           // Recorded time before the last resume
let resumedAt = 0;
let timerInterval = null;
let cancelCountdown = null;
let session = null;         // { profile, hasAudio, audioBitsPerSecond, inputs, startedAt, captureSize }

// Review state. recording: { blob, mimeType, seconds, width, height,
// frameRate, videoBitsPerSecond, hasAudio, audioBitsPerSecond, sound, camera, baseName, saved }
let recording = null;
let previewUrl = null;
let previewCameraUrl = null;
let lastDownloadId = null;
let exportSupport = null;   // null while checking, then { library, formats }
let conversion = null;      // The running Mediabunny conversion, for Cancel
let saving = false;         // A save (export, then download) is running
let cancelRequested = false;
let mediabunnyPromise = null;
let exportCheckLimitMs = 15000; // The longest wait for the codec check (tests make it shorter)

function showMessage(text, type = 'info') {
  ui.message.textContent = text;
  ui.message.className = `message show ${type}`;
}

function clearMessage() {
  ui.message.className = 'message';
}

function setView(view) {
  ui.setup.style.display = view === 'setup' ? '' : 'none';
  ui.live.classList.toggle('active', view === 'live');
  ui.result.classList.toggle('active', view === 'result');
}

function reportState(state) {
  browser.runtime.sendMessage({ action: 'recordingState', state }).catch(() => {});
}

// The background page calls this when the toolbar button is clicked and
// this recorder tab is already open.
window.focusRecorder = async () => {
  const tab = await browser.tabs.getCurrent();
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
};

// ---------------------------------------------------------------- Setup

function profileLabel(profile) {
  const size = profile.maxWidth ? `up to ${profile.maxWidth} × ${profile.maxHeight}` : 'full screen size';
  return `${profile.label}: ${size}, ${profile.frameRate} fps`;
}

function updateProfileHint() {
  const profile = getRecordingProfile(ui.profile.value);
  const audio = ui.computer.checked ? COMPUTER_AUDIO_BITS_PER_SECOND : (ui.mic.checked ? VOICE_AUDIO_BITS_PER_SECOND : 0);
  ui.profileHint.textContent =
    `About ${formatBytes(bytesPerMinute(profile, audio))} per minute. Often less when little moves on the screen.`;
}

// The camera bubble is drawn when you save, with the WebCodecs API.
function cameraSupported() {
  return typeof VideoEncoder === 'function' && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

async function initOptions() {
  for (const profile of RECORDING_PROFILES) {
    ui.profile.add(new Option(profileLabel(profile), profile.id));
  }
  for (const position of CAMERA_POSITIONS) ui.cameraPosition.add(new Option(position.label, position.id));
  ui.cameraPosition.add(new Option('Hide camera', 'hidden'));
  for (const size of CAMERA_SIZES) ui.cameraSize.add(new Option(`${size.label} size`, size.id));

  // Start stays off (see recorder.html) until the saved settings are in
  // the controls.
  const settings = await getSettings().catch((error) => {
    console.warn('Could not read the settings. Using the defaults.', error);
    return { ...SETTINGS_DEFAULTS };
  });
  ui.profile.value = getRecordingProfile(settings.profile).id;
  ui.countdownSelect.value = String(settings.countdown);
  ui.mic.checked = settings.microphone;
  ui.computer.checked = settings.computerSound;
  updateProfileHint();
  // As for the camera: Firefox asks now, and the level meters show that
  // the inputs work before you record.
  for (const input of soundInputs) {
    if (settings[input.setting]) startSoundInput(input, settings[input.deviceSetting]);
  }

  if (!cameraSupported()) {
    ui.camera.disabled = true;
    ui.cameraNote.textContent = '(needs Firefox 130 or later)';
  } else if (settings.camera) {
    ui.camera.checked = true;
    // Do not wait for the answer to the camera request. If you click Start
    // first, the recording waits for this request (see ensureCamera).
    startCameraPreview(settings.cameraDeviceId);
  }

  const persist = () => saveSettings({
    profile: ui.profile.value,
    countdown: Number(ui.countdownSelect.value),
    microphone: ui.mic.checked,
    computerSound: ui.computer.checked
  });
  [ui.profile, ui.countdownSelect, ui.mic, ui.computer].forEach((el) => el.addEventListener('change', () => {
    updateProfileHint();
    persist();
  }));

  for (const input of soundInputs) {
    input.ui.check.addEventListener('change', () => {
      if (input.ui.check.checked) ensureSoundInput(input);
      else stopSoundInput(input);
    });
    input.ui.device.addEventListener('change', () => {
      saveSettings({ [input.deviceSetting]: input.ui.device.value });
      startSoundInput(input, input.ui.device.value);
    });
  }

  ui.camera.addEventListener('change', () => {
    saveSettings({ camera: ui.camera.checked });
    if (ui.camera.checked) ensureCamera();
    else stopCamera();
  });
  ui.cameraDevice.addEventListener('change', () => {
    saveSettings({ cameraDeviceId: ui.cameraDevice.value });
    startCameraPreview(ui.cameraDevice.value);
  });
  ui.start.disabled = false;
}

// Open the webcam for the preview. The same stream is recorded later, so
// Firefox asks for permission only once. Each request gets a number. If
// the camera is turned off or another camera request starts before the
// answer comes, the old answer is not used and its camera stops at once.
function startCameraPreview(deviceId) {
  stopCamera();
  const request = ++cameraRequest;
  const pending = openCamera(request, deviceId).finally(() => {
    if (cameraPending === pending) cameraPending = null;
  });
  cameraPending = pending;
  return pending;
}

async function openCamera(request, deviceId) {
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  let stream;
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { ...video, deviceId: { exact: deviceId } } : video,
        audio: false
      });
    } catch (error) {
      if (!deviceId || error.name !== 'OverconstrainedError') throw error;
      // The saved camera is gone. Use the default camera.
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
  } catch (error) {
    if (request !== cameraRequest) return;
    ui.camera.checked = false;
    saveSettings({ camera: false });
    updateCameraSetup();
    showMessage(error.name === 'NotAllowedError'
      ? 'Firefox did not allow the camera. To use it, allow the camera when Firefox asks.'
      : `The camera is not available (${error.message}).`, 'error');
    return;
  }
  if (request !== cameraRequest) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  cameraStream = stream;
  ui.cameraPreview.srcObject = cameraStream;
  updateCameraSetup();
  await fillCameraDevices();
}

// Open the camera if the camera option is on and no camera is open or
// opening. Resolves when the newest camera request has its answer.
async function ensureCamera() {
  if (ui.camera.checked && !cameraStream && !cameraPending) {
    const { cameraDeviceId } = await getSettings();
    if (ui.camera.checked && !cameraStream && !cameraPending) startCameraPreview(cameraDeviceId);
  }
  while (cameraPending) await cameraPending;
}

function stopCamera() {
  // A camera request that has no answer yet is no longer wanted.
  cameraRequest++;
  cameraPending = null;
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  ui.cameraPreview.srcObject = null;
  ui.liveCamera.srcObject = null;
  ui.liveCamera.classList.remove('show');
  updateCameraSetup();
}

function updateCameraSetup() {
  ui.cameraSetup.classList.toggle('show', Boolean(ui.camera.checked && cameraStream));
}

// Camera names show only after permission is given. The list shows only
// when there is more than one camera.
async function fillCameraDevices() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
  ui.cameraDevice.replaceChildren(...devices.map((device, index) => new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
  const track = cameraStream && cameraStream.getVideoTracks()[0];
  const current = track && track.getSettings().deviceId;
  if (current && devices.some((device) => device.deviceId === current)) ui.cameraDevice.value = current;
  ui.cameraDeviceRow.style.display = devices.length > 1 ? '' : 'none';
}

// ----------------------------------------------------------- Sound inputs

// The level meter shows -60 dB (empty) to 0 dB (full). A normal voice
// fills about half of the bar.
const METER_FLOOR_DB = -60;
// Below this level (about -70 dB), an input gives no usable sound. A muted
// input, or one that the system does not let Firefox use, gives zeros.
const SILENCE_LEVEL = 0.0003;
// Time without sound before the hint tells you to check the input.
const SILENCE_HINT_MS = 3000;
// Names of loopback devices, which record the sound that the computer
// plays: Stereo Mix on Windows (also in some other languages), virtual
// cables, BlackHole and Soundflower on macOS, and monitors on Linux.
const LOOPBACK_NAMES = /stereo ?mix|mixage st|mezcla est|missaggio|what u hear|wave ?out mix|loopback|cable output|virtual audio|vb-audio|voicemeeter|blackhole|soundflower|monitor of/i;
const BLOCK_HELP = 'If Firefox does not ask, click the microphone icon in the address bar, remove the block, then ' +
  'reload this page.';

// The two sound inputs. Firefox gives no tab or system sound to screen
// sharing, so the computer sound comes from a loopback device, which
// Firefox shows as a microphone. Each input has a checkbox, a level meter,
// a hint and a device list. The stream opens when the option is ticked
// (Firefox asks then), and the same stream is recorded later. As for the
// camera (see startCameraPreview), each request gets a number, and the
// answer to an old request is not used.
const microphone = {
  ui: {
    check: ui.mic, setup: ui.micSetup, meterFill: ui.micMeterFill, hint: ui.micHint, device: ui.micDevice,
    deviceRow: ui.micDeviceRow, liveMeter: ui.liveMicMeter, liveMeterFill: ui.liveMicMeterFill
  },
  setting: 'microphone',
  deviceSetting: 'microphoneDeviceId',
  // Echo cancellation, noise suppression and automatic gain control make a
  // voice clear. Firefox uses them by default too.
  constraints: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  texts: {
    deviceName: 'Microphone',
    hint: 'Talk to test the microphone. The bar moves when it hears you.',
    silentHint: 'No sound from this microphone. If the bar does not move when you talk, choose another ' +
      'microphone, make sure that it is not muted, and make sure that your system settings let Firefox use it.',
    noMeter: 'The level meter is not available. The microphone records.',
    notAllowed: 'Firefox did not allow the microphone. To record your voice, tick "Include microphone" and allow ' +
      `the microphone. ${BLOCK_HELP}`,
    notFound: 'Firefox found no microphone. Connect a microphone, then tick "Include microphone".',
    notAvailable: 'The microphone is not available',
    question: 'Record without the microphone?',
    stoppedSetup: 'The microphone stopped (for example, it was unplugged). Check the microphone before you record.',
    stoppedLive: 'The microphone stopped. The rest of the video has no sound from the microphone.',
    silentWarning: 'The microphone gave no sound during this recording. Before you record again, talk and look ' +
      'at the level bar under "Include microphone".',
    stoppedWarning: 'The microphone stopped during this recording. Part of the video has no sound from the microphone.',
    silentNote: 'no sound from the microphone',
    stoppedNote: 'microphone stopped'
  },
  stream: null, request: 0, pending: null, error: null, meter: null
};

const computerSound = {
  ui: {
    check: ui.computer, setup: ui.computerSetup, meterFill: ui.computerMeterFill, hint: ui.computerHint,
    device: ui.computerDevice, deviceRow: ui.computerDeviceRow, liveMeter: ui.liveComputerMeter,
    liveMeterFill: ui.liveComputerMeterFill
  },
  setting: 'computerSound',
  deviceSetting: 'computerSoundDeviceId',
  // The computer sound is not a voice: no voice filters, and stereo.
  constraints: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
  // Loopback devices have these names. Without a saved device, the first
  // one opens. The right device is rarely the default one, so the list
  // always shows.
  deviceNames: LOOPBACK_NAMES,
  alwaysShowDevices: true,
  texts: {
    deviceName: 'Sound input',
    hint: 'Play a sound on the computer. The bar moves when the device hears it.',
    silentHint: 'No sound from this device. Play a sound on the computer. If the bar does not move, choose your ' +
      'loopback device (for example, Stereo Mix) in the list.',
    sameDevice: 'This is the device of your microphone. Choose your loopback device (for example, Stereo Mix) in ' +
      'the list.',
    notLoopback: 'This device does not look like a loopback device. If it is a microphone, choose your loopback ' +
      'device (for example, Stereo Mix) in the list.',
    noMeter: 'The level meter is not available. The computer sound records.',
    notAllowed: 'Firefox did not allow the sound device. To record the computer sound, tick "Include computer ' +
      `sound" and allow the device. ${BLOCK_HELP}`,
    notFound: 'Firefox found no sound device. Set up a loopback device (see "How to set up computer sound"), then ' +
      'tick "Include computer sound".',
    notAvailable: 'The computer sound device is not available',
    question: 'Record without the computer sound?',
    stoppedSetup: 'The computer sound device stopped. Check the device before you record.',
    stoppedLive: 'The computer sound device stopped. The rest of the video has no computer sound.',
    silentWarning: 'No computer sound was recorded. If the computer played sound, check the device under ' +
      '"Include computer sound".',
    stoppedWarning: 'The computer sound device stopped during this recording. Part of the video has no computer sound.',
    silentNote: 'no computer sound',
    stoppedNote: 'computer sound stopped'
  },
  stream: null, request: 0, pending: null, error: null, meter: null
};

const soundInputs = [microphone, computerSound];

function startSoundInput(input, deviceId) {
  stopSoundInput(input);
  input.error = null;
  const request = ++input.request;
  const pending = openSoundInput(input, request, deviceId).finally(() => {
    if (input.pending === pending) input.pending = null;
  });
  input.pending = pending;
  return pending;
}

async function openSoundInput(input, request, deviceId) {
  const open = (id) => navigator.mediaDevices.getUserMedia({
    audio: id ? { ...input.constraints, deviceId: { exact: id } } : input.constraints
  });
  // The first device with a name of this input (a loopback device for the
  // computer sound), or '' for the default device. Device names show only
  // after permission is given. Without a name that matches, Firefox lets
  // you choose the device when it asks.
  const namedDevice = async () => {
    if (!input.deviceNames) return '';
    const found = (await audioInputDevices()).find((device) => input.deviceNames.test(device.label));
    return found ? found.deviceId : '';
  };
  let stream;
  try {
    if (!deviceId) {
      deviceId = await namedDevice();
      if (request !== input.request) return;
    }
    try {
      stream = await open(deviceId);
    } catch (error) {
      if (!deviceId || error.name !== 'OverconstrainedError') throw error;
      // The saved device is gone. Use another device with a matching name
      // (not the microphone for the computer sound), else the default one.
      const other = await namedDevice();
      if (request !== input.request) return;
      stream = await open(other === deviceId ? '' : other);
    }
  } catch (error) {
    if (request !== input.request) return;
    input.error = error;
    input.ui.check.checked = false;
    saveSettings({ [input.setting]: false });
    updateProfileHint();
    updateSoundInputSetup(input);
    showMessage(soundInputErrorText(input, error), 'error');
    return;
  }
  if (request !== input.request) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  input.stream = stream;
  stream.getAudioTracks().forEach((track) => track.addEventListener('ended', (event) => onSoundInputEnded(input, event)));
  startMeter(input);
  updateSoundInputSetup(input);
  await fillSoundInputDevices(input);
}

function soundInputErrorText(input, error) {
  if (error.name === 'NotAllowedError') return input.texts.notAllowed;
  if (error.name === 'NotFoundError') return input.texts.notFound;
  return `${input.texts.notAvailable} (${error.message}). Make sure that no other app uses it and that your ` +
    'system settings let Firefox use it.';
}

// Open the input if its option is on and no stream is open or opening.
// Resolves when the newest request has its answer.
async function ensureSoundInput(input) {
  if (input.ui.check.checked && !input.stream && !input.pending) {
    const settings = await getSettings();
    if (input.ui.check.checked && !input.stream && !input.pending) startSoundInput(input, settings[input.deviceSetting]);
  }
  while (input.pending) await input.pending;
}

function stopSoundInput(input) {
  // A request that has no answer yet is no longer wanted.
  input.request++;
  input.pending = null;
  stopMeter(input);
  if (input.stream) input.stream.getTracks().forEach((track) => track.stop());
  input.stream = null;
  updateSoundInputSetup(input);
}

function updateSoundInputSetup(input) {
  input.ui.setup.classList.toggle('show', Boolean(input.ui.check.checked && input.stream));
}

async function audioInputDevices() {
  return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
}

// The device of an open input and its name, if the browser tells them.
function soundInputDeviceId(input) {
  const track = input.stream && input.stream.getAudioTracks()[0];
  return track ? track.getSettings().deviceId : undefined;
}

function soundInputLabel(input) {
  const track = input.stream && input.stream.getAudioTracks()[0];
  return track ? track.label : '';
}

// Device names show only after permission is given.
async function fillSoundInputDevices(input) {
  const devices = await audioInputDevices();
  input.ui.device.replaceChildren(...devices.map((device, index) =>
    new Option(device.label || `${input.texts.deviceName} ${index + 1}`, device.deviceId)));
  const current = soundInputDeviceId(input);
  if (current && devices.some((device) => device.deviceId === current)) input.ui.device.value = current;
  input.ui.deviceRow.style.display = input.alwaysShowDevices || devices.length > 1 ? '' : 'none';
}

// The input that a recording uses, with its values (see startRecording).
function recordedInput(input) {
  return session && mediaRecorder ? session.inputs.find((item) => item.input === input) : undefined;
}

// An input stopped, for example because it was unplugged. (A track that
// we stop ourselves gives no "ended" event.)
function onSoundInputEnded(input, event) {
  if (!input.stream || !input.stream.getAudioTracks().includes(event.target)) return;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    const recorded = recordedInput(input);
    if (recorded) {
      recorded.stopped = true;
      showMessage(input.texts.stoppedLive, 'error');
    }
    return;
  }
  // Before recording: open the input again (the default device, if the
  // chosen one is gone).
  stopSoundInput(input);
  showMessage(input.texts.stoppedSetup, 'error');
  ensureSoundInput(input);
}

// Level meter: an analyser reads the input 10 times a second. The same
// values tell when the input gives no sound.
function startMeter(input) {
  stopMeter(input);
  let context = null;
  try {
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(input.stream).connect(analyser);
    input.meter = { context, analyser, data: new Float32Array(analyser.fftSize), heardAt: Date.now(), timer: 0 };
  } catch (error) {
    // Without the meter, the input still records.
    console.warn('Could not start the level meter:', error);
    if (context) context.close().catch(() => {});
    input.ui.setup.classList.add('no-meter');
    input.ui.hint.textContent = input.texts.noMeter;
    input.ui.hint.classList.remove('warn');
    return;
  }
  input.ui.setup.classList.remove('no-meter');
  // A new AudioContext can start "suspended" (autoplay rules). The click on
  // Start also resumes it.
  input.meter.context.resume().catch(() => {});
  input.meter.timer = setInterval(() => updateMeter(input), 100);
  setHint(input, false);
}

function stopMeter(input) {
  if (!input.meter) return;
  clearInterval(input.meter.timer);
  input.meter.context.close().catch(() => {});
  input.meter = null;
  input.ui.meterFill.style.width = '0';
  input.ui.liveMeterFill.style.width = '0';
}

function updateMeter(input) {
  const { meter } = input;
  const now = Date.now();
  if (meter.context.state !== 'running') {
    // No values yet: do not judge the sound.
    meter.heardAt = now;
    return;
  }
  meter.analyser.getFloatTimeDomainData(meter.data);
  let peak = 0;
  for (const value of meter.data) peak = Math.max(peak, Math.abs(value));
  const decibels = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const width = `${Math.round(Math.min(1, Math.max(0, 1 - decibels / METER_FLOOR_DB)) * 100)}%`;
  input.ui.meterFill.style.width = width;
  input.ui.liveMeterFill.style.width = width;

  if (peak >= SILENCE_LEVEL) meter.heardAt = now;
  setHint(input, now - meter.heardAt >= SILENCE_HINT_MS);
  const recorded = recordedInput(input);
  if (recorded && mediaRecorder.state === 'recording') recorded.peak = Math.max(recorded.peak || 0, peak);
}

function setHint(input, silent) {
  let text = silent ? input.texts.silentHint : input.texts.hint;
  let warn = silent;
  // The computer sound needs a loopback device, not the microphone. This
  // shows also when the microphone is not open.
  const device = soundInputDeviceId(input);
  const label = soundInputLabel(input);
  if (input.texts.sameDevice && device && device === soundInputDeviceId(microphone)) {
    text = input.texts.sameDevice;
    warn = true;
  } else if (input.deviceNames && label && !input.deviceNames.test(label)) {
    text = input.texts.notLoopback;
    warn = true;
  }
  if (input.ui.hint.textContent !== text) input.ui.hint.textContent = text;
  input.ui.hint.classList.toggle('warn', warn);
}

// Mix the sound inputs into one track: a MediaRecorder records only one
// sound track. A suspended mixer gives silence, so it must run.
async function mixSound(inputs) {
  if (!mixer) mixer = new AudioContext();
  await Promise.race([mixer.resume(), new Promise((resolve) => setTimeout(resolve, 1000))]);
  if (mixer.state !== 'running') throw new Error(`the mixer is ${mixer.state}`);
  const destination = mixer.createMediaStreamDestination();
  for (const input of inputs) mixer.createMediaStreamSource(input.stream).connect(destination);
  return destination.stream.getAudioTracks()[0];
}

function closeMixer() {
  if (mixer) mixer.close().catch(() => {});
  mixer = null;
}

// Problems with the sound of a recording: warnings for the review, and
// notes for the line under the video. soundData: the file has sound
// packets. Without level values, an input is not judged.
function soundProblems(s, soundData) {
  if (!s.hasAudio) return { warnings: [], notes: ['no sound'] };
  if (!soundData) {
    return {
      warnings: ['The recording has no sound: the browser recorded no sound data. Before you record again, look ' +
        'at the level bars.'],
      notes: ['no sound']
    };
  }
  const problems = { warnings: [], notes: [] };
  for (const { input, peak, stopped } of s.inputs) {
    if (peak !== null && peak < SILENCE_LEVEL) {
      problems.warnings.push(input.texts.silentWarning);
      problems.notes.push(input.texts.silentNote);
    } else if (stopped) {
      problems.warnings.push(input.texts.stoppedWarning);
      problems.notes.push(input.texts.stoppedNote);
    }
  }
  return problems;
}

function chooseMimeType(hasAudio) {
  for (const type of RECORDING_TYPES) {
    const preferred = hasAudio ? type.withAudio : type.videoOnly;
    if (MediaRecorder.isTypeSupported(preferred)) return preferred;
  }
  return '';
}

// Show a full-screen countdown. Resolves true when done, false when cancelled.
function runCountdown(seconds) {
  if (!seconds) return Promise.resolve(true);
  return new Promise((resolve) => {
    let remaining = seconds;
    ui.countdown.textContent = remaining;
    ui.countdown.classList.add('active');
    const interval = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        ui.countdown.textContent = remaining;
        return;
      }
      finish(true);
    }, 1000);
    function finish(ok) {
      clearInterval(interval);
      ui.countdown.classList.remove('active');
      cancelCountdown = null;
      resolve(ok);
    }
    cancelCountdown = () => finish(false);
  });
}

// ------------------------------------------------------------ Recording

// Screen size limit and frame rate for getDisplayMedia(). Firefox scales
// the screen down to fit inside the maximum size.
function displayConstraints(profile) {
  const video = { frameRate: { ideal: profile.frameRate, max: profile.frameRate } };
  if (profile.maxWidth) {
    video.width = { max: profile.maxWidth };
    video.height = { max: profile.maxHeight };
  }
  return video;
}

// Resolves when a started recorder has stopped.
function whenStopped(recorder) {
  return new Promise((resolve) => {
    if (!recorder || recorder.state === 'inactive') resolve();
    else recorder.addEventListener('stop', resolve, { once: true });
  });
}

async function startRecording() {
  clearMessage();
  ui.start.disabled = true;
  // The click lets suspended level meters start (autoplay rules).
  for (const input of soundInputs) {
    if (input.meter) input.meter.context.resume().catch(() => {});
  }
  // The inputs that you want, until you agree to record without one.
  const wanted = new Set(soundInputs.filter((input) => input.ui.check.checked));
  // Waits for the answers to open sound input requests. Resolves false when
  // an input failed and you do not want to record without it.
  const soundReady = async () => {
    for (const input of soundInputs) {
      await ensureSoundInput(input);
      if (!wanted.has(input) || input.stream || !input.error) continue;
      if (!window.confirm(`${soundInputErrorText(input, input.error)}\n\n${input.texts.question}`)) return false;
      wanted.delete(input);
    }
    return true;
  };
  try {
    // With 2 sound inputs, a mixer makes one sound track (see mixSound). It
    // is made here, in the click, so autoplay rules let it run.
    closeMixer();
    if (wanted.size > 1) mixer = new AudioContext();
    const profile = getRecordingProfile(ui.profile.value);
    // Video only: Firefox gives no tab or system sound to screen sharing.
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: displayConstraints(profile) });
    sourceStreams = [displayStream];

    // Stop when the person ends sharing from the Firefox sharing indicator.
    const videoTrack = displayStream.getVideoTracks()[0];
    videoTrack.addEventListener('ended', stopRecording);

    // If a camera or sound input request is open (for example, from page
    // load), wait for it. A second request would make Firefox ask again.
    // A recording without a sound input that you want starts only when you
    // agree to it.
    await ensureCamera();
    const withCamera = Boolean(ui.camera.checked && cameraStream);
    const cancel = () => {
      releaseStreams({ keepDevices: true });
      setView('setup');
    };
    if (!(await soundReady())) {
      cancel();
      return;
    }

    const countdownDone = await runCountdown(Number(ui.countdownSelect.value));
    if (!countdownDone || videoTrack.readyState === 'ended') {
      cancel();
      return;
    }
    // An input can stop during the countdown. Then the page opens it again
    // (see onSoundInputEnded), so the stream is made only now.
    if (!(await soundReady())) {
      cancel();
      return;
    }
    const inputs = soundInputs.filter((input) => input.ui.check.checked && input.stream);
    if (inputs.length < 2) closeMixer();
    let audioTracks = inputs.length === 1 ? inputs[0].stream.getAudioTracks() : [];
    if (inputs.length > 1) {
      try {
        audioTracks = [await mixSound(inputs)];
      } catch (error) {
        console.warn('Could not mix the sound inputs:', error);
        closeMixer();
        if (!window.confirm(`Firefox cannot mix the computer sound with the microphone (${error.message}).\n\n` +
            'Record with the microphone only?')) {
          cancel();
          return;
        }
        inputs.splice(1);
        audioTracks = microphone.stream.getAudioTracks();
      }
    }
    const stream = new MediaStream([...displayStream.getVideoTracks(), ...audioTracks]);
    const hasAudio = audioTracks.length > 0;
    // The computer sound (music, for example) gets more bits than a voice.
    const audioBitsPerSecond = inputs.includes(computerSound) ? COMPUTER_AUDIO_BITS_PER_SECOND : VOICE_AUDIO_BITS_PER_SECOND;
    const mimeType = chooseMimeType(hasAudio);
    const options = { videoBitsPerSecond: profile.videoBitsPerSecond };
    if (mimeType) options.mimeType = mimeType;
    if (hasAudio) options.audioBitsPerSecond = audioBitsPerSecond;

    const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
    session = {
      profile,
      hasAudio,
      audioBitsPerSecond: hasAudio ? audioBitsPerSecond : 0,
      // The recorded sound inputs, each with its loudest level while
      // recording (see updateMeter; null while its level meter gives no
      // values) and whether it stopped.
      inputs: inputs.map((input) => ({ input, peak: null, stopped: false })),
      startedAt: new Date(),
      captureSize: { width: settings.width || 0, height: settings.height || 0 }
    };
    chunks = [];
    cameraChunks = [];
    recordedBytes = 0;
    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
        recordedBytes += event.data.size;
        updateLiveSize();
      }
    };
    mediaRecorder.onerror = (event) => {
      showMessage(`Recording error: ${(event.error && event.error.message) || 'unknown error'}`, 'error');
      stopRecording();
    };

    cameraRecorder = null;
    if (withCamera) {
      // The webcam records to its own file, without sound (the sound is in
      // the screen file). The bubble is drawn when you save.
      const cameraType = chooseMimeType(false);
      cameraRecorder = new MediaRecorder(cameraStream, {
        videoBitsPerSecond: CAMERA_BITS_PER_SECOND,
        ...(cameraType ? { mimeType: cameraType } : {})
      });
      cameraRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) cameraChunks.push(event.data);
      };
      cameraRecorder.onerror = () => showMessage('The camera stopped. The rest of the video has no camera.', 'error');
      ui.liveCamera.srcObject = cameraStream;
      ui.liveCamera.classList.add('show');
    }
    for (const input of soundInputs) input.ui.liveMeter.classList.toggle('show', inputs.includes(input) && Boolean(input.meter));

    mediaRecorder.start(1000);
    if (cameraRecorder) cameraRecorder.start(1000);
    Promise.all([whenStopped(mediaRecorder), whenStopped(cameraRecorder)]).then(finishRecording);

    activeMs = 0;
    resumedAt = Date.now();
    updateTimer();
    timerInterval = setInterval(updateTimer, 500);
    setPausedUi(false);
    setView('live');
    reportState('recording');
  } catch (error) {
    releaseStreams({ keepDevices: true });
    setView('setup');
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
      showMessage(`Could not start recording: ${error.message}`, 'error');
    }
  } finally {
    ui.start.disabled = false;
  }
}

function togglePause() {
  if (!mediaRecorder) return;
  const recorders = [mediaRecorder, cameraRecorder].filter(Boolean);
  if (mediaRecorder.state === 'recording') {
    recorders.forEach((recorder) => recorder.state === 'recording' && recorder.pause());
    activeMs += Date.now() - resumedAt;
    setPausedUi(true);
    reportState('paused');
  } else if (mediaRecorder.state === 'paused') {
    recorders.forEach((recorder) => recorder.state === 'paused' && recorder.resume());
    resumedAt = Date.now();
    setPausedUi(false);
    reportState('recording');
  }
  updateTimer();
}

function setPausedUi(paused) {
  ui.pause.textContent = paused ? 'Resume' : 'Pause';
  ui.recLabel.textContent = paused ? 'Paused' : 'Recording';
  ui.recIndicator.classList.toggle('paused', paused);
}

function stopRecording() {
  if (cancelCountdown) cancelCountdown();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    if (mediaRecorder.state === 'recording') activeMs += Date.now() - resumedAt;
    mediaRecorder.stop(); // When both recorders stop, the review opens.
  }
  if (cameraRecorder && cameraRecorder.state !== 'inactive') cameraRecorder.stop();
  // Before the recording starts (for example, during the countdown), the
  // camera and the sound inputs stay open for the next try.
  releaseStreams({ keepDevices: !mediaRecorder });
  clearInterval(timerInterval);
  reportState('idle');
}

// Stop every track of every stream we opened (screen, sound inputs,
// camera) and close the mixer, so no capture indicator stays on.
// keepDevices keeps the camera and the sound inputs open for the next try.
function releaseStreams({ keepDevices = false } = {}) {
  for (const stream of sourceStreams) {
    stream.getTracks().forEach((track) => track.stop());
  }
  sourceStreams = [];
  closeMixer();
  if (!keepDevices) {
    stopCamera();
    soundInputs.forEach(stopSoundInput);
  }
}

function activeSeconds() {
  const running = mediaRecorder && mediaRecorder.state === 'recording';
  return (activeMs + (running ? Date.now() - resumedAt : 0)) / 1000;
}

function updateTimer() {
  ui.timer.textContent = formatDuration(activeSeconds());
  updateLiveSize();
}

// The real size so far. The rate per minute shows after a few seconds,
// when it is stable enough to be useful.
function updateLiveSize() {
  const seconds = activeSeconds();
  let text = `${formatBytes(recordedBytes)} so far`;
  if (seconds >= 5 && recordedBytes > 0) {
    text += ` · about ${formatBytes((recordedBytes / seconds) * 60)} per minute`;
  }
  ui.liveSize.textContent = text;
}

// --------------------------------------------------------------- Review

function waitForVideoSize(video, fallback) {
  return new Promise((resolve) => {
    const done = () => resolve({
      width: video.videoWidth || fallback.width,
      height: video.videoHeight || fallback.height
    });
    if (video.readyState >= 1) {
      done();
      return;
    }
    video.addEventListener('loadedmetadata', done, { once: true });
    video.addEventListener('error', done, { once: true });
    setTimeout(done, 3000);
  });
}

async function finishRecording() {
  const recorder = mediaRecorder;
  mediaRecorder = null;
  cameraRecorder = null;
  if (chunks.length === 0) {
    setView('setup');
    showMessage('The recording is empty. Nothing was saved.', 'error');
    ensureCamera();
    soundInputs.forEach(ensureSoundInput);
    return;
  }

  const mimeType = (recorder && recorder.mimeType) || 'video/webm';
  const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
  const cameraBlob = cameraChunks.length > 0 ? new Blob(cameraChunks, { type: 'video/webm' }) : null;
  chunks = [];
  cameraChunks = [];

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  ui.preview.src = previewUrl;
  if (previewCameraUrl) URL.revokeObjectURL(previewCameraUrl);
  previewCameraUrl = cameraBlob ? URL.createObjectURL(cameraBlob) : null;
  if (previewCameraUrl) ui.previewCamera.src = previewCameraUrl;
  else ui.previewCamera.removeAttribute('src');
  lastDownloadId = null;
  ui.saved.classList.remove('show');
  exportSupport = null;

  const size = await waitForVideoSize(ui.preview, session.captureSize);
  // The file can have no sound data, for example when an input ended at
  // once. Then it is a recording without sound, and saves say so.
  const soundData = session.hasAudio && await hasSoundData(blob);
  recording = {
    blob,
    mimeType,
    seconds: activeMs / 1000,
    width: size.width,
    height: size.height,
    frameRate: session.profile.frameRate,
    videoBitsPerSecond: session.profile.videoBitsPerSecond,
    hasAudio: soundData,
    audioBitsPerSecond: soundData ? session.audioBitsPerSecond : 0,
    sound: soundProblems(session, soundData),
    camera: cameraBlob ? { blob: cameraBlob } : null,
    baseName: `recording-${fileTimestamp(session.startedAt)}`,
    saved: false
  };
  const settings = await getSettings();
  ui.cameraPosition.value = settings.cameraPosition;
  if (!ui.cameraPosition.value) ui.cameraPosition.value = CAMERA_POSITIONS[0].id;
  ui.cameraSize.value = settings.cameraSize;
  if (!ui.cameraSize.value) ui.cameraSize.value = 'medium';
  if (recording.sound.warnings.length > 0) showMessage(recording.sound.warnings.join(' '), 'error');
  renderReview(settings);
  setView('result');

  const current = recording;
  const saveAtOnce = settings.afterRecording === 'save';
  // Without the camera, "Save at once" does not need the codec check.
  if (saveAtOnce && !current.camera) saveAsRecorded(current);

  // A codec check can stay without an answer. Then the review stops waiting
  // for it, and the recording can be saved as it is.
  const support = await Promise.race([
    detectExportSupport(current),
    new Promise((resolve) => setTimeout(resolve, exportCheckLimitMs, { library: true, formats: [], timedOut: true }))
  ]);
  if (recording !== current) return; // A new recording started meanwhile.
  exportSupport = support;
  renderReview(settings);

  if (saveAtOnce && current.camera && !current.saved) await saveAsRecorded(current);
}

// "Save at once": save the recording as it is (with the camera: at full size).
async function saveAsRecorded(rec) {
  if (!exportChoices()[0].enabled) {
    showMessage('This browser cannot make the video with your camera at full size. Choose a smaller size, then click Save.', 'info');
    return;
  }
  await saveRecording('original');
  if (recording === rec && rec.saved) {
    const text = cameraOn()
      ? 'The recording was saved with your camera. You can also save a smaller copy below.'
      : 'The recording was saved as it is. You can also save a smaller copy below.';
    const { warnings } = rec.sound;
    showMessage([text, ...warnings].join(' '), warnings.length > 0 ? 'error' : 'info');
  }
}

// A problem with the sound stays in view until a new recording starts.
function resetMessage() {
  if (recording && recording.sound.warnings.length > 0) showMessage(recording.sound.warnings.join(' '), 'error');
  else clearMessage();
}

// Mediabunny (MPL-2.0, src/vendor/mediabunny) reads, converts and writes
// the video files with the WebCodecs API. It loads only when a recording is
// ready. The path is relative to this script.
function loadMediabunny() {
  if (!mediabunnyPromise) {
    mediabunnyPromise = import('./vendor/mediabunny/mediabunny.min.mjs').catch((error) => {
      mediabunnyPromise = null;
      throw error;
    });
  }
  return mediabunnyPromise;
}

// Which output formats this browser can encode. Smaller copies and the
// camera bubble need the WebCodecs API (Firefox 130 or later).
async function detectExportSupport(rec) {
  let mb;
  try {
    mb = await loadMediabunny();
  } catch (error) {
    console.warn('Could not load the export library:', error);
    return { library: false, formats: [] };
  }
  if (typeof VideoEncoder !== 'function' || !rec.width || !rec.height) {
    return { library: true, formats: [] };
  }

  const check = fitWithin(rec.width, rec.height, EXPORT_PRESETS[0].maxWidth, EXPORT_PRESETS[0].maxHeight);
  const formats = [];
  try {
    // The recorded sound (Opus) goes into WebM and MP4 files as it is, with
    // no new encode (see saveRecording). So Opus needs no audio encoder.
    const webmCodecs = ['vp9', 'vp8'];
    const webmVideo = await mb.getFirstEncodableVideoCodec(webmCodecs, check);
    if (webmVideo) {
      formats.push({ id: 'webm', label: 'WebM (small files, plays in browsers)', container: 'webm', videoCodecs: webmCodecs, videoCodec: webmVideo, audioCodec: rec.hasAudio ? 'opus' : null });
    }
    const mp4Codecs = ['avc'];
    const mp4Video = await mb.getFirstEncodableVideoCodec(mp4Codecs, check);
    if (mp4Video) {
      // AAC sound plays in the most apps, but Firefox cannot encode AAC.
      // Then the MP4 file has Opus sound (see updateFormatNote).
      const mp4Audio = rec.hasAudio ? (await mb.getFirstEncodableAudioCodec(['aac'])) || 'opus' : null;
      const label = mp4Audio === 'opus' ? 'MP4 (H.264 video, Opus sound)' : 'MP4 (plays in more apps)';
      formats.push({ id: 'mp4', label, container: 'mp4', videoCodecs: mp4Codecs, videoCodec: mp4Video, audioCodec: mp4Audio });
    }
    // With the camera, "Full size" encodes at the size of the recording,
    // which can be larger than the size above (for example 4K). Some
    // encoders cannot take that size, or only with another codec.
    if (rec.camera) {
      const full = { ...fitWithin(rec.width, rec.height, null, null), bitrate: rec.videoBitsPerSecond, frameRate: rec.frameRate };
      for (const format of formats) {
        format.fullSizeCodec = await mb.getFirstEncodableVideoCodec(format.videoCodecs, full);
      }
    }
  } catch (error) {
    console.warn('Could not check the video encoders:', error);
  }
  return { library: true, formats };
}

function canTranscode() {
  return Boolean(exportSupport && exportSupport.formats.length > 0 && recording.width);
}

// The camera bubble goes into the saved video.
function cameraOn() {
  return Boolean(recording && recording.camera && ui.cameraPosition.value !== 'hidden' && canTranscode());
}

function sourceInfo() {
  return {
    width: recording.width,
    height: recording.height,
    seconds: recording.seconds,
    bytes: recording.blob.size,
    frameRate: recording.frameRate,
    hasAudio: recording.hasAudio,
    audioBitsPerSecond: recording.audioBitsPerSecond
  };
}

// All choices for "Save as", with their estimated sizes.
function exportChoices() {
  const transcode = canTranscode();
  let original;
  if (cameraOn()) {
    // The bubble needs a new encode, at the quality of the recording.
    const plan = planExport({
      maxWidth: null,
      maxHeight: null,
      frameRate: recording.frameRate,
      videoBitsPerSecond: recording.videoBitsPerSecond
    }, sourceInfo());
    const encodable = formatsFor('original').length > 0;
    original = {
      id: 'original',
      name: 'Full size',
      spec: `${plan.width} × ${plan.height}, ${plan.frameRate} fps${encodable ? '' : ' (this browser cannot encode this size)'}`,
      size: `about ${formatBytes(plan.bytes)}`,
      enabled: encodable,
      plan
    };
  } else {
    original = {
      id: 'original',
      name: 'As recorded',
      spec: recording.width ? `${recording.width} × ${recording.height}, no quality loss` : 'No quality loss',
      size: formatBytes(recording.blob.size),
      enabled: true
    };
  }
  const choices = [original];
  for (const preset of EXPORT_PRESETS) {
    const plan = recording.width ? planExport(preset, sourceInfo()) : null;
    let spec = plan ? `${plan.width} × ${plan.height}, ${plan.frameRate} fps` : '';
    if (plan && !plan.smaller) spec += ' (not smaller than the recording)';
    choices.push({
      id: preset.id,
      name: preset.label,
      spec,
      size: plan ? `about ${formatBytes(plan.bytes)}` : '',
      enabled: transcode && Boolean(plan) && plan.smaller,
      plan
    });
  }
  return choices;
}

function selectedChoiceId() {
  const checked = ui.presets.querySelector('input[name="exportPreset"]:checked');
  return checked ? checked.value : 'original';
}

// The output formats for a choice. "As recorded" keeps the format of the
// recording. "Full size" with the camera can use only the formats whose
// encoder takes the full size of the recording.
function formatsFor(choiceId) {
  if (!exportSupport) return [];
  if (choiceId !== 'original') return exportSupport.formats;
  return cameraOn() ? exportSupport.formats.filter((format) => format.fullSizeCodec) : [];
}

function renderReview(settings) {
  const rec = recording;
  const parts = [`Length ${formatDuration(rec.seconds)}`];
  if (rec.width) parts.push(`${rec.width} × ${rec.height}`);
  parts.push(formatBytes(rec.blob.size));
  parts.push(...rec.sound.notes);
  if (rec.camera) parts.push('with camera');
  ui.details.textContent = parts.join(' · ');

  ui.cameraRow.classList.toggle('show', Boolean(rec.camera));
  renderStage();

  const choices = exportChoices();
  const current = ui.presets.querySelector('input:checked') ? selectedChoiceId() : settings.exportPreset;
  const enabled = choices.filter((choice) => choice.enabled);
  const wanted = enabled.some((choice) => choice.id === current) ? current : (enabled[0] || choices[0]).id;

  ui.presets.replaceChildren(...choices.map((choice) => {
    const label = document.createElement('label');
    label.className = `preset${choice.enabled ? '' : ' disabled'}`;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'exportPreset';
    input.value = choice.id;
    input.disabled = !choice.enabled;
    input.checked = choice.id === wanted;
    const text = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = choice.name;
    const spec = document.createElement('span');
    spec.className = 'spec';
    spec.textContent = choice.spec ? ` · ${choice.spec}` : '';
    text.append(name, spec);
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = choice.size;
    label.append(input, text, size);
    return label;
  }));

  // With the camera, Save waits for the check: until then the choices are
  // not final, and "As recorded" would save the recording without the camera.
  ui.save.disabled = saving || (exportSupport === null && Boolean(rec.camera));
  if (exportSupport === null) {
    ui.exportNote.textContent = 'Checking which formats this browser can make...';
  } else if (!exportSupport.library) {
    ui.exportNote.textContent = 'The export tool could not load. You can save the recording as it is.';
  } else if (exportSupport.timedOut) {
    ui.exportNote.textContent = rec.camera
      ? 'The format check did not finish, so the camera cannot be added. You can save the screen recording as it is.'
      : 'The format check did not finish. You can save the recording as it is.';
  } else if (exportSupport.formats.length === 0) {
    ui.exportNote.textContent = rec.camera
      ? 'Adding the camera and smaller copies need Firefox 130 or later. You can save the screen recording as it is.'
      : 'Smaller copies need Firefox 130 or later. You can save the recording as it is.';
  } else {
    ui.exportNote.textContent = 'Sizes are estimates. Screens with little motion often make smaller files.';
  }

  renderFormats(settings);
}

// Preview: the screen video, with the camera video on top where the
// bubble will be. The stage has the aspect ratio of the recording.
function renderStage() {
  const rec = recording;
  if (rec.width && rec.height) {
    ui.stage.style.aspectRatio = `${rec.width} / ${rec.height}`;
    ui.stage.style.maxWidth = `${Math.round((360 * rec.width) / rec.height)}px`;
  }
  const show = Boolean(rec.camera && rec.width && ui.cameraPosition.value !== 'hidden');
  ui.previewCamera.classList.toggle('show', show);
  if (!show) return;
  const box = cameraBubbleRect(rec.width, rec.height, ui.cameraPosition.value, ui.cameraSize.value);
  Object.assign(ui.previewCamera.style, {
    left: `${(box.x / rec.width) * 100}%`,
    top: `${(box.y / rec.height) * 100}%`,
    width: `${(box.diameter / rec.width) * 100}%`
  });
}

function renderFormats(settings) {
  const formats = formatsFor(selectedChoiceId());
  const previous = ui.format.value && ui.format.value !== 'original' ? ui.format.value : settings.exportFormat;
  ui.format.replaceChildren();
  if (formats.length === 0) {
    const type = recording.mimeType.startsWith('video/mp4') ? 'MP4' : 'WebM';
    ui.format.add(new Option(`${type} (as recorded)`, 'original'));
    ui.format.disabled = true;
  } else {
    for (const format of formats) ui.format.add(new Option(format.label, format.id));
    ui.format.value = formats.some((format) => format.id === previous) ? previous : formats[0].id;
    ui.format.disabled = Boolean(conversion);
  }
  updateFormatNote();
}

// Opus sound in an MP4 file is valid, but some players do not play it.
function updateFormatNote() {
  const format = formatsFor(selectedChoiceId()).find((item) => item.id === ui.format.value);
  ui.formatNote.textContent = format && format.container === 'mp4' && format.audioCodec === 'opus'
    ? 'Some players (for example, Windows Media Player) cannot play Opus sound in an MP4 file. They play the ' +
      'video with no sound. Browsers and VLC play the sound. Before you share the file, test it in the app that people will use.'
    : '';
}

function setBusy(busy) {
  saving = busy;
  ui.save.disabled = busy;
  ui.again.disabled = busy;
  ui.format.disabled = busy || ui.format.value === 'original';
  ui.presets.disabled = busy;
  ui.cameraPosition.disabled = busy;
  ui.cameraSize.disabled = busy;
  ui.progress.classList.toggle('active', busy);
  if (busy) {
    cancelRequested = false;
    updateProgress(0);
  }
}

function updateProgress(progress) {
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  ui.progressFill.style.width = `${percent}%`;
  ui.progressText.textContent = `Making the file... ${percent}%`;
}

function cancelledError() {
  return Object.assign(new Error('Conversion has been canceled.'), { name: 'ConversionCanceledError' });
}

// Draw the camera frame as a circle with a light ring.
function drawCameraBubble(ctx, source, box) {
  const radius = box.diameter / 2;
  const cx = box.x + radius;
  const cy = box.y + radius;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(source, box.x, box.y, box.diameter, box.diameter);
  ctx.restore();
  const ring = Math.max(2, Math.round(box.diameter * 0.02));
  ctx.save();
  ctx.lineWidth = ring;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius - ring / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Frame-by-frame drawing of the camera bubble onto the screen video. The
// camera frames come in time order and follow the screen frames' times.
async function createCameraOverlay(mb, width, height) {
  const box = cameraBubbleRect(width, height, ui.cameraPosition.value, ui.cameraSize.value);
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(recording.camera.blob) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    input.dispose();
    return null;
  }
  const sink = new mb.CanvasSink(track, { width: box.diameter, height: box.diameter, fit: 'cover' });
  const frames = sink.canvases(0);
  let current = null;
  let next = (await frames.next()).value || null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  return {
    process: async (sample) => {
      const time = sample.timestamp;
      while (next && next.timestamp <= time) {
        current = next;
        const step = await frames.next();
        next = step.done ? null : step.value;
      }
      // Before the first camera frame, show it early. After the camera
      // stopped (for example, unplugged), show no bubble.
      const frame = current || next;
      const cameraEnded = !next && current && time > current.timestamp + current.duration + 0.5;
      sample.draw(ctx, 0, 0, width, height);
      if (frame && !cameraEnded) drawCameraBubble(ctx, frame.canvas, box);
      return new mb.VideoSample(canvas, { timestamp: sample.timestamp, duration: sample.duration });
    },
    dispose: async () => {
      await frames.return();
      input.dispose();
    }
  };
}

// Run one Mediabunny conversion of the recording to a new Blob.
// withCamera: draw the camera bubble (needs trackOptions.video with a size).
async function convertRecording(trackOptions, container, withCamera = false) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(recording.blob) });
  let overlay = null;
  try {
    if (withCamera) {
      const { width, height } = trackOptions.video;
      overlay = await createCameraOverlay(mb, width, height);
      if (overlay) {
        trackOptions.video.process = overlay.process;
        trackOptions.video.processedWidth = width;
        trackOptions.video.processedHeight = height;
      }
    }
    const format = container === 'mp4'
      ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' })
      : new mb.WebMOutputFormat();
    const output = new mb.Output({ format, target: new mb.BufferTarget() });
    conversion = await mb.Conversion.init({ input, output, showWarnings: false, ...trackOptions });
    // Cancel can come before the conversion exists.
    if (cancelRequested) {
      await conversion.cancel();
      throw cancelledError();
    }
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((track) => track.reason).join(', ');
      throw new Error(`This browser cannot make this file (${reasons || 'no usable track'}).`);
    }
    // A valid conversion can still leave out the sound, for example when
    // the browser cannot decode or encode it. A video without its sound is
    // not what you asked for, so stop.
    const lostAudio = recording.hasAudio && conversion.discardedTracks.find((item) => item.track.type === 'audio');
    if (lostAudio) throw new Error(`This browser cannot put the sound in this file (${lostAudio.reason}).`);
    conversion.onProgress = updateProgress;
    await conversion.execute();
    if (cancelRequested) throw cancelledError();
    const blob = new Blob([output.target.buffer], { type: container === 'mp4' ? 'video/mp4' : 'video/webm' });
    // An audio encoder can also give no output at all.
    if (recording.hasAudio && !(await hasAudioPackets(mb, blob))) throw new Error('The sound did not go into the file.');
    return blob;
  } finally {
    if (overlay) await overlay.dispose();
    input.dispose();
  }
}

// True when the recording has sound packets. When the check fails or gives
// no answer in 3 s, the sound counts as there, as before the check.
async function hasSoundData(blob) {
  const check = loadMediabunny().then((mb) => hasAudioPackets(mb, blob)).catch((error) => {
    console.warn('Could not check the sound of the recording:', error);
    return true;
  });
  return Promise.race([check, new Promise((resolve) => setTimeout(resolve, 3000, true))]);
}

// True when the file has a sound track with at least one packet.
async function hasAudioPackets(mb, blob) {
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    return Boolean(track && await new mb.EncodedPacketSink(track).getFirstPacket());
  } finally {
    input.dispose();
  }
}

function isCancelled(error) {
  return cancelRequested || (Boolean(error) && error.name === 'ConversionCanceledError');
}

// "As recorded": copy the tracks into a new file without re-encoding. The
// new file has a duration and an index, so players can seek in it.
// MediaRecorder files have neither. If this fails, save the raw file. When
// the recording has sound, the raw file has sound packets (see
// finishRecording).
async function remuxRecording() {
  try {
    return await convertRecording({}, recording.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm');
  } catch (error) {
    if (isCancelled(error)) throw error;
    console.warn('Could not add an index to the recording. Saving it as it is.', error);
    return recording.blob;
  }
}

async function saveRecording(choiceId = selectedChoiceId()) {
  if (!recording || saving || (exportSupport === null && recording.camera)) return;
  const rec = recording;
  const choice = exportChoices().find((item) => item.id === choiceId);
  if (!choice || !choice.enabled) return;

  resetMessage();
  setBusy(true);
  try {
    let blob;
    let suffix = '';
    if (!choice.plan) {
      blob = await remuxRecording();
    } else {
      const formats = formatsFor(choice.id);
      const format = formats.find((item) => item.id === ui.format.value) || formats[0];
      const plan = choice.plan;
      const trackOptions = {
        video: {
          width: plan.width,
          height: plan.height,
          // planExport() keeps the aspect ratio, so 'fill' only absorbs the
          // rounding to even sizes (no black bars).
          fit: 'fill',
          frameRate: plan.frameRate,
          // "Full size" (with the camera) can need another codec.
          codec: choice.id === 'original' ? format.fullSizeCodec : format.videoCodec,
          bitrate: plan.videoBitsPerSecond,
          forceTranscode: true
        }
      };
      if (rec.hasAudio) {
        // Copy the recorded Opus sound as it is. A new encode would not make
        // the file much smaller, and it depends on the browser's audio
        // encoder: when that fails, the sound is lost. (A bitrate would force
        // a new encode.) AAC sound for MP4 needs a new encode.
        trackOptions.audio = format.audioCodec === 'opus'
          ? { codec: 'opus' }
          : { codec: format.audioCodec, bitrate: plan.audioBitsPerSecond };
      }
      blob = await convertRecording(trackOptions, format.container, cameraOn());
      if (choice.id !== 'original') suffix = `-${plan.height}p`;
    }
    // The file is ready. The download step cannot be cancelled.
    conversion = null;
    ui.progress.classList.remove('active');

    const settings = await getSettings();
    const filename = buildFilename(`${rec.baseName}${suffix}`, extensionForMimeType(blob.type), settings.downloadFolder);
    const downloadId = await downloadBlob(blob, filename, settings.saveAs);
    if (downloadId === null) {
      showMessage('The file was not saved.', 'info');
      return;
    }
    if (recording !== rec) return;
    rec.saved = true;
    lastDownloadId = downloadId;
    ui.savedText.textContent = `Saved: ${filename} (${formatBytes(blob.size)})`;
    ui.saved.classList.add('show');
  } catch (error) {
    if (isCancelled(error)) {
      showMessage('Stopped. Nothing was saved.', 'info');
    } else {
      console.error('Save failed:', error);
      showMessage(`Could not save the video: ${error.message}`, 'error');
    }
  } finally {
    conversion = null;
    setBusy(false);
  }
}

function confirmDiscard() {
  return window.confirm('Discard this recording? It is not saved.');
}

function clearReview() {
  recording = null;
  exportSupport = null;
  lastDownloadId = null;
  ui.saved.classList.remove('show');
  ui.presets.replaceChildren();
  for (const video of [ui.preview, ui.previewCamera]) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  ui.previewCamera.classList.remove('show');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (previewCameraUrl) URL.revokeObjectURL(previewCameraUrl);
  previewUrl = null;
  previewCameraUrl = null;
}

// Keep the camera preview in step with the screen preview.
function syncPreviewCamera() {
  if (!previewCameraUrl) return;
  const camera = ui.previewCamera;
  if (Math.abs(camera.currentTime - ui.preview.currentTime) > 0.25) camera.currentTime = ui.preview.currentTime;
}

// ---------------------------------------------------------------- Events

ui.start.addEventListener('click', startRecording);
ui.pause.addEventListener('click', togglePause);
ui.stop.addEventListener('click', stopRecording);
// Remember the choice for the next recording (only when the person saves,
// not when "Save at once" saves automatically).
ui.save.addEventListener('click', () => {
  const choiceId = selectedChoiceId();
  const patch = { exportPreset: choiceId };
  if (ui.format.value !== 'original') patch.exportFormat = ui.format.value;
  saveSettings(patch);
  saveRecording(choiceId);
});
ui.cancelExport.addEventListener('click', () => {
  cancelRequested = true;
  if (conversion) conversion.cancel();
});
ui.presets.addEventListener('change', async () => {
  renderFormats(await getSettings());
});
ui.format.addEventListener('change', updateFormatNote);
for (const select of [ui.cameraPosition, ui.cameraSize]) {
  select.addEventListener('change', async () => {
    const patch = { cameraSize: ui.cameraSize.value };
    if (ui.cameraPosition.value !== 'hidden') patch.cameraPosition = ui.cameraPosition.value;
    saveSettings(patch);
    renderReview(await getSettings());
  });
}
ui.preview.addEventListener('play', () => {
  if (!previewCameraUrl) return;
  syncPreviewCamera();
  ui.previewCamera.play().catch(() => {});
});
ui.preview.addEventListener('pause', () => ui.previewCamera.pause());
ui.preview.addEventListener('seeked', syncPreviewCamera);
ui.preview.addEventListener('timeupdate', syncPreviewCamera);
ui.showFile.addEventListener('click', () => {
  if (lastDownloadId !== null) browser.downloads.show(lastDownloadId);
});
ui.again.addEventListener('click', () => {
  if (recording && !recording.saved && !confirmDiscard()) return;
  clearMessage();
  clearReview();
  setView('setup');
  ensureCamera();
  soundInputs.forEach(ensureSoundInput);
});
ui.settingsLink.addEventListener('click', () => browser.runtime.openOptionsPage());

window.addEventListener('beforeunload', (event) => {
  const recordingNow = mediaRecorder && mediaRecorder.state !== 'inactive';
  const unsaved = recording && !recording.saved;
  if (recordingNow || unsaved || conversion) {
    event.preventDefault();
    event.returnValue = '';
  }
});
// If the tab closes or navigates during a recording, clear the badge.
window.addEventListener('pagehide', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') reportState('idle');
});

setView('setup');
initOptions();
