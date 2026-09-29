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
  mimeType: '',             // Empty means "first supported type"
  videoBitsPerSecond: 5000000,
  frameRate: 30,
  countdown: 3,
  microphone: false,
  systemAudio: false
});

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

if (typeof module !== 'undefined') {
  module.exports = { SETTINGS_DEFAULTS, RECORDER_DEFAULTS, isRestrictedUrl, fileTimestamp, sanitizeFolder, buildFilename, imageMimeType, extensionForMimeType };
}
