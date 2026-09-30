// Shared helpers for the extension pages (background, recorder, options).
'use strict';

const SETTINGS_DEFAULTS = Object.freeze({
  profile: 'high',              // A RECORDING_PROFILES id
  afterRecording: 'review',     // 'review' | 'save'
  exportPreset: 'medium',       // 'original' or an EXPORT_PRESETS id
  exportFormat: 'webm',         // 'webm' | 'mp4'
  countdown: 3,
  microphone: false,
  microphoneDeviceId: '',       // Empty means the default microphone
  computerSound: false,         // Record the computer sound from a loopback device
  computerSoundDeviceId: '',    // Empty means the first loopback device
  camera: false,                // Record the webcam too
  cameraDeviceId: '',           // Empty means the default camera
  cameraPosition: 'bottom-right', // A CAMERA_POSITIONS id, or 'hidden'
  cameraSize: 'medium',         // A CAMERA_SIZES id
  downloadFolder: '',           // Subfolder inside the Downloads folder
  saveAs: false                 // Show the "Save as" dialog for each file
});

// File size depends only on bitrate and length: bytes = bits per second
// x seconds / 8. Resolution and frame rate decide how sharp the video is
// at that size. A null maximum keeps the full screen size.
const RECORDING_PROFILES = Object.freeze([
  { id: 'max', label: 'Maximum', maxWidth: null, maxHeight: null, frameRate: 30, videoBitsPerSecond: 5000000 },
  { id: 'smooth', label: 'Smooth motion', maxWidth: 1920, maxHeight: 1080, frameRate: 60, videoBitsPerSecond: 4000000 },
  { id: 'high', label: 'High', maxWidth: 1920, maxHeight: 1080, frameRate: 30, videoBitsPerSecond: 2000000 },
  { id: 'medium', label: 'Medium', maxWidth: 1280, maxHeight: 720, frameRate: 30, videoBitsPerSecond: 1000000 },
  { id: 'small', label: 'Small', maxWidth: 854, maxHeight: 480, frameRate: 15, videoBitsPerSecond: 500000 }
]);

// Presets for a smaller copy after recording, from large to small.
const EXPORT_PRESETS = Object.freeze([
  { id: 'high', label: 'High', maxWidth: 1920, maxHeight: 1080, frameRate: 30, videoBitsPerSecond: 2000000 },
  { id: 'medium', label: 'Medium', maxWidth: 1280, maxHeight: 720, frameRate: 30, videoBitsPerSecond: 1000000 },
  { id: 'small', label: 'Small', maxWidth: 854, maxHeight: 480, frameRate: 24, videoBitsPerSecond: 500000 },
  { id: 'tiny', label: 'Tiny', maxWidth: 640, maxHeight: 360, frameRate: 15, videoBitsPerSecond: 250000 }
]);

// Opus audio from the microphone: enough for a voice. The computer sound
// (music, for example) gets more.
const VOICE_AUDIO_BITS_PER_SECOND = 64000;
const COMPUTER_AUDIO_BITS_PER_SECOND = 128000;
// Encoders can go a little above the target bitrate, so export estimates
// add this margin. Screens with little motion often use less.
const EXPORT_ESTIMATE_MARGIN = 1.1;
// A preset must save at least this share of the original size to be offered.
const EXPORT_MIN_SAVING = 0.1;

// The webcam records to its own file while you record. When you save, it
// is drawn as a round "bubble" in a corner of the screen video.
const CAMERA_BITS_PER_SECOND = 1500000;
const CAMERA_POSITIONS = Object.freeze([
  { id: 'bottom-right', label: 'Bottom right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'top-right', label: 'Top right' },
  { id: 'top-left', label: 'Top left' }
]);
// Bubble diameter as a share of the shorter video side.
const CAMERA_SIZES = Object.freeze([
  { id: 'small', label: 'Small', share: 0.2 },
  { id: 'medium', label: 'Medium', share: 0.28 },
  { id: 'large', label: 'Large', share: 0.36 }
]);
const CAMERA_MARGIN_SHARE = 0.03;

// Each setting has its own storage key ("setting.<name>"). A save writes
// only the keys it changes, so two quick changes, or changes from two
// pages, cannot overwrite each other.
const SETTINGS_PREFIX = 'setting.';

async function getSettings() {
  const names = Object.keys(SETTINGS_DEFAULTS);
  const stored = await browser.storage.local.get(names.map((name) => SETTINGS_PREFIX + name));
  const settings = { ...SETTINGS_DEFAULTS };
  for (const name of names) {
    if (SETTINGS_PREFIX + name in stored) settings[name] = stored[SETTINGS_PREFIX + name];
  }
  return settings;
}

async function saveSettings(patch) {
  const values = {};
  for (const [name, value] of Object.entries(patch)) {
    if (name in SETTINGS_DEFAULTS) values[SETTINGS_PREFIX + name] = value;
  }
  await browser.storage.local.set(values);
}

// Local time stamp that is safe in file names: 2026-09-29_14-05-09
function fileTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

// Make a folder setting safe for downloads.download(): relative path, no "..",
// no characters that Windows, macOS or Linux reject.
function sanitizeFolder(folder) {
  return String(folder || '')
    .split(/[\\/]+/)
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, '').trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function buildFilename(baseName, extension, folder) {
  const safeFolder = sanitizeFolder(folder);
  const name = `${baseName}.${extension}`;
  return safeFolder ? `${safeFolder}/${name}` : name;
}

function extensionForMimeType(mimeType) {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
}

// Save a Blob with the downloads API. Resolves with the download ID when the
// file is complete, or with null when the person cancels (in the "Save as"
// dialog or in the downloads panel). Rejects when the download fails, for
// example when the disk is full. The object URL is released at the end.
async function downloadBlob(blob, filename, saveAs = false) {
  const url = URL.createObjectURL(blob);
  // Listen before the download starts: a small file can be complete before
  // download() gives its ID.
  const changes = [];
  let onChange = (delta) => changes.push(delta);
  const listener = (delta) => onChange(delta);
  browser.downloads.onChanged.addListener(listener);
  try {
    let downloadId;
    try {
      downloadId = await browser.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
    } catch (error) {
      if (/cancel/i.test(error.message)) return null;
      throw error;
    }
    const end = await new Promise((resolve) => {
      onChange = (delta) => {
        if (delta.id === downloadId && delta.state && delta.state.current !== 'in_progress') resolve(delta);
      };
      changes.forEach(onChange);
    });
    if (end.state.current === 'complete') return downloadId;
    const reason = end.error ? end.error.current : 'unknown error';
    if (reason === 'USER_CANCELED') return null;
    throw new Error(`Firefox could not write the file (${reason}).`);
  } finally {
    browser.downloads.onChanged.removeListener(listener);
    URL.revokeObjectURL(url);
  }
}

function getRecordingProfile(id) {
  return RECORDING_PROFILES.find((profile) => profile.id === id) ||
    RECORDING_PROFILES.find((profile) => profile.id === SETTINGS_DEFAULTS.profile);
}

// Decimal units, like most file managers and upload limits: 1 MB = 1,000,000 bytes.
function formatBytes(bytes) {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  const megabytes = bytes / 1e6;
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`;
}

function estimateBytes(bitsPerSecond, seconds) {
  return (bitsPerSecond * seconds) / 8;
}

// Upper estimate of the saved file size per minute for a profile.
function bytesPerMinute(profile, audioBitsPerSecond = 0) {
  return estimateBytes(profile.videoBitsPerSecond + audioBitsPerSecond, 60);
}

// Scale width x height down (never up) to fit inside maxWidth x maxHeight,
// with the same aspect ratio. Video encoders need even sizes.
function fitWithin(width, height, maxWidth, maxHeight) {
  const scale = Math.min(1, maxWidth ? maxWidth / width : 1, maxHeight ? maxHeight / height : 1);
  const even = (value) => Math.max(2, 2 * Math.floor((value * scale) / 2));
  return { width: even(width), height: even(height) };
}

// Plan a re-encoded copy of a recording. A copy keeps the sound of the
// recording, so it has the audio bitrate of the recording (a voice if not
// given).
// source: { width, height, seconds, bytes, frameRate, hasAudio, audioBitsPerSecond }
function planExport(preset, source) {
  const size = fitWithin(source.width, source.height, preset.maxWidth, preset.maxHeight);
  const audioBitsPerSecond = source.hasAudio ? source.audioBitsPerSecond || VOICE_AUDIO_BITS_PER_SECOND : 0;
  const bytes = Math.round(
    estimateBytes(preset.videoBitsPerSecond + audioBitsPerSecond, source.seconds) * EXPORT_ESTIMATE_MARGIN
  );
  return {
    ...size,
    frameRate: Math.min(preset.frameRate, source.frameRate || preset.frameRate),
    videoBitsPerSecond: preset.videoBitsPerSecond,
    audioBitsPerSecond,
    bytes,
    smaller: bytes <= source.bytes * (1 - EXPORT_MIN_SAVING)
  };
}

// Where the camera bubble goes in a width x height video: a square box
// (the bubble is a circle inside it) with an even diameter.
function cameraBubbleRect(width, height, positionId, sizeId) {
  const shorter = Math.min(width, height);
  const size = CAMERA_SIZES.find((item) => item.id === sizeId) || CAMERA_SIZES[1];
  const diameter = Math.max(2, 2 * Math.round((shorter * size.share) / 2));
  const margin = Math.round(shorter * CAMERA_MARGIN_SHARE);
  const position = CAMERA_POSITIONS.some((item) => item.id === positionId) ? positionId : CAMERA_POSITIONS[0].id;
  return {
    x: position.endsWith('left') ? margin : width - margin - diameter,
    y: position.startsWith('top') ? margin : height - margin - diameter,
    diameter
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    SETTINGS_DEFAULTS, RECORDING_PROFILES, EXPORT_PRESETS, EXPORT_ESTIMATE_MARGIN, VOICE_AUDIO_BITS_PER_SECOND,
    COMPUTER_AUDIO_BITS_PER_SECOND,
    CAMERA_POSITIONS, CAMERA_SIZES, fileTimestamp, sanitizeFolder, buildFilename, extensionForMimeType,
    getRecordingProfile, formatBytes, formatDuration, estimateBytes, bytesPerMinute, fitWithin, planExport,
    cameraBubbleRect
  };
}
