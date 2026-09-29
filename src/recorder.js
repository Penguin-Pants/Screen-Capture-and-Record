// Screen recorder page. Records with a quality profile, shows the file size
// while recording, then shows the video with size options before saving.
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
  audio: $('audioCheck'),
  start: $('startBtn'),
  pause: $('pauseBtn'),
  stop: $('stopBtn'),
  timer: $('timer'),
  liveSize: $('liveSize'),
  recIndicator: $('recIndicator'),
  recLabel: $('recLabel'),
  countdown: $('countdown'),
  preview: $('preview'),
  details: $('details'),
  presets: $('presets'),
  exportNote: $('exportNote'),
  format: $('formatSelect'),
  progress: $('progress'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  cancelExport: $('cancelExportBtn'),
  saved: $('saved'),
  savedText: $('savedText'),
  showFile: $('showFileBtn'),
  save: $('saveBtn'),
  again: $('againBtn')
};

// Recording session state.
let mediaRecorder = null;
let chunks = [];
let recordedBytes = 0;
let sourceStreams = [];   // Every stream we opened. All tracks stop at the end.
let audioContext = null;
let activeMs = 0;         // Recorded time before the last resume
let resumedAt = 0;
let timerInterval = null;
let cancelCountdown = null;
let session = null;       // { profile, hasAudio, startedAt, captureSize }

// Review state. recording: { blob, mimeType, seconds, width, height,
// frameRate, hasAudio, baseName, saved }
let recording = null;
let previewUrl = null;
let lastDownloadId = null;
let exportSupport = null; // null while checking, then { library, formats }
let conversion = null;    // The running Mediabunny conversion, for Cancel
let cancelRequested = false;
let mediabunnyPromise = null;

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

// ---------------------------------------------------------------- Setup

function profileLabel(profile) {
  const size = profile.maxWidth ? `up to ${profile.maxWidth} × ${profile.maxHeight}` : 'full screen size';
  return `${profile.label}: ${size}, ${profile.frameRate} fps`;
}

// Audio bitrate for the recording: voice for the microphone, more when
// system or tab sound is part of the mix.
function audioBitsPerSecond(withSystemAudio, withMicrophone) {
  if (withSystemAudio) return SYSTEM_AUDIO_BITS_PER_SECOND;
  return withMicrophone ? VOICE_AUDIO_BITS_PER_SECOND : 0;
}

function updateProfileHint() {
  const profile = getRecordingProfile(ui.profile.value);
  const audio = audioBitsPerSecond(ui.audio.checked, ui.mic.checked);
  ui.profileHint.textContent =
    `About ${formatBytes(bytesPerMinute(profile, audio))} per minute. Often less when little moves on the screen.`;
}

async function initOptions() {
  for (const profile of RECORDING_PROFILES) {
    ui.profile.add(new Option(profileLabel(profile), profile.id));
  }

  const saved = await getRecorderSettings();
  ui.profile.value = getRecordingProfile(saved.profile).id;
  ui.countdownSelect.value = String(saved.countdown);
  ui.mic.checked = saved.microphone;
  ui.audio.checked = saved.systemAudio;
  updateProfileHint();

  const persist = () => saveRecorderSettings({
    profile: ui.profile.value,
    countdown: Number(ui.countdownSelect.value),
    microphone: ui.mic.checked,
    systemAudio: ui.audio.checked
  });
  [ui.profile, ui.countdownSelect, ui.mic, ui.audio].forEach((el) => el.addEventListener('change', () => {
    updateProfileHint();
    persist();
  }));
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

async function buildStream(displayStream) {
  const tracks = [...displayStream.getVideoTracks()];
  const audioSources = [];
  let hasSystemAudio = false;
  let hasMicrophone = false;

  if (ui.audio.checked) {
    if (displayStream.getAudioTracks().length > 0) {
      audioSources.push(new MediaStream(displayStream.getAudioTracks()));
      hasSystemAudio = true;
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
      hasMicrophone = true;
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

  return { stream: new MediaStream(tracks), audioBits: audioBitsPerSecond(hasSystemAudio, hasMicrophone) };
}

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

async function startRecording() {
  if (recording && !recording.saved && !confirmDiscard()) return;
  clearReview();
  clearMessage();
  ui.start.disabled = true;
  try {
    const profile = getRecordingProfile(ui.profile.value);
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: displayConstraints(profile),
      audio: ui.audio.checked
    });
    sourceStreams = [displayStream];

    // Stop when the person ends sharing from the Firefox sharing indicator.
    const videoTrack = displayStream.getVideoTracks()[0];
    videoTrack.addEventListener('ended', stopRecording);

    const { stream, audioBits } = await buildStream(displayStream);
    const hasAudio = stream.getAudioTracks().length > 0;
    const mimeType = chooseMimeType(hasAudio);
    const options = { videoBitsPerSecond: profile.videoBitsPerSecond };
    if (mimeType) options.mimeType = mimeType;
    if (hasAudio) options.audioBitsPerSecond = audioBits;

    const countdownDone = await runCountdown(Number(ui.countdownSelect.value));
    if (!countdownDone || videoTrack.readyState === 'ended') {
      releaseStreams();
      setView('setup');
      return;
    }

    const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
    session = {
      profile,
      hasAudio,
      startedAt: new Date(),
      captureSize: { width: settings.width || 0, height: settings.height || 0 }
    };
    chunks = [];
    recordedBytes = 0;
    mediaRecorder = new MediaRecorder(stream, options);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
        recordedBytes += event.data.size;
        updateLiveSize();
      }
    };
    mediaRecorder.onstop = finishRecording;
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
    if (mediaRecorder.state === 'recording') activeMs += Date.now() - resumedAt;
    mediaRecorder.stop(); // onstop opens the review.
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
  lastDownloadId = null;
  ui.saved.classList.remove('show');
  exportSupport = null;

  const size = await waitForVideoSize(ui.preview, session.captureSize);
  recording = {
    blob,
    mimeType,
    seconds: activeMs / 1000,
    width: size.width,
    height: size.height,
    frameRate: session.profile.frameRate,
    hasAudio: session.hasAudio,
    baseName: `recording-${fileTimestamp(session.startedAt)}`,
    saved: false
  };
  const settings = await getRecorderSettings();
  renderReview(settings);
  setView('result');

  const current = recording;
  exportSupport = await detectExportSupport(current);
  if (recording !== current) return; // A new recording started meanwhile.
  renderReview(settings);

  if (settings.afterRecording === 'save') {
    await saveRecording('original');
    if (recording === current && current.saved) {
      showMessage('The recording was saved as it is. You can also save a smaller copy below.', 'info');
    }
  }
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

// Which output formats this browser can encode. Smaller copies need the
// WebCodecs API (Firefox 130 or later).
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
    const webmVideo = await mb.getFirstEncodableVideoCodec(['vp9', 'vp8'], check);
    const webmAudio = rec.hasAudio ? await mb.getFirstEncodableAudioCodec(['opus']) : null;
    if (webmVideo && (!rec.hasAudio || webmAudio)) {
      formats.push({ id: 'webm', label: 'WebM (small files, plays in browsers)', container: 'webm', videoCodec: webmVideo, audioCodec: webmAudio });
    }
    const mp4Video = await mb.getFirstEncodableVideoCodec(['avc'], check);
    const mp4Audio = rec.hasAudio ? await mb.getFirstEncodableAudioCodec(['aac', 'opus']) : null;
    if (mp4Video && (!rec.hasAudio || mp4Audio)) {
      const label = mp4Audio === 'opus' ? 'MP4 (H.264 video, Opus audio)' : 'MP4 (plays in more apps)';
      formats.push({ id: 'mp4', label, container: 'mp4', videoCodec: mp4Video, audioCodec: mp4Audio });
    }
  } catch (error) {
    console.warn('Could not check the video encoders:', error);
  }
  return { library: true, formats };
}

function sourceInfo() {
  return {
    width: recording.width,
    height: recording.height,
    seconds: recording.seconds,
    bytes: recording.blob.size,
    frameRate: recording.frameRate,
    hasAudio: recording.hasAudio
  };
}

// All choices for "Save as", with their estimated sizes.
function exportChoices() {
  const canTranscode = Boolean(exportSupport && exportSupport.formats.length > 0 && recording.width);
  const choices = [{
    id: 'original',
    name: 'As recorded',
    spec: recording.width ? `${recording.width} × ${recording.height}, no quality loss` : 'No quality loss',
    size: formatBytes(recording.blob.size),
    enabled: true
  }];
  for (const preset of EXPORT_PRESETS) {
    const plan = recording.width ? planExport(preset, sourceInfo()) : null;
    let spec = plan ? `${plan.width} × ${plan.height}, ${plan.frameRate} fps` : '';
    if (plan && !plan.smaller) spec += ' (not smaller than the recording)';
    choices.push({
      id: preset.id,
      name: preset.label,
      spec,
      size: plan ? `about ${formatBytes(plan.bytes)}` : '',
      enabled: canTranscode && Boolean(plan) && plan.smaller,
      plan
    });
  }
  return choices;
}

function selectedChoiceId() {
  const checked = ui.presets.querySelector('input[name="exportPreset"]:checked');
  return checked ? checked.value : 'original';
}

function renderReview(settings) {
  const rec = recording;
  const parts = [`Length ${formatDuration(rec.seconds)}`];
  if (rec.width) parts.push(`${rec.width} × ${rec.height}`);
  parts.push(formatBytes(rec.blob.size));
  ui.details.textContent = parts.join(' · ');

  const choices = exportChoices();
  const current = ui.presets.querySelector('input:checked') ? selectedChoiceId() : settings.exportPreset;
  const wanted = choices.find((choice) => choice.id === current && choice.enabled) ? current : 'original';

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

  if (exportSupport === null) {
    ui.exportNote.textContent = 'Checking which formats this browser can make...';
  } else if (!exportSupport.library) {
    ui.exportNote.textContent = 'The export tool could not load. You can save the recording as it is.';
  } else if (exportSupport.formats.length === 0) {
    ui.exportNote.textContent = 'Smaller copies need Firefox 130 or later. You can save the recording as it is.';
  } else {
    ui.exportNote.textContent = 'Sizes are estimates. Screens with little motion often make smaller files.';
  }

  renderFormats(settings);
}

function renderFormats(settings) {
  const original = selectedChoiceId() === 'original';
  const formats = original || !exportSupport ? [] : exportSupport.formats;
  const previous = ui.format.value && ui.format.value !== 'original' ? ui.format.value : settings.exportFormat;
  ui.format.replaceChildren();
  if (formats.length === 0) {
    const type = recording.mimeType.startsWith('video/mp4') ? 'MP4' : 'WebM';
    ui.format.add(new Option(`${type} (as recorded)`, 'original'));
    ui.format.disabled = true;
    return;
  }
  for (const format of formats) ui.format.add(new Option(format.label, format.id));
  ui.format.value = formats.some((format) => format.id === previous) ? previous : formats[0].id;
  ui.format.disabled = Boolean(conversion);
}

function setBusy(busy) {
  ui.save.disabled = busy;
  ui.again.disabled = busy;
  ui.format.disabled = busy || selectedChoiceId() === 'original';
  ui.presets.disabled = busy;
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

// Run one Mediabunny conversion of the recording to a new Blob.
async function convertRecording(trackOptions, container) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(recording.blob) });
  try {
    const format = container === 'mp4'
      ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' })
      : new mb.WebMOutputFormat();
    const output = new mb.Output({ format, target: new mb.BufferTarget() });
    conversion = await mb.Conversion.init({ input, output, showWarnings: false, ...trackOptions });
    // Cancel can come before the conversion exists.
    if (cancelRequested) {
      await conversion.cancel();
      throw Object.assign(new Error('Conversion has been canceled.'), { name: 'ConversionCanceledError' });
    }
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((track) => track.reason).join(', ');
      throw new Error(`This browser cannot make this file (${reasons || 'no usable track'}).`);
    }
    conversion.onProgress = updateProgress;
    await conversion.execute();
    if (cancelRequested) {
      throw Object.assign(new Error('Conversion has been canceled.'), { name: 'ConversionCanceledError' });
    }
    return new Blob([output.target.buffer], { type: container === 'mp4' ? 'video/mp4' : 'video/webm' });
  } finally {
    input.dispose();
  }
}

function isCancelled(error) {
  return cancelRequested || (Boolean(error) && error.name === 'ConversionCanceledError');
}

// "As recorded": copy the tracks into a new file without re-encoding. The
// new file has a duration and an index, so players can seek in it.
// MediaRecorder files have neither. If this fails, save the raw file.
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
  if (!recording || conversion) return;
  const rec = recording;
  const choice = exportChoices().find((item) => item.id === choiceId);
  if (!choice || !choice.enabled) return;

  clearMessage();
  setBusy(true);
  try {
    let blob;
    let suffix = '';
    if (choice.id === 'original') {
      blob = await remuxRecording();
    } else {
      const format = exportSupport.formats.find((item) => item.id === ui.format.value) || exportSupport.formats[0];
      const plan = choice.plan;
      const trackOptions = {
        video: {
          width: plan.width,
          height: plan.height,
          // planExport() keeps the aspect ratio, so 'fill' only absorbs the
          // rounding to even sizes (no black bars).
          fit: 'fill',
          frameRate: plan.frameRate,
          codec: format.videoCodec,
          bitrate: plan.videoBitsPerSecond,
          forceTranscode: true
        }
      };
      if (rec.hasAudio) {
        trackOptions.audio = { codec: format.audioCodec, bitrate: plan.audioBitsPerSecond, forceTranscode: true };
      }
      blob = await convertRecording(trackOptions, format.container);
      suffix = `-${plan.height}p`;
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
  ui.preview.removeAttribute('src');
  ui.preview.load();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

// ---------------------------------------------------------------- Events

ui.start.addEventListener('click', startRecording);
ui.pause.addEventListener('click', togglePause);
ui.stop.addEventListener('click', stopRecording);
// Remember the choice for the next recording (only when the person saves,
// not when "Save at once" saves the recording as it is).
ui.save.addEventListener('click', () => {
  const choiceId = selectedChoiceId();
  const patch = { exportPreset: choiceId };
  if (choiceId !== 'original' && ui.format.value !== 'original') patch.exportFormat = ui.format.value;
  saveRecorderSettings(patch);
  saveRecording(choiceId);
});
ui.cancelExport.addEventListener('click', () => {
  cancelRequested = true;
  if (conversion) conversion.cancel();
});
ui.presets.addEventListener('change', async () => {
  renderFormats(await getRecorderSettings());
});
ui.showFile.addEventListener('click', () => {
  if (lastDownloadId !== null) browser.downloads.show(lastDownloadId);
});
ui.again.addEventListener('click', () => {
  if (recording && !recording.saved && !confirmDiscard()) return;
  clearMessage();
  clearReview();
  setView('setup');
});

window.addEventListener('beforeunload', (event) => {
  const recordingNow = mediaRecorder && mediaRecorder.state !== 'inactive';
  const unsaved = recording && !recording.saved;
  if (recordingNow || unsaved || conversion) {
    event.preventDefault();
    event.returnValue = '';
  }
});

setView('setup');
initOptions();
