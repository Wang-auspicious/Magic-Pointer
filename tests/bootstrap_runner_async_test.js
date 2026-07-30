'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PreflightRunner } = require('../electron/bootstrap_runner');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-preflight-async-'));
  const markerPath = path.join(root, 'onboarding.json');
  const manifest = {
    schemaVersion: 1,
    stages: [
      { id: 'runtime', title: '运行环境', blocking: true, retryable: true, skippable: false, weight: 70 },
      { id: 'voice', title: '语音', blocking: false, retryable: true, skippable: true, weight: 30 },
    ],
  };
  const events = [];
  const runner = new PreflightRunner({
    manifest,
    markerPath,
    bootstrapVersion: 1,
    productVersion: '1.2.3',
    manifestDigest: 'manifest-sha256',
    emit: (event) => events.push(event),
    checks: {
      runtime: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { state: 'pass', evidence: 'runtime_ready' };
      },
      voice: async () => ({ state: 'pass', evidence: 'voice_ready' }),
    },
  });

  const result = await runner.runAsync();
  assert.strictEqual(result.ready, true);
  assert.strictEqual(result.schemaVersion, 2);
  assert.deepStrictEqual(
    events.filter((event) => event.type === 'progress').map((event) => event.percent),
    [0, 70, 100],
  );
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.strictEqual(marker.schemaVersion, 2);
  assert.strictEqual(marker.bootstrapVersion, 1);
  assert.strictEqual(marker.productVersion, '1.2.3');
  assert.strictEqual(marker.manifestDigest, 'manifest-sha256');
  assert.deepStrictEqual(marker.completedStageIds, ['runtime', 'voice']);
  console.log('bootstrap runner async test ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
