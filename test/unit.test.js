'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeFolder, buildFilename, fileTimestamp, extensionForMimeType, RECORDING_PROFILES, EXPORT_PRESETS,
  SETTINGS_DEFAULTS, CAMERA_POSITIONS, getRecordingProfile, formatBytes, formatDuration, bytesPerMinute, fitWithin,
  planExport, cameraBubbleRect, VOICE_AUDIO_BITS_PER_SECOND, COMPUTER_AUDIO_BITS_PER_SECOND
} = require('../src/common.js');

test('sanitizeFolder removes unsafe parts', () => {
  assert.equal(sanitizeFolder(''), '');
  assert.equal(sanitizeFolder('Screenshots'), 'Screenshots');
  assert.equal(sanitizeFolder('/a//b/'), 'a/b');
  assert.equal(sanitizeFolder('..\\..\\etc'), 'etc');
  assert.equal(sanitizeFolder('bad:name?*'), 'badname');
  assert.equal(sanitizeFolder('  . / x '), 'x');
});

test('buildFilename joins folder, name and extension', () => {
  assert.equal(buildFilename('recording-1', 'webm', ''), 'recording-1.webm');
  assert.equal(buildFilename('recording-1', 'mp4', 'Videos/2026'), 'Videos/2026/recording-1.mp4');
});

test('fileTimestamp uses local time and safe characters', () => {
  assert.equal(fileTimestamp(new Date(2026, 8, 29, 7, 5, 3)), '2026-09-29_07-05-03');
});

test('extensionForMimeType maps video types', () => {
  assert.equal(extensionForMimeType('video/webm;codecs=vp9,opus'), 'webm');
  assert.equal(extensionForMimeType('video/mp4;codecs=avc1'), 'mp4');
});

test('recording profiles: default is 1080p, 30 fps, 2 Mbps (about 15 MB per minute)', () => {
  const profile = getRecordingProfile(SETTINGS_DEFAULTS.profile);
  assert.deepEqual(
    [profile.maxWidth, profile.maxHeight, profile.frameRate, profile.videoBitsPerSecond],
    [1920, 1080, 30, 2000000]
  );
  assert.equal(formatBytes(bytesPerMinute(profile)), '15 MB');
  assert.equal(getRecordingProfile('no-such-profile').id, 'high');
  const sizes = RECORDING_PROFILES.map((item) => bytesPerMinute(item));
  assert.deepEqual([...sizes].sort((a, b) => b - a), sizes, 'profiles go from large to small files');
});

test('formatBytes and formatDuration', () => {
  assert.equal(formatBytes(400), '1 KB');
  assert.equal(formatBytes(532000), '532 KB');
  assert.equal(formatBytes(7500000), '7.5 MB');
  assert.equal(formatBytes(37500000), '38 MB');
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(83.9), '01:23');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('fitWithin scales down with the same aspect ratio, never up, to even sizes', () => {
  assert.deepEqual(fitWithin(2560, 1440, 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(fitWithin(3440, 1440, 1920, 1080), { width: 1920, height: 802 });
  assert.deepEqual(fitWithin(1080, 1920, 1920, 1080), { width: 606, height: 1080 });
  assert.deepEqual(fitWithin(800, 600, 1920, 1080), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(1365, 767, null, null), { width: 1364, height: 766 });
});

test('planExport estimates the size from bitrate and length, with a margin', () => {
  const source = { width: 2560, height: 1440, seconds: 60, bytes: 40e6, frameRate: 30, hasAudio: true };
  const medium = planExport(EXPORT_PRESETS.find((preset) => preset.id === 'medium'), source);
  assert.deepEqual([medium.width, medium.height, medium.frameRate], [1280, 720, 30]);
  // (1,000,000 + 64,000) bit/s x 60 s / 8 x 1.1 = 8,778,000 bytes
  assert.equal(medium.bytes, 8778000);
  assert.equal(medium.smaller, true);

  const tinyFromSlow = planExport(EXPORT_PRESETS.find((preset) => preset.id === 'tiny'), { ...source, frameRate: 10 });
  assert.equal(tinyFromSlow.frameRate, 10, 'never raises the frame rate');
});

test('planExport keeps the audio bitrate of the recording (a voice if not given)', () => {
  const medium = EXPORT_PRESETS.find((preset) => preset.id === 'medium');
  const source = { width: 1920, height: 1080, seconds: 60, bytes: 40e6, frameRate: 30, hasAudio: true };
  assert.equal(planExport(medium, source).audioBitsPerSecond, VOICE_AUDIO_BITS_PER_SECOND);
  const withComputerSound = planExport(medium, { ...source, audioBitsPerSecond: COMPUTER_AUDIO_BITS_PER_SECOND });
  assert.equal(withComputerSound.audioBitsPerSecond, 128000);
  assert.equal(withComputerSound.bytes, Math.round((((1000000 + 128000) * 60) / 8) * 1.1));
  assert.equal(planExport(medium, { ...source, hasAudio: false, audioBitsPerSecond: 128000 }).audioBitsPerSecond, 0);
});

test('planExport marks presets that do not make the file smaller', () => {
  // 60 s recorded at 2 Mbps (High) gives about 15 MB.
  const source = { width: 1920, height: 1080, seconds: 60, bytes: 15e6, frameRate: 30, hasAudio: false };
  const results = Object.fromEntries(EXPORT_PRESETS.map((preset) => [preset.id, planExport(preset, source).smaller]));
  assert.deepEqual(results, { high: false, medium: true, small: true, tiny: true });
});

test('cameraBubbleRect puts the bubble in the chosen corner with a margin', () => {
  // 1920 x 1080, medium: diameter 28% of 1080 = 302 (even), margin 3% = 32.
  assert.deepEqual(cameraBubbleRect(1920, 1080, 'bottom-right', 'medium'), { x: 1920 - 32 - 302, y: 1080 - 32 - 302, diameter: 302 });
  assert.deepEqual(cameraBubbleRect(1920, 1080, 'top-left', 'medium'), { x: 32, y: 32, diameter: 302 });
  assert.deepEqual(cameraBubbleRect(1920, 1080, 'top-right', 'small'), { x: 1920 - 32 - 216, y: 32, diameter: 216 });
  assert.deepEqual(cameraBubbleRect(1920, 1080, 'bottom-left', 'large'), { x: 32, y: 1080 - 32 - 388, diameter: 388 });
  // Portrait: the shorter side is the width.
  assert.equal(cameraBubbleRect(1080, 1920, 'bottom-right', 'medium').diameter, 302);
  // Unknown values fall back to bottom right, medium.
  assert.deepEqual(cameraBubbleRect(1920, 1080, 'nowhere', 'huge'), cameraBubbleRect(1920, 1080, 'bottom-right', 'medium'));
  assert.equal(CAMERA_POSITIONS.length, 4);
});

test('settings defaults: camera off, review first, bottom-right medium bubble', () => {
  assert.equal(SETTINGS_DEFAULTS.camera, false);
  assert.equal(SETTINGS_DEFAULTS.afterRecording, 'review');
  assert.equal(SETTINGS_DEFAULTS.cameraPosition, 'bottom-right');
  assert.equal(SETTINGS_DEFAULTS.cameraSize, 'medium');
});
