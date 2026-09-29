// Recorder page tests in Chromium: recording, live size, review and export.
// Fake screen and microphone streams replace getDisplayMedia() and
// getUserMedia(). Chromium's WebCodecs stands in for Firefox's here.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { skip, useBrowser } = require('./harness.js');

const openPage = useBrowser();

// An animated canvas stands in for the screen (size from window.__fakeScreen)
// and an oscillator for the microphone. Every opened stream is kept in
// window.__opened, so tests can check that all tracks stop.
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
      sctx.fillStyle = `hsl(${(frame * 7) % 360}, 70%, 55%)`;
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
  navigator.mediaDevices.getUserMedia = async () => {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    window.__opened.push(destination.stream);
    return destination.stream;
  };
};

async function openRecorder(init) {
  const opened = await openPage('recorder.html', '', init ? [fakeMedia, init] : fakeMedia);
  await opened.page.waitForFunction(() => document.getElementById('profileSelect').options.length > 0);
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
  assert.equal(await page.evaluate(() => window.__store.recorder.profile), 'medium');

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
  assert.equal(await page.evaluate(() => window.__store.recorder.exportPreset), 'small');
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
  await page.evaluate(() => saveRecorderSettings({ afterRecording: 'save', exportPreset: 'medium' }));
  await record(page, 1500);
  await page.waitForFunction(() => window.__calls.downloads.length === 1);
  await page.waitForFunction(() => document.getElementById('saved').classList.contains('show'));
  assert.match(await page.textContent('#message'), /saved as it is/);
  assert.match(await page.evaluate(() => window.__calls.downloads[0].filename), /^recording-[\d_-]+\.webm$/);
  // The automatic save does not change the remembered choice.
  assert.equal(await page.evaluate(() => window.__store.recorder.exportPreset), 'medium');
  await context.close();
});

test('a pending save never shows the previous file', { skip }, async () => {
  const { page, context } = await openRecorder();
  await page.evaluate(() => saveRecorderSettings({ afterRecording: 'save' }));
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

test('options page sets the default recording quality and the after-recording step', { skip }, async () => {
  const { page, context, errors } = await openPage('options.html');
  await page.waitForFunction(() => document.getElementById('recordingProfile').options.length === 5);
  assert.equal(await page.inputValue('#recordingProfile'), 'high');
  assert.equal(await page.inputValue('#afterRecording'), 'review');
  const label = await page.$eval('#recordingProfile option[value="high"]', (option) => option.textContent);
  assert.equal(label, 'High: up to 1920 × 1080, 30 fps (about 15 MB per minute)');
  await page.selectOption('#recordingProfile', 'small');
  await page.selectOption('#afterRecording', 'save');
  await page.waitForFunction(() => window.__store.recorder && window.__store.recorder.afterRecording === 'save');
  assert.equal(await page.evaluate(() => window.__store.recorder.profile), 'small');
  assert.deepEqual(errors, []);
  await context.close();
});
