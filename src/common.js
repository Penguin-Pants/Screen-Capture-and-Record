// Shared helpers for all extension pages (background, editor, recorder, options).
'use strict';

const SETTINGS_DEFAULTS = Object.freeze({
  afterCapture: 'editor',   // 'editor' | 'download' | 'clipboard'
  imageFormat: 'png',       // 'png' | 'jpeg'
  jpegQuality: 92,          // 1-100
  downloadFolder: '',       // Subfolder inside the Downloads folder
  saveAs: false,            // Show the "Save as" dialog for each file
  loadLazyContent: true     // Scroll the page once before a full-page capture
});

const RECORDER_DEFAULTS = Object.freeze({
  profile: 'high',          // A RECORDING_PROFILES id
  afterRecording: 'review', // 'review' | 'save'
  exportPreset: 'medium',   // 'original' or an EXPORT_PRESETS id
  exportFormat: 'webm',     // 'webm' | 'mp4'
  countdown: 3,
  microphone: false,
  systemAudio: false
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

// Opus audio: enough for a voice. System audio (music) gets more.
const VOICE_AUDIO_BITS_PER_SECOND = 64000;
const SYSTEM_AUDIO_BITS_PER_SECOND = 128000;
// Encoders can go a little above the target bitrate, so export estimates
// add this margin. Screens with little motion often use less.
const EXPORT_ESTIMATE_MARGIN = 1.1;
// A preset must save at least this share of the original size to be offered.
const EXPORT_MIN_SAVING = 0.1;

async function getSettings() {
  const { settings } = await browser.storage.local.get('settings');
  return { ...SETTINGS_DEFAULTS, ...settings };
}

async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings });
  return settings;
}

async function getRecorderSettings() {
  const { recorder } = await browser.storage.local.get('recorder');
  return { ...RECORDER_DEFAULTS, ...recorder };
}

async function saveRecorderSettings(patch) {
  const recorder = { ...(await getRecorderSettings()), ...patch };
  await browser.storage.local.set({ recorder });
  return recorder;
}

// Pages where Firefox does not allow extensions to capture or run scripts.
function isRestrictedUrl(url = '') {
  return /^(about|moz-extension|view-source|resource|chrome|jar):/i.test(url) ||
    /^https?:\/\/(addons\.mozilla\.org|accounts\.firefox\.com)\//i.test(url);
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

function imageMimeType(format) {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

function extensionForMimeType(mimeType) {
  if (mimeType.startsWith('image/jpeg')) return 'jpg';
  if (mimeType.startsWith('image/png')) return 'png';
  if (mimeType.startsWith('video/mp4')) return 'mp4';
  return 'webm';
}

// Encode a canvas to a Blob. JPEG has no alpha channel, so transparent
// pixels get a white background instead of black.
function encodeCanvas(canvas, format = 'png', quality = 92) {
  let source = canvas;
  if (format === 'jpeg') {
    source = document.createElement('canvas');
    source.width = canvas.width;
    source.height = canvas.height;
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, source.width, source.height);
    ctx.drawImage(canvas, 0, 0);
  }
  return new Promise((resolve, reject) => {
    source.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The image is too large to encode.'));
    }, imageMimeType(format), quality / 100);
  });
}

async function blobToCanvas(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

// Save a Blob with the downloads API. Returns the download ID, or null when
// the person cancels the "Save as" dialog. The object URL stays valid until
// the download ends, then it is released.
async function downloadBlob(blob, filename, saveAs = false) {
  const url = URL.createObjectURL(blob);
  let downloadId;
  try {
    downloadId = await browser.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
  } catch (error) {
    URL.revokeObjectURL(url);
    if (/cancel/i.test(error.message)) return null;
    throw error;
  }
  const release = (delta) => {
    if (delta.id !== downloadId || !delta.state || delta.state.current === 'in_progress') return;
    browser.downloads.onChanged.removeListener(release);
    URL.revokeObjectURL(url);
  };
  browser.downloads.onChanged.addListener(release);
  return downloadId;
}

// Copy an image to the clipboard. Needs the "clipboardWrite" permission.
async function copyImageBlob(blob) {
  const type = blob.type === 'image/jpeg' ? 'jpeg' : 'png';
  await browser.clipboard.setImageData(await blob.arrayBuffer(), type);
}

function getRecordingProfile(id) {
  return RECORDING_PROFILES.find((profile) => profile.id === id) ||
    RECORDING_PROFILES.find((profile) => profile.id === RECORDER_DEFAULTS.profile);
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

// Upper estimate of the recording size per minute for a profile.
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

// Plan a smaller copy of a recording.
// source: { width, height, seconds, bytes, frameRate, hasAudio }
function planExport(preset, source) {
  const size = fitWithin(source.width, source.height, preset.maxWidth, preset.maxHeight);
  const audioBitsPerSecond = source.hasAudio ? VOICE_AUDIO_BITS_PER_SECOND : 0;
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

if (typeof module !== 'undefined') {
  module.exports = {
    SETTINGS_DEFAULTS, RECORDER_DEFAULTS, RECORDING_PROFILES, EXPORT_PRESETS, EXPORT_ESTIMATE_MARGIN,
    VOICE_AUDIO_BITS_PER_SECOND, isRestrictedUrl, fileTimestamp, sanitizeFolder, buildFilename, imageMimeType,
    extensionForMimeType, getRecordingProfile, formatBytes, formatDuration, estimateBytes, bytesPerMinute,
    fitWithin, planExport
  };
}
