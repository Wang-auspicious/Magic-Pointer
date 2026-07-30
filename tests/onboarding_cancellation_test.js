'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PreflightError, PreflightRunner } = require('../electron/bootstrap_runner');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-pointer-preflight-cancel-'));
  const controller = new AbortController();
  const events = [];
  const runner = new PreflightRunner({
    manifest: {
      schemaVersion: 1,
      stages: [
        { id: 'first', title: 'First', blocking: true, retryable: true, skippable: false, weight: 1 },
        { id: 'second', title: 'Second', blocking: true, retryable: true, skippable: false, weight: 1 },
      ],
    },
    markerPath: path.join(root, 'onboarding.json'),
    checks: {
      first: async () => {
        controller.abort();
        return { state: 'pass', evidence: 'first_passed' };
      },
      second: async () => ({ state: 'pass', evidence: 'must_not_run' }),
    },
    emit: (event) => events.push(event),
  });

  await assert.rejects(
    () => runner.runAsync({ signal: controller.signal }),
    (error) => error instanceof PreflightError && error.message === 'preflight_cancelled',
  );
  assert.strictEqual(events.some((event) => event.id === 'second' && event.state === 'running'), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'onboarding.json')), false);

  console.log('onboarding cancellation test ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
