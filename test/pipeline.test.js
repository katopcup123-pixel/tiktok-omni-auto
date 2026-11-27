import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { OUTPUT_DIR, parseEnvText, sanitizeError } from '../src/config.js';
import { computeScenePlanCount } from '../src/gemini.js';
import { probeVideo } from '../src/assembler.js';
import { runDailyPipeline } from '../src/pipeline.js';

test('parseEnvText handles quotes, comments, and blank lines', () => {
  const env = parseEnvText(`
    # comment
    GEMINI_API_KEY="AIzaTestKey1234567890123456789012345"
    PORT=3456
    SINGLE='hello'
  `);
  assert.equal(env.GEMINI_API_KEY, 'AIzaTestKey1234567890123456789012345');
  assert.equal(env.PORT, '3456');
  assert.equal(env.SINGLE, 'hello');
});

test('computeScenePlanCount produces 2-3 min scene counts within Omni 3-15s bounds', () => {
  const plan = computeScenePlanCount(150, 15);
  assert.equal(plan.count, 10);
  assert.equal(plan.sceneDurationSec, 15);
  assert.equal(plan.estimatedTotalSec, 150);

  const clamped = computeScenePlanCount(999, 99);
  assert.equal(clamped.sceneDurationSec, 15);
  assert.equal(clamped.estimatedTotalSec, 180);
});

test('sanitizeError redacts API keys and Bearer tokens', () => {
  const msg = sanitizeError(new Error('Failed with AIzaSyDummySecretKey123456789012345678 and Bearer tok_abc123'));
  assert.ok(!msg.includes('AIzaSyDummySecretKey'));
  assert.ok(!msg.includes('tok_abc123'));
});

test('dry-run pipeline generates, chains frames, and stitches a valid 9:16 MP4', async () => {
  const record = await runDailyPipeline({
    dryRun: true,
    resolution: '360p',
    targetDurationSec: 45,
    sceneDurationSec: 15,
    chainFrames: true,
  });

  assert.equal(record.status, 'success');
  assert.ok(record.videoFile.endsWith('.mp4'));
  const finalPath = path.join(OUTPUT_DIR, record.videoFile);
  assert.ok(fs.existsSync(finalPath));

  const meta = await probeVideo(finalPath);
  assert.equal(meta.width, 360);
  assert.equal(meta.height, 640);
  assert.equal(meta.hasAudio, true);
  assert.ok(meta.durationSec >= 8.5 && meta.durationSec <= 9.5, `Unexpected duration: ${meta.durationSec}`);

  // Clean up test output
  fs.rmSync(finalPath, { force: true });
  fs.rmSync(path.join(OUTPUT_DIR, record.id), { recursive: true, force: true });
});
