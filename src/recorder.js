// Screen recorder page.
'use strict';

const FORMATS = [
  { id: 'webm-vp9', label: 'WebM (VP9)', withAudio: 'video/webm;codecs=vp9,opus', videoOnly: 'video/webm;codecs=vp9' },
  { id: 'webm-vp8', label: 'WebM (VP8)', withAudio: 'video/webm;codecs=vp8,opus', videoOnly: 'video/webm;codecs=vp8' },
  { id: 'webm-av1', label: 'WebM (AV1)', withAudio: 'video/webm;codecs=av1,opus', videoOnly: 'video/webm;codecs=av1' },
  { id: 'mp4-h264', label: 'MP4 (H.264)', withAudio: 'video/mp4;codecs=avc1,mp4a.40.2', videoOnly: 'video/mp4;codecs=avc1' },
  { id: 'webm', label: 'WebM (browser default)', withAudio: 'video/webm', videoOnly: 'video/webm' }
];

const $ = (id) => document.getElementById(id);
const ui = {
  message: $('message'),
  setup: $('setup'),
  live: $('live'),
  result: $('result'),
  format: $('formatSelect'),
  quality: $('qualitySelect'),
  fps: $('fpsSelect'),
  countdownSelect: $('countdownSelect'),
  mic: $('micCheck'),
  audio: $('audioCheck'),
  start: $('startBtn'),
  pause: $('pauseBtn'),
  stop: $('stopBtn'),
  timer: $('timer'),
  recIndicator: $('recIndicator'),
  recLabel: $('recLabel'),
  countdown: $('countdown'),
  preview: $('preview'),
  resultMeta: $('resultMeta'),
  showFile: $('showFileBtn'),
  again: $('againBtn')
};

// Recording session state.
let mediaRecorder = null;
let chunks = [];
let sourceStreams = [];   // Every stream we opened. All tracks stop at the end.
let audioContext = null;
let activeMs = 0;         // Recorded time before the last resume
let resumedAt = 0;
let timerInterval = null;
let lastDownloadId = null;
let previewUrl = null;
let cancelCountdown = null;

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

function supportedFormats() {
  return FORMATS.filter((format) => MediaRecorder.isTypeSupported(format.withAudio) || MediaRecorder.isTypeSupported(format.videoOnly));
}

function chooseMimeType(formatId, hasAudio) {
  const format = FORMATS.find((f) => f.id === formatId) || FORMATS[0];
  const preferred = hasAudio ? format.withAudio : format.videoOnly;
  if (MediaRecorder.isTypeSupported(preferred)) return preferred;
  const fallback = hasAudio ? format.videoOnly : format.withAudio;
  if (MediaRecorder.isTypeSupported(fallback)) return fallback;
  return '';
}

async function initOptions() {
  const formats = supportedFormats();
  for (const format of formats) {
    ui.format.add(new Option(format.label, format.id));
  }

  const saved = await getRecorderSettings();
  if (formats.some((f) => f.id === saved.mimeType)) ui.format.value = saved.mimeType;
  ui.quality.value = String(saved.videoBitsPerSecond);
  ui.fps.value = String(saved.frameRate);
  ui.countdownSelect.value = String(saved.countdown);
  ui.mic.checked = saved.microphone;
  ui.audio.checked = saved.systemAudio;

  const persist = () => saveRecorderSettings({
    mimeType: ui.format.value,
    videoBitsPerSecond: Number(ui.quality.value),
    frameRate: Number(ui.fps.value),
    countdown: Number(ui.countdownSelect.value),
    microphone: ui.mic.checked,
    systemAudio: ui.audio.checked
  });
  [ui.format, ui.quality, ui.fps, ui.countdownSelect, ui.mic, ui.audio].forEach((el) => el.addEventListener('change', persist));
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

async function buildStream(displayStream) {
  const tracks = [...displayStream.getVideoTracks()];
  const audioSources = [];

  if (ui.audio.checked) {
    if (displayStream.getAudioTracks().length > 0) {
      audioSources.push(new MediaStream(displayStream.getAudioTracks()));
    } else {
      showMessage('Firefox did not supply system or tab audio. The video records without it.', 'info');
    }
  }

  if (ui.mic.checked) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      sourceStreams.push(micStream);
      audioSources.push(micStream);
    } catch (error) {
      showMessage(`The microphone is not available (${error.message}). The video records without it.`, 'error');
    }
  }

  if (audioSources.length === 1) {
    tracks.push(...audioSources[0].getAudioTracks());
  } else if (audioSources.length > 1) {
    audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    for (const source of audioSources) {
      audioContext.createMediaStreamSource(source).connect(destination);
    }
    tracks.push(...destination.stream.getAudioTracks());
  }

  return new MediaStream(tracks);
}

async function startRecording() {
  clearMessage();
  ui.start.disabled = true;
  try {
    const frameRate = Number(ui.fps.value);
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: frameRate, max: frameRate } },
      audio: ui.audio.checked
    });
    sourceStreams = [displayStream];

    // Stop when the person ends sharing from the Firefox sharing indicator.
    displayStream.getVideoTracks()[0].addEventListener('ended', stopRecording);

    const stream = await buildStream(displayStream);
    const hasAudio = stream.getAudioTracks().length > 0;
    const mimeType = chooseMimeType(ui.format.value, hasAudio);
    const options = { videoBitsPerSecond: Number(ui.quality.value) };
    if (mimeType) options.mimeType = mimeType;
    if (hasAudio) options.audioBitsPerSecond = 128000;

    const countdownDone = await runCountdown(Number(ui.countdownSelect.value));
    if (!countdownDone || displayStream.getVideoTracks()[0].readyState === 'ended') {
      releaseStreams();
      setView('setup');
      return;
    }

    chunks = [];
    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    mediaRecorder.onstop = saveRecording;
    mediaRecorder.onerror = (event) => {
      showMessage(`Recording error: ${(event.error && event.error.message) || 'unknown error'}`, 'error');
      stopRecording();
    };
    mediaRecorder.start(1000);

    activeMs = 0;
    resumedAt = Date.now();
    updateTimer();
    timerInterval = setInterval(updateTimer, 500);
    setPausedUi(false);
    setView('live');
    reportState('recording');
  } catch (error) {
    releaseStreams();
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
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    activeMs += Date.now() - resumedAt;
    setPausedUi(true);
    reportState('paused');
  } else if (mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
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
    mediaRecorder.stop(); // onstop saves the file.
  }
  releaseStreams();
  clearInterval(timerInterval);
  reportState('idle');
}

// Stop every track of every stream we opened (screen, microphone) and
// close the audio mixer, so no capture indicator stays on.
function releaseStreams() {
  for (const stream of sourceStreams) {
    stream.getTracks().forEach((track) => track.stop());
  }
  sourceStreams = [];
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  audioContext = null;
}

async function saveRecording() {
  const recorder = mediaRecorder;
  mediaRecorder = null;
  if (chunks.length === 0) {
    setView('setup');
    showMessage('The recording is empty. Nothing was saved.', 'error');
    return;
  }

  const mimeType = (recorder && recorder.mimeType) || 'video/webm';
  const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
  chunks = [];

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  ui.preview.src = previewUrl;
  // Forget the previous file before the new one is saved, so "Show file"
  // never opens an older recording while the save is pending.
  lastDownloadId = null;
  ui.showFile.disabled = true;
  ui.resultMeta.textContent = 'Saving...';
  setView('result');

  const settings = await getSettings();
  const filename = buildFilename(`recording-${fileTimestamp()}`, extensionForMimeType(mimeType), settings.downloadFolder);
  const sizeMb = (blob.size / 1048576).toFixed(1);
  try {
    lastDownloadId = await downloadBlob(blob, filename, settings.saveAs);
    ui.showFile.disabled = lastDownloadId === null;
    ui.resultMeta.textContent = lastDownloadId === null
      ? `Not saved (${sizeMb} MB). You can still play it here.`
      : `Saved: ${filename} (${sizeMb} MB)`;
  } catch (error) {
    ui.showFile.disabled = true;
    showMessage(`Could not save the recording: ${error.message}`, 'error');
  }
}

function updateTimer() {
  const running = mediaRecorder && mediaRecorder.state === 'recording';
  const elapsed = Math.floor((activeMs + (running ? Date.now() - resumedAt : 0)) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  ui.timer.textContent = hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

ui.start.addEventListener('click', startRecording);
ui.pause.addEventListener('click', togglePause);
ui.stop.addEventListener('click', stopRecording);
ui.showFile.addEventListener('click', () => {
  if (lastDownloadId !== null) browser.downloads.show(lastDownloadId);
});
ui.again.addEventListener('click', () => {
  clearMessage();
  ui.preview.removeAttribute('src');
  ui.preview.load();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  setView('setup');
});

window.addEventListener('beforeunload', (event) => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    event.preventDefault();
    event.returnValue = '';
  }
});

setView('setup');
initOptions();
