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
// check that all tracks stop.
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
    { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' }
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
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination);
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
