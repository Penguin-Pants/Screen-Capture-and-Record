// Recorder page tests in Chromium: recording, live size, review and export.
// Fake screen and microphone streams replace getDisplayMedia() and
// getUserMedia(). Chromium's WebCodecs stands in for Firefox's here.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { skip, useBrowser } = require('./harness.js');

const openPage = useBrowser();

// An animated canvas stands in for the screen (size from window.__fakeScreen),
// a green canvas for the webcam and an oscillator for the microphone. The
// screen never shows pure green, so the camera bubble is easy to find in
// saved frames. Every opened stream is kept in window.__opened, so tests can
// check that all tracks stop. Microphone options: window.__audioInputs (the
// microphones), __micDelay (a late answer), __denyMic and __silentMic.
const fakeMedia = () => {
  window.__opened = [];
  navigator.mediaDevices.getDisplayMedia = async (constraints) => {
    window.__displayConstraints = constraints;
    const { width, height } = window.__fakeScreen || { width: 320, height: 240 };
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const sctx = source.getContext('2d');
    let frame = 0;
    setInterval(() => {
      sctx.fillStyle = `hsl(${180 + ((frame * 7) % 180)}, 70%, 55%)`;
      sctx.fillRect(0, 0, width, height);
      sctx.fillStyle = '#000';
      sctx.font = `${Math.round(height / 12)}px sans-serif`;
      for (let line = 1; line < 8; line++) sctx.fillText(`Frame ${frame} line ${line}`, 10, (line * height) / 8);
      frame++;
    }, 33);
    const stream = source.captureStream(30);
    window.__opened.push(stream);
    return stream;
  };
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'videoinput', deviceId: 'cam-front', label: 'Front camera' },
    { kind: 'videoinput', deviceId: 'cam-usb', label: 'USB camera' },
    ...(window.__audioInputs || [{ kind: 'audioinput', deviceId: 'mic', label: 'Microphone' }])
  ];
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    window.__userMedia = (window.__userMedia || []).concat([constraints]);
    if (constraints.video) {
      // A camera answer can come late, for example while Firefox asks.
      if (window.__cameraDelay) await new Promise((resolve) => setTimeout(resolve, window.__cameraDelay));
      if (window.__denyCamera) throw new DOMException('The user denied the camera.', 'NotAllowedError');
      const camera = document.createElement('canvas');
      camera.width = 640;
      camera.height = 480;
      const cctx = camera.getContext('2d');
      let tick = 0;
      setInterval(() => {
        cctx.fillStyle = '#00ff00';
        cctx.fillRect(0, 0, 640, 480);
        cctx.fillStyle = '#00dd00';
        cctx.fillRect((tick++ * 9) % 600, 20, 30, 30);
      }, 33);
      const stream = camera.captureStream(30);
      window.__opened.push(stream);
      return stream;
    }
    if (window.__micDelay) await new Promise((resolve) => setTimeout(resolve, window.__micDelay));
    if (window.__denyMic) {
      throw new DOMException('The request is not allowed by the user agent or the platform in the current context.', 'NotAllowedError');
    }
    const wanted = constraints.audio && constraints.audio.deviceId && constraints.audio.deviceId.exact;
    if (wanted && !(window.__audioInputs || []).some((device) => device.deviceId === wanted)) {
      throw new DOMException('Constraints could not be satisfied.', 'OverconstrainedError');
    }
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    // A muted microphone gives zeros.
    const gain = audio.createGain();
    gain.gain.value = window.__silentMic ? 0 : 1;
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    window.__opened.push(destination.stream);
    return destination.stream;
  };
};

// init: a function or a list of functions that run after fakeMedia.
async function openRecorder(init) {
  const opened = await openPage('recorder.html', '', [fakeMedia].concat(init || []));
  // Start comes on when the saved settings are in the controls.
  await opened.page.waitForFunction(() => !document.getElementById('startBtn').disabled);
  await opened.page.selectOption('#countdownSelect', '0');
  return opened;
}

// Record for ms milliseconds and wait until the review shows its choices.
async function record(page, ms) {
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  await page.waitForTimeout(ms);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active') &&
    !document.getElementById('exportNote').textContent.startsWith('Checking'));
}

// Load a saved file in a <video> element and read what a player sees.
function probeDownload(page, index) {
  return page.evaluate((i) => new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.onloadedmetadata = () => resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => resolve({ error: String(video.error && video.error.message) });
    video.src = URL.createObjectURL(window.__downloadBlobs[i]);
  }), index);
}

// Loudness (RMS) of the sound track of the recording ('recording') or of a
// saved file (its index), as a player decodes it. 0 without a sound track.
function soundLevel(page, which) {
  return page.evaluate(async (w) => {
    const blob = w === 'recording' ? recording.blob : window.__downloadBlobs[w];
    const mb = await loadMediabunny();
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) return 0;
      let sum = 0;
      let count = 0;
      for await (const sample of new mb.AudioSampleSink(track).samples()) {
        const values = new Float32Array(sample.numberOfFrames);
        sample.copyTo(values, { planeIndex: 0, format: 'f32-planar' });
        for (const value of values) {
          sum += value * value;
          count++;
        }
        sample.close();
      }
      return count ? Math.sqrt(sum / count) : 0;
    } finally {
      input.dispose();
    }
  }, which);
}

// An audio encoder that takes the sound and gives nothing back. A similar
// failure was reported for Firefox's Opus encoder.
const silentAudioEncoder = () => {
  const Real = AudioEncoder;
  window.AudioEncoder = class {
    static isConfigSupported(config) { return Real.isConfigSupported(config); }
    constructor() { this.state = 'unconfigured'; this.encodeQueueSize = 0; }
    configure() { this.state = 'configured'; }
    encode(data) { data.close(); }
    async flush() {}
    reset() {}
    close() { this.state = 'closed'; }
    addEventListener() {}
    removeEventListener() {}
  };
};

const micRequests = (page) => page.evaluate(() => (window.__userMedia || []).filter((c) => c.audio));

const liveTrackCount = (page) => page.evaluate(() =>
  window.__opened.flatMap((stream) => stream.getTracks()).filter((track) => track.readyState !== 'ended').length);

test('quality profile sets the screen size limit and the size estimate', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  assert.equal(await page.inputValue('#profileSelect'), 'high');
  assert.equal(await page.textContent('#profileHint'), 'About 15 MB per minute. Often less when little moves on the screen.');
  await page.selectOption('#profileSelect', 'medium');
  assert.match(await page.textContent('#profileHint'), /^About 7\.5 MB per minute/);
  await page.check('#micCheck');
  assert.match(await page.textContent('#profileHint'), /^About 8\.0 MB per minute/);
  assert.equal(await page.evaluate(() => window.__store['setting.profile']), 'medium');

  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  assert.deepEqual(await page.evaluate(() => window.__displayConstraints.video), {
    frameRate: { ideal: 30, max: 30 },
    width: { max: 1280 },
    height: { max: 720 }
  });
  await page.waitForFunction(() => /\d (KB|MB) so far/.test(document.getElementById('liveSize').textContent));
  await page.click('#stopBtn');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Start waits for the saved settings, but not for the camera answer', { skip }, async () => {
  const { page, context, errors } = await openPage('recorder.html', '', [fakeMedia, () => {
    // Saved settings that load slowly, and a camera that answers slowly.
    Object.assign(window.__store, { 'setting.profile': 'medium', 'setting.countdown': 0, 'setting.camera': true });
    window.__cameraDelay = 1500;
    const get = browser.storage.local.get;
    browser.storage.local.get = async (keys) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return get(keys);
    };
  }]);
  assert.equal(await page.isDisabled('#startBtn'), true, 'Start is off while the settings load');
  await page.waitForFunction(() => !document.getElementById('startBtn').disabled);
  assert.equal(await page.inputValue('#profileSelect'), 'medium');
  assert.equal(await page.evaluate(() => cameraStream), null, 'the camera has not answered yet');

  // Start before the camera answers: the recording uses the same camera request.
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  assert.equal(await page.evaluate(() => window.__userMedia.filter((c) => c.video).length), 1, 'one camera request');
  assert.equal(await page.isVisible('#liveCamera'), true);
  await page.waitForTimeout(800);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active'));
  assert.match(await page.textContent('#details'), / · with camera$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('stop opens the review without saving; all tracks stop', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  await page.check('#micCheck');
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  await page.waitForTimeout(1200);
  await page.click('#pauseBtn');
  assert.equal(await page.textContent('#recLabel'), 'Paused');
  const pausedAt = await page.textContent('#timer');
  await page.waitForTimeout(1200);
  assert.equal(await page.textContent('#timer'), pausedAt, 'timer stops while paused');
  await page.click('#pauseBtn');
  await page.waitForTimeout(800);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active') &&
    !document.getElementById('exportNote').textContent.startsWith('Checking'));

  assert.equal(await page.evaluate(() => window.__calls.downloads.length), 0, 'nothing is saved before the review');
  assert.equal(await liveTrackCount(page), 0, 'screen and microphone tracks are stopped');
  const states = await page.evaluate(() => window.__calls.messages.filter((m) => m.action === 'recordingState').map((m) => m.state));
  assert.deepEqual(states, ['recording', 'paused', 'recording', 'idle']);

  const details = await page.textContent('#details');
  assert.match(details, /^Length 00:0[1-3] · 320 × 240 · [\d.]+ (KB|MB)$/);
  const choices = await page.$$eval('#presets .preset', (labels) => labels.map((label) => ({
    id: label.querySelector('input').value,
    text: label.textContent,
    enabled: !label.querySelector('input').disabled
  })));
  assert.deepEqual(choices.map((choice) => choice.id), ['original', 'high', 'medium', 'small', 'tiny']);
  assert.equal(choices[0].enabled, true);
  assert.match(choices[0].text, /As recorded · 320 × 240, no quality loss[\d.]+ (KB|MB)/);
  assert.match(choices[4].text, /Tiny · 320 × 240, 15 fps.*about \d+ KB/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('saving as recorded adds a duration, so players can seek', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  await record(page, 2000);
  await page.check('#presets input[value="original"]');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'));

  const download = await page.evaluate(() => window.__calls.downloads[0]);
  assert.match(download.filename, /^recording-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.webm$/);
  assert.equal(download.type, 'video/webm');
  const saved = await probeDownload(page, 0);
  assert.ok(Number.isFinite(saved.duration) && saved.duration > 1.5 && saved.duration < 3, `duration ${saved.duration}`);

  // The raw MediaRecorder file has no duration: this is what the remux fixes.
  const raw = await page.evaluate(() => new Promise((resolve) => {
    const video = document.createElement('video');
    video.onloadedmetadata = () => resolve(video.duration);
    video.src = URL.createObjectURL(recording.blob);
  }));
  assert.equal(raw, Infinity);
  assert.match(await page.textContent('#savedText'), /^Saved: recording-.*\.webm \(\d+ KB\)$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a smaller copy uses the preset size and is smaller than the recording', { skip }, async () => {
  const { page, context, errors } = await openRecorder(() => { window.__fakeScreen = { width: 1280, height: 720 }; });
  await page.selectOption('#profileSelect', 'max');
  await record(page, 3000);

  const small = await page.$eval('#presets input[value="small"]', (input) => ({
    enabled: !input.disabled,
    text: input.closest('label').textContent
  }));
  assert.equal(small.enabled, true, small.text);
  assert.match(small.text, /Small · 852 × 480, 24 fps.*about \d+ KB/);
  await page.check('#presets input[value="small"]');
  assert.equal(await page.inputValue('#formatSelect'), 'webm');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'), null, { timeout: 60000 });

  const download = await page.evaluate(() => window.__calls.downloads[0]);
  assert.match(download.filename, /-480p\.webm$/);
  const original = await page.evaluate(() => recording.blob.size);
  assert.ok(download.size < original, `copy ${download.size} bytes, recording ${original} bytes`);
  const saved = await probeDownload(page, 0);
  assert.deepEqual([saved.width, saved.height], [852, 480]);
  assert.ok(Number.isFinite(saved.duration), 'the copy has a duration');
  assert.equal(await page.evaluate(() => window.__store['setting.exportPreset']), 'small');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a save counts only when the download is complete', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  await record(page, 1200);
  const saveEnds = () => page.waitForFunction(() => !document.getElementById('saveBtn').disabled &&
    document.getElementById('message').classList.contains('show'));

  // The disk is full: the download stops.
  await page.evaluate(() => { window.__downloadError = 'FILE_NO_SPACE'; });
  await page.click('#saveBtn');
  await saveEnds();
  assert.equal(await page.textContent('#message'), 'Could not save the video: Firefox could not write the file (FILE_NO_SPACE).');
  assert.equal(await page.evaluate(() => recording.saved), false, 'the warning before closing stays on');
  assert.equal(await page.isVisible('#saved'), false);

  // Cancelled in the downloads panel: not saved, and no error.
  await page.evaluate(() => { window.__downloadError = 'USER_CANCELED'; });
  await page.click('#saveBtn');
  await saveEnds();
  assert.equal(await page.textContent('#message'), 'The file was not saved.');
  assert.equal(await page.evaluate(() => recording.saved), false);

  // The end is reported before download() gives the ID: the save still counts.
  await page.evaluate(() => { window.__downloadError = ''; window.__downloadEndsFirst = true; });
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'));
  assert.equal(await page.evaluate(() => recording.saved), true);
  assert.deepEqual(errors, []);
  await context.close();
});

// Stop a recording of ms milliseconds, without waiting for the export check.
async function recordNoWait(page, ms) {
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  await page.waitForTimeout(ms);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active'));
}

// The encoder check never answers (the export library still loads).
const hangCheck = () => {
  const load = loadMediabunny;
  loadMediabunny = () => load().then((mb) => ({ ...mb, getFirstEncodableVideoCodec: () => new Promise(() => {}) }));
};

test('without the camera, Save does not wait for the export check', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  // A slow check: the export library loads 1.5 s late.
  await page.evaluate(() => {
    const load = loadMediabunny;
    loadMediabunny = () => new Promise((resolve) => setTimeout(resolve, 1500)).then(load);
  });
  await recordNoWait(page, 1200);

  assert.equal(await page.textContent('#exportNote'), 'Checking which formats this browser can make...');
  assert.equal(await page.isDisabled('#saveBtn'), false, 'Save works during the check');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'), null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__calls.downloads.length), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('"Save at once" without the camera saves before the export check ends', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  await page.evaluate(`(${hangCheck})(); exportCheckLimitMs = 60000; saveSettings({ afterRecording: 'save' });`);
  await recordNoWait(page, 1200);

  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'), null, { timeout: 30000 });
  assert.equal(await page.textContent('#exportNote'), 'Checking which formats this browser can make...', 'the check still runs');
  assert.match(await page.textContent('#message'), /saved as it is/);
  assert.equal(await page.evaluate(() => window.__calls.downloads.length), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('cancel stops an export and saves nothing', { skip }, async () => {
  const { page, context } = await openRecorder();
  await record(page, 1500);
  // Hold the export at its start, so Cancel always comes first.
  await page.evaluate(async () => {
    const real = await loadMediabunny();
    const Conversion = {
      init: async (options) => {
        const instance = await real.Conversion.init(options);
        const execute = instance.execute.bind(instance);
        instance.execute = async () => {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return execute();
        };
        return instance;
      }
    };
    mediabunnyPromise = Promise.resolve({ ...real, Conversion });
  });
  await page.check('#presets input[value="original"]');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('progress').classList.contains('active'));
  await page.click('#cancelExportBtn');
  await page.waitForFunction(() => !document.getElementById('progress').classList.contains('active'));
  assert.equal(await page.textContent('#message'), 'Stopped. Nothing was saved.');
  assert.equal(await page.evaluate(() => window.__calls.downloads.length), 0);
  assert.equal(await page.isDisabled('#saveBtn'), false, 'Save works again');
  await context.close();
});

test('without WebCodecs only "As recorded" is offered', { skip }, async () => {
  const { page, context } = await openRecorder(() => { delete window.VideoEncoder; });
  await record(page, 1200);
  const enabled = await page.$$eval('#presets input', (inputs) => inputs.filter((input) => !input.disabled).map((input) => input.value));
  assert.deepEqual(enabled, ['original']);
  assert.equal(await page.textContent('#exportNote'), 'Smaller copies need Firefox 130 or later. You can save the recording as it is.');
  assert.equal(await page.inputValue('#formatSelect'), 'original');
  await context.close();
});

test('"Save at once" saves the recording as it is, then offers smaller copies', { skip }, async () => {
  const { page, context } = await openRecorder();
  await page.evaluate(() => saveSettings({ afterRecording: 'save', exportPreset: 'medium' }));
  await record(page, 1500);
  await page.waitForFunction(() => window.__calls.downloads.length === 1);
  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'));
  assert.match(await page.textContent('#message'), /saved as it is/);
  assert.match(await page.evaluate(() => window.__calls.downloads[0].filename), /^recording-[\d_-]+\.webm$/);
  // The automatic save does not change the remembered choice.
  assert.equal(await page.evaluate(() => window.__store['setting.exportPreset']), 'medium');
  await context.close();
});

test('a pending save never shows the previous file', { skip }, async () => {
  const { page, context } = await openRecorder();
  await page.evaluate(() => saveSettings({ afterRecording: 'save' }));
  await record(page, 1200);
  await page.waitForFunction(() => lastDownloadId === 1 && document.getElementById('saved').classList.contains('show'));

  // The second save stays pending, like an open "Save as" dialog.
  await page.evaluate(() => { browser.downloads.download = () => new Promise(() => {}); });
  await page.click('#againBtn');
  await record(page, 1200);
  await page.waitForFunction(() => document.getElementById('progress').classList.contains('active') || conversion === null);
  const state = await page.evaluate(() => ({
    id: lastDownloadId,
    saved: document.getElementById('saved').classList.contains('show')
  }));
  assert.deepEqual(state, { id: null, saved: false });
  await context.close();
});

test('an unsaved recording asks before it is discarded', { skip }, async () => {
  const { page, context } = await openRecorder();
  await record(page, 1200);
  await page.evaluate(() => { window.confirm = () => false; });
  await page.click('#againBtn');
  assert.equal(await page.evaluate(() => document.getElementById('result').classList.contains('active')), true);
  await page.evaluate(() => { window.confirm = () => true; });
  await page.click('#againBtn');
  assert.equal(await page.evaluate(() => document.getElementById('setup').style.display), '');
  assert.equal(await page.evaluate(() => recording), null);
  await context.close();
});

test('countdown can be cancelled by ending the share', { skip }, async () => {
  const { page, context } = await openRecorder();
  await page.selectOption('#countdownSelect', '3');
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('countdown').classList.contains('active'));
  await page.evaluate(() => stopRecording());
  await page.waitForFunction(() => !document.getElementById('countdown').classList.contains('active'));
  assert.equal(await page.evaluate(() => window.__calls.downloads.length), 0);
  assert.equal(await liveTrackCount(page), 0);
  await context.close();
});

test('microphone: opens when ticked, shows the level, and the same stream is recorded', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  assert.equal(await page.$('#audioCheck'), null, 'no tab audio option: Firefox gives no tab sound');
  assert.equal(await page.isVisible('#micSetup'), false);
  await page.check('#micCheck');
  await page.waitForFunction(() => document.getElementById('micSetup').classList.contains('show'));
  await page.waitForFunction(() => parseFloat(document.getElementById('micMeterFill').style.width) > 50);
  assert.equal(await page.textContent('#micHint'), 'Talk to test the microphone. The bar moves when it hears you.');
  assert.equal(await page.isVisible('#micDeviceRow'), false, 'one microphone: no list');
  assert.deepEqual(await micRequests(page), [{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }]);

  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  assert.equal(await page.evaluate(() => 'audio' in window.__displayConstraints), false, 'the screen request asks for video only');
  assert.equal(await page.isVisible('#liveMeter'), true);
  await page.waitForTimeout(1500);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active'));
  assert.equal((await micRequests(page)).length, 1, 'Firefox asks for the microphone once');
  assert.equal(await liveTrackCount(page), 0, 'the microphone stops with the recording');
  assert.ok((await soundLevel(page, 'recording')) > 0.3, 'the recording has the microphone sound');
  assert.equal(await page.isVisible('#message'), false, 'no sound warning');

  // A new recording opens the microphone again.
  await page.evaluate(() => { window.confirm = () => true; });
  await page.click('#againBtn');
  await page.waitForFunction(() => document.getElementById('micSetup').classList.contains('show'));
  assert.equal((await micRequests(page)).length, 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test('microphone: Start waits for the answer to an open microphone request', { skip }, async () => {
  const { page, context, errors } = await openRecorder(() => { window.__micDelay = 800; });
  await page.check('#micCheck');
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  assert.equal((await micRequests(page)).length, 1, 'no second request, so Firefox asks once');
  await page.waitForTimeout(1500);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active'));
  assert.ok((await soundLevel(page, 'recording')) > 0.3, 'the recording has the microphone sound');
  assert.deepEqual(errors, []);
  await context.close();
});

test('microphone: a denied microphone unticks the option and says why', { skip }, async () => {
  const { page, context } = await openRecorder(() => { window.__denyMic = true; });
  // A click, not check(): the answer comes at once and unticks the option.
  await page.click('#micCheck');
  await page.waitForFunction(() => document.getElementById('message').classList.contains('show'));
  assert.match(await page.textContent('#message'), /^Firefox did not allow the microphone\. .*remove the block, then reload this page\.$/);
  assert.equal(await page.isChecked('#micCheck'), false);
  assert.equal(await page.isVisible('#micSetup'), false);
  assert.equal(await page.evaluate(() => window.__store['setting.microphone']), false);
  assert.match(await page.textContent('#profileHint'), /^About 15 MB per minute/, 'the estimate has no sound');
  await context.close();
});

test('microphone: when it fails after Start, the video records without sound only if you agree', { skip }, async () => {
  const { page, context } = await openRecorder(() => { window.__micDelay = 600; window.__denyMic = true; });
  const recordingStates = () => page.evaluate(() =>
    window.__calls.messages.filter((m) => m.action === 'recordingState').length);

  // Start before the answer comes. The answer is "blocked": cancel.
  await page.check('#micCheck');
  let question = '';
  page.once('dialog', (dialog) => {
    question = dialog.message();
    dialog.dismiss();
  });
  await page.click('#startBtn');
  await page.waitForFunction(() => !document.getElementById('startBtn').disabled &&
    document.getElementById('message').classList.contains('show'));
  assert.match(question, /^Firefox did not allow the microphone\.[\s\S]*\n\nRecord without sound\?$/);
  assert.equal(await page.evaluate(() => document.getElementById('setup').style.display), '', 'back to the setup');
  assert.equal(await recordingStates(), 0, 'nothing was recorded');
  assert.equal(await liveTrackCount(page), 0, 'the screen is not shared any more');

  // The same again, but agree: the video records without sound.
  await page.check('#micCheck');
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  assert.equal(await page.isVisible('#liveMeter'), false);
  await page.waitForTimeout(1000);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active'));
  assert.match(await page.textContent('#details'), / · no sound$/);
  await context.close();
});

test('microphone: a silent microphone shows a hint, then a warning that "Save at once" keeps', { skip }, async () => {
  const { page, context } = await openRecorder(() => { window.__silentMic = true; });
  await page.check('#micCheck');
  await page.waitForFunction(() => document.getElementById('micHint').classList.contains('warn'), null, { timeout: 8000 });
  assert.match(await page.textContent('#micHint'), /^No sound from this microphone\. If the bar does not move when you talk/);

  const warning = 'The microphone gave no sound during this recording. Before you record again, talk and look at the ' +
    'level bar under "Include microphone".';
  await record(page, 1200);
  assert.equal(await page.textContent('#message'), warning);
  assert.match(await page.textContent('#details'), / · no sound from the microphone$/);
  // A save keeps the warning in view.
  await page.check('#presets input[value="original"]');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'));
  assert.equal(await page.textContent('#message'), warning);

  await page.click('#againBtn');
  await page.evaluate(() => saveSettings({ afterRecording: 'save' }));
  await page.waitForFunction(() => micStream);
  await record(page, 1200);
  await page.waitForFunction(() => window.__calls.downloads.length === 2 &&
    document.getElementById('saved').classList.contains('show'));
  assert.equal(await page.textContent('#message'),
    `The recording was saved as it is. You can also save a smaller copy below. ${warning}`);
  await context.close();
});

test('microphone: with 2 microphones, a list; the choice is used and saved', { skip }, async () => {
  const inputs = () => {
    window.__audioInputs = [
      { kind: 'audioinput', deviceId: 'mic-built-in', label: 'Built-in microphone' },
      { kind: 'audioinput', deviceId: 'mic-usb', label: 'USB microphone' }
    ];
  };
  const { page, context, errors } = await openRecorder(inputs);
  await page.check('#micCheck');
  await page.waitForFunction(() => document.getElementById('micSetup').classList.contains('show'));
  assert.equal(await page.isVisible('#micDeviceRow'), true);
  assert.deepEqual(await page.$$eval('#micDevice option', (options) => options.map((option) => option.textContent)),
    ['Built-in microphone', 'USB microphone']);
  await page.selectOption('#micDevice', 'mic-usb');
  await page.waitForFunction(() => window.__userMedia.filter((c) => c.audio).length === 2 && micStream);
  assert.deepEqual((await micRequests(page)).at(-1).audio.deviceId, { exact: 'mic-usb' });
  assert.equal(await page.evaluate(() => window.__store['setting.microphoneDeviceId']), 'mic-usb');
  assert.equal(await liveTrackCount(page), 1, 'the first microphone stopped');
  assert.deepEqual(errors, []);
  await context.close();

  // The saved microphone is gone: the page opens the default microphone.
  const second = await openRecorder([inputs, () => {
    Object.assign(window.__store, { 'setting.microphone': true, 'setting.microphoneDeviceId': 'mic-gone' });
  }]);
  await second.page.waitForFunction(() => document.getElementById('micSetup').classList.contains('show'));
  const requests = await micRequests(second.page);
  assert.deepEqual(requests.map((c) => c.audio.deviceId), [{ exact: 'mic-gone' }, undefined]);
  assert.equal(await second.page.isVisible('#message'), false);
  await second.context.close();
});

test('microphone: a microphone that stops gives a warning', { skip }, async () => {
  const { page, context } = await openRecorder();
  await page.check('#micCheck');
  await page.waitForFunction(() => micStream);
  const unplug = () => page.evaluate(() => micStream.getAudioTracks()[0].dispatchEvent(new Event('ended')));

  // Before recording: the page opens the microphone again.
  await unplug();
  assert.match(await page.textContent('#message'), /^The microphone stopped \(for example, it was unplugged\)\./);
  await page.waitForFunction(() => window.__userMedia.filter((c) => c.audio).length === 2 && micStream);

  // While recording: the rest of the video has no sound.
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  await page.waitForTimeout(600);
  await unplug();
  assert.equal(await page.textContent('#message'), 'The microphone stopped. The rest of the video has no sound.');
  await page.waitForTimeout(400);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active'));
  assert.equal(await page.textContent('#message'), 'The microphone stopped during this recording. Part of the video has no sound.');
  assert.match(await page.textContent('#details'), / · microphone stopped$/);
  await context.close();
});

test('microphone: without a level meter, the microphone still records and no warning shows', { skip }, async () => {
  const { page, context, errors } = await openRecorder(() => {
    // Firefox can refuse the meter, for example when two sample rates differ.
    AudioContext.prototype.createMediaStreamSource = () => {
      throw new DOMException('Connecting AudioNodes from AudioContexts with different sample-rate is currently not supported.', 'NotSupportedError');
    };
  });
  await page.check('#micCheck');
  await page.waitForFunction(() => document.getElementById('micSetup').classList.contains('show'));
  assert.equal(await page.textContent('#micHint'), 'The level meter is not available. The microphone records.');
  assert.equal(await page.isVisible('#micSetup .meter'), false);
  await record(page, 1500);
  assert.ok((await soundLevel(page, 'recording')) > 0.3, 'the recording has the microphone sound');
  assert.equal(await page.isVisible('#message'), false, 'without level values, the sound is not judged');
  assert.doesNotMatch(await page.textContent('#details'), /sound|microphone/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a smaller copy keeps the recorded sound, also when the audio encoder gives nothing', { skip }, async () => {
  const { page, context, errors } = await openRecorder(silentAudioEncoder);
  await page.check('#micCheck');
  await record(page, 2000);
  await page.check('#presets input[value="tiny"]');
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'), null, { timeout: 60000 });
  assert.match(await page.evaluate(() => window.__calls.downloads[0].filename), /-240p\.webm$/);
  assert.ok((await soundLevel(page, 0)) > 0.3, 'the copy has the microphone sound');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a file that would lose the sound is not saved', { skip }, async () => {
  const { page, context } = await openRecorder(silentAudioEncoder);
  await page.check('#micCheck');
  await record(page, 1500);

  // A new encode of the sound gives no packets: the check after the conversion stops it.
  const encodeError = await page.evaluate(() => convertRecording({ audio: { codec: 'opus', forceTranscode: true } }, 'webm')
    .then(() => '', (error) => error.message)
    .finally(() => { conversion = null; }));
  assert.equal(encodeError, 'The sound did not go into the file.');

  // The sound cannot go into the chosen format: Save stops, and nothing is saved.
  await page.evaluate(() => exportSupport.formats.forEach((format) => { format.audioCodec = 'aac'; }));
  await page.check('#presets input[value="tiny"]');
  await page.click('#saveBtn');
  await page.waitForFunction(() => !document.getElementById('saveBtn').disabled &&
    document.getElementById('message').classList.contains('show'), null, { timeout: 60000 });
  assert.equal(await page.textContent('#message'),
    'Could not save the video: This browser cannot put the sound in this file (no_encodable_target_codec).');
  assert.equal(await page.evaluate(() => window.__calls.downloads.length), 0);
  await context.close();
});

test('an MP4 copy with Opus sound shows a note about players', { skip }, async () => {
  // A browser that encodes H.264 video but no AAC sound, like Firefox.
  const { page, context } = await openRecorder(() => {
    const video = VideoEncoder.isConfigSupported.bind(VideoEncoder);
    VideoEncoder.isConfigSupported = async (config) =>
      (config.codec.startsWith('avc') ? { supported: true, config } : video(config));
    const audio = AudioEncoder.isConfigSupported.bind(AudioEncoder);
    AudioEncoder.isConfigSupported = async (config) =>
      (config.codec.startsWith('mp4a') ? { supported: false, config } : audio(config));
  });
  await page.check('#micCheck');
  await record(page, 1500);
  await page.check('#presets input[value="tiny"]');
  assert.deepEqual(await page.$$eval('#formatSelect option', (options) => options.map((option) => option.textContent)),
    ['WebM (small files, plays in browsers)', 'MP4 (H.264 video, Opus sound)']);
  await page.selectOption('#formatSelect', 'webm');
  assert.equal(await page.isVisible('#formatNote'), false);
  await page.selectOption('#formatSelect', 'mp4');
  assert.match(await page.textContent('#formatNote'),
    /^Some players \(for example, Windows Media Player\) cannot play Opus sound in an MP4 file\. They play the video with no sound\./);
  await page.check('#presets input[value="original"]');
  assert.equal(await page.isVisible('#formatNote'), false, '"As recorded" keeps WebM');
  await context.close();
});

// Read one pixel of a saved video at a time (seconds), as a player shows it.
function pixelAt(page, index, time, x, y) {
  return page.evaluate(([i, t, px, py]) => new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.onerror = () => reject(new Error(String(video.error && video.error.message)));
    video.onloadedmetadata = () => { video.currentTime = t; };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      resolve(Array.from(ctx.getImageData(px, py, 1, 1).data.slice(0, 3)));
    };
    video.src = URL.createObjectURL(window.__downloadBlobs[i]);
  }), [index, time, x, y]);
}

const isGreen = ([r, g, b]) => g > 180 && r < 90 && b < 90;

test('camera: preview, device list, and the camera stops with the recording', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  assert.equal(await page.isVisible('#cameraSetup'), false);
  await page.check('#cameraCheck');
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  assert.equal(await page.evaluate(() => window.__store['setting.camera']), true);
  assert.deepEqual(await page.$$eval('#cameraDevice option', (options) => options.map((option) => option.textContent)),
    ['Front camera', 'USB camera']);
  assert.equal(await page.isVisible('#cameraDeviceRow'), true);

  await page.selectOption('#cameraDevice', 'cam-usb');
  await page.waitForFunction(() => window.__store['setting.cameraDeviceId'] === 'cam-usb');
  const lastCamera = await page.evaluate(() => window.__userMedia.filter((c) => c.video).at(-1).video.deviceId);
  assert.deepEqual(lastCamera, { exact: 'cam-usb' });

  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  assert.equal(await page.isVisible('#liveCamera'), true, 'you see yourself while recording');
  await page.waitForTimeout(1200);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active') &&
    !document.getElementById('exportNote').textContent.startsWith('Checking'));
  assert.equal(await liveTrackCount(page), 0, 'screen and camera tracks are stopped');
  assert.match(await page.textContent('#details'), / · with camera$/);
  assert.equal(await page.isVisible('#cameraRow'), true);
  assert.equal(await page.isVisible('#previewCamera'), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('camera: the saved video has the bubble in the chosen corner', { skip }, async () => {
  const { page, context, errors } = await openRecorder(() => { window.__fakeScreen = { width: 640, height: 360 }; });
  await page.check('#cameraCheck');
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  await record(page, 2500);

  const first = await page.$eval('#presets .preset', (label) => label.textContent);
  assert.match(first, /^Full size · 640 × 360, 30 fps.*about [\d.]+ (KB|MB)$/);
  await page.check('#presets input[value="original"]');
  await page.click('#saveBtn');
  await page.waitForFunction(() => window.__calls.downloads.length === 1, null, { timeout: 60000 });
  assert.match(await page.evaluate(() => window.__calls.downloads[0].filename), /^recording-[\d_-]+\.webm$/);

  // Bottom right, medium: diameter 100, margin 11 (see cameraBubbleRect).
  const box = await page.evaluate(() => cameraBubbleRect(640, 360, 'bottom-right', 'medium'));
  const center = [box.x + box.diameter / 2, box.y + box.diameter / 2];
  assert.ok(isGreen(await pixelAt(page, 0, 1, ...center)), 'camera in the bottom-right corner');
  assert.ok(!isGreen(await pixelAt(page, 0, 1, 40, 40)), 'screen in the top-left corner');

  // Move the bubble to the top left and save again.
  await page.selectOption('#cameraPositionSelect', 'top-left');
  assert.equal(await page.evaluate(() => window.__store['setting.cameraPosition']), 'top-left');
  await page.click('#saveBtn');
  await page.waitForFunction(() => window.__calls.downloads.length === 2, null, { timeout: 60000 });
  const topLeft = await page.evaluate(() => cameraBubbleRect(640, 360, 'top-left', 'medium'));
  assert.ok(isGreen(await pixelAt(page, 1, 1, topLeft.x + topLeft.diameter / 2, topLeft.y + topLeft.diameter / 2)));
  assert.ok(!isGreen(await pixelAt(page, 1, 1, ...center)), 'the bottom-right corner shows the screen now');

  // "Hide camera": back to "As recorded", no bubble.
  await page.selectOption('#cameraPositionSelect', 'hidden');
  assert.match(await page.$eval('#presets .preset', (label) => label.textContent), /^As recorded/);
  await page.click('#saveBtn');
  await page.waitForFunction(() => window.__calls.downloads.length === 3, null, { timeout: 60000 });
  assert.ok(!isGreen(await pixelAt(page, 2, 1, ...center)));
  assert.equal(await page.evaluate(() => window.__store['setting.cameraPosition']), 'top-left', '"Hide" is not saved as the default');
  assert.deepEqual(errors, []);
  await context.close();
});

test('camera: Save waits for the export check, so the camera is not left out', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  await page.check('#cameraCheck');
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  // A slow check: the export library loads 1.5 s late.
  await page.evaluate(() => {
    const load = loadMediabunny;
    loadMediabunny = () => new Promise((resolve) => setTimeout(resolve, 1500)).then(load);
  });
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('live').classList.contains('active'));
  await page.waitForTimeout(1200);
  await page.click('#stopBtn');
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active'));

  // While the check runs, "As recorded" (the screen only) is the only choice.
  assert.equal(await page.textContent('#exportNote'), 'Checking which formats this browser can make...');
  assert.equal(await page.isDisabled('#saveBtn'), true, 'Save waits for the check');
  await page.evaluate(() => saveRecording('original'));
  assert.equal(await page.evaluate(() => window.__calls.downloads.length), 0, 'nothing is saved during the check');

  await page.waitForFunction(() => !document.getElementById('saveBtn').disabled);
  assert.match(await page.$eval('#presets .preset', (label) => label.textContent), /^Full size/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('camera: a check that never ends stops the wait; the screen recording can be saved', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  await page.check('#cameraCheck');
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  // The encoder check never answers. Here the review stops waiting after 500 ms.
  await page.evaluate(`(${hangCheck})(); exportCheckLimitMs = 500;`);
  await record(page, 1200);

  assert.equal(await page.textContent('#exportNote'),
    'The format check did not finish, so the camera cannot be added. You can save the screen recording as it is.');
  assert.match(await page.$eval('#presets .preset', (label) => label.textContent), /^As recorded/);
  assert.equal(await page.isDisabled('#saveBtn'), false);
  await page.click('#saveBtn');
  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'), null, { timeout: 30000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('camera: the time limit of a discarded recording does not replace the new check', { skip }, async () => {
  const { page, context, errors } = await openRecorder();
  await page.check('#cameraCheck');
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  // The check of the first recording never answers. Its time limit (6 s) ends
  // after the check of the second recording has answered.
  await page.evaluate(() => {
    exportCheckLimitMs = 6000;
    window.confirm = () => true;
    const load = loadMediabunny;
    loadMediabunny = () => {
      const hang = window.__hang; // decided when the check starts
      return load().then((mb) => (hang ? { ...mb, getFirstEncodableVideoCodec: () => new Promise(() => {}) } : mb));
    };
    window.__hang = true;
  });
  await recordNoWait(page, 800);
  const firstStopped = Date.now();

  // Discard it at once and make a second recording, whose check answers.
  await page.evaluate(() => { window.__hang = false; });
  await page.click('#againBtn');
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  await record(page, 800);
  assert.match(await page.$eval('#presets .preset', (label) => label.textContent), /^Full size/);

  // After the first recording's time limit, the second check result stays.
  assert.ok(Date.now() < firstStopped + 6000, 'the second check answered before the old time limit');
  await page.waitForTimeout(Math.max(0, firstStopped + 6500 - Date.now()));
  const support = await page.evaluate(() => ({ timedOut: Boolean(exportSupport.timedOut), formats: exportSupport.formats.length }));
  assert.equal(support.timedOut, false, 'the old time limit did not replace the check result');
  assert.ok(support.formats > 0);
  assert.equal(await page.evaluate(() => exportChoices()[0].name), 'Full size', 'Save still adds the camera');
  assert.deepEqual(errors, []);
  await context.close();
});

test('camera: a denied camera unticks the option and says why', { skip }, async () => {
  const { page, context } = await openRecorder(() => { window.__denyCamera = true; });
  // click(), not check(): the box unticks itself when the camera is denied.
  await page.click('#cameraCheck');
  await page.waitForFunction(() => document.getElementById('message').classList.contains('show'));
  assert.equal(await page.isChecked('#cameraCheck'), false);
  assert.match(await page.textContent('#message'), /did not allow the camera/);
  assert.equal(await page.evaluate(() => window.__store['setting.camera']), false);
  await context.close();
});

test('camera: a late answer to an old camera request is not used', { skip }, async () => {
  const { page, context, errors } = await openRecorder(() => { window.__cameraDelay = 400; });
  const cameraRequests = () => page.evaluate(() => (window.__userMedia || []).filter((c) => c.video));

  // Turn the camera on, then off before it answers.
  await page.check('#cameraCheck');
  await page.waitForFunction(() => (window.__userMedia || []).some((c) => c.video));
  await page.uncheck('#cameraCheck');
  await page.waitForTimeout(700);
  assert.equal((await cameraRequests()).length, 1);
  assert.equal(await liveTrackCount(page), 0, 'the late camera is stopped');
  assert.equal(await page.isVisible('#cameraSetup'), false);
  assert.equal(await page.evaluate(() => cameraStream), null);

  // Choose two cameras quickly: only the last one stays open.
  await page.check('#cameraCheck');
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  await page.evaluate(() => {
    const select = document.getElementById('cameraDevice');
    for (const id of ['cam-usb', 'cam-front']) {
      select.value = id;
      select.dispatchEvent(new Event('change'));
    }
  });
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  const requests = await cameraRequests();
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3].video.deviceId, { exact: 'cam-front' });
  assert.equal(await liveTrackCount(page), 1, 'only the newest camera is open');
  assert.equal(await page.evaluate(() => cameraStream.getVideoTracks()[0].readyState), 'live');
  assert.deepEqual(errors, []);
  await context.close();
});

// An encoder that takes at most 1920 pixels in width for the codecs in
// window.__narrowCodecs (codec string prefixes, for example 'vp09').
const narrowEncoder = () => {
  const isConfigSupported = VideoEncoder.isConfigSupported.bind(VideoEncoder);
  VideoEncoder.isConfigSupported = async (config) => {
    const narrow = (window.__narrowCodecs || []).some((prefix) => config.codec.startsWith(prefix));
    return narrow && config.width > 1920 ? { supported: false, config } : isConfigSupported(config);
  };
};

test('camera: "Full size" is off when the encoder cannot take the full size', { skip }, async () => {
  const { page, context, errors } = await openRecorder([narrowEncoder, () => {
    window.__fakeScreen = { width: 2048, height: 1152 };
    window.__narrowCodecs = ['vp09', 'vp8', 'avc1'];
  }]);
  await page.selectOption('#profileSelect', 'max');
  await page.evaluate(() => saveSettings({ afterRecording: 'save', exportPreset: 'original' }));
  await page.check('#cameraCheck');
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  await record(page, 1200);

  await page.waitForFunction(() => document.getElementById('message').classList.contains('show'));
  assert.equal(await page.textContent('#message'),
    'This browser cannot make the video with your camera at full size. Choose a smaller size, then click Save.');
  const choices = await page.$$eval('#presets .preset', (labels) => labels.map((label) => ({
    id: label.querySelector('input').value,
    text: label.textContent,
    enabled: !label.querySelector('input').disabled,
    checked: label.querySelector('input').checked
  })));
  assert.match(choices[0].text, /^Full size · 2048 × 1152, 30 fps \(this browser cannot encode this size\)/);
  assert.equal(choices[0].enabled, false);
  const chosen = choices.find((choice) => choice.checked);
  assert.ok(chosen && chosen.enabled && chosen.id !== 'original', `an enabled size is chosen: ${JSON.stringify(chosen)}`);
  assert.notEqual(await page.inputValue('#formatSelect'), 'original');
  assert.equal(await page.evaluate(() => window.__calls.downloads.length), 0, '"Save at once" does not save');
  assert.deepEqual(errors, []);
  await context.close();
});

test('camera: "Full size" uses a codec that the encoder takes at the full size', { skip }, async () => {
  const { page, context, errors } = await openRecorder([narrowEncoder, () => {
    window.__fakeScreen = { width: 2048, height: 1152 };
    window.__narrowCodecs = ['vp09'];
  }]);
  await page.selectOption('#profileSelect', 'max');
  await page.check('#cameraCheck');
  await page.waitForFunction(() => document.getElementById('cameraSetup').classList.contains('show'));
  await record(page, 1200);

  const first = await page.$eval('#presets .preset', (label) => ({
    text: label.textContent,
    enabled: !label.querySelector('input').disabled
  }));
  assert.equal(first.enabled, true, first.text);
  assert.match(first.text, /^Full size · 2048 × 1152, 30 fps.*about [\d.]+ (KB|MB)$/);
  await page.check('#presets input[value="original"]');
  assert.equal(await page.inputValue('#formatSelect'), 'webm');
  await page.click('#saveBtn');
  await page.waitForFunction(() => window.__calls.downloads.length === 1, null, { timeout: 60000 });

  const saved = await page.evaluate(async () => {
    const mb = await loadMediabunny();
    const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(window.__downloadBlobs[0]) });
    const track = await input.getPrimaryVideoTrack();
    const result = { codec: track.codec, width: track.codedWidth, height: track.codedHeight };
    input.dispose();
    return result;
  });
  assert.deepEqual(saved, { codec: 'vp8', width: 2048, height: 1152 });
  const box = await page.evaluate(() => cameraBubbleRect(2048, 1152, 'bottom-right', 'medium'));
  assert.ok(isGreen(await pixelAt(page, 0, 0.5, box.x + box.diameter / 2, box.y + box.diameter / 2)), 'the bubble is in the video');
  assert.deepEqual(errors, []);
  await context.close();
});

test('camera: needs WebCodecs', { skip }, async () => {
  const { page, context } = await openRecorder(() => { delete window.VideoEncoder; });
  assert.equal(await page.isDisabled('#cameraCheck'), true);
  assert.equal(await page.textContent('#cameraNote'), '(needs Firefox 130 or later)');
  await context.close();
});
