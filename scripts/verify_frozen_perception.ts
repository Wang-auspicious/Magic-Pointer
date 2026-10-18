import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const {createRuntimeBridgeRunner} = require('../electron/runtime_bridge_runner');
const {validateFrameLease} = require('../electron/frame_lease');

async function main(): Promise<void> {
  const input = process.argv[2];
  const witness = process.argv[3];
  const compiled = process.argv.includes('--compiled');
  assert.ok(input && witness, 'Usage: tsx verify_frozen_perception.ts capture-result.json expected-text');
  const capture = JSON.parse(await readFile(input, 'utf8'));
  const lease = validateFrameLease(capture.production?.lease ?? capture.lease ?? capture);
  const output = path.resolve('data/runtime/frozen-perception-acceptance');
  const plugins = path.join(output, 'empty-plugins');
  await mkdir(plugins, {recursive: true});
  const progress: Array<Record<string, unknown>> = [];
  const started = performance.now();
  const result = await new Promise<Record<string, any>>(resolve => {
    createRuntimeBridgeRunner().run({
      executable: process.execPath,
      args: compiled
        ? [path.resolve('build/electron/runtime/worker.js'), 'selection_snapshot']
        : ['--require', 'tsx/cjs', path.resolve('electron/runtime/worker.ts'), 'selection_snapshot'],
      spawnOptions: {cwd: process.cwd(), windowsHide: true, env: {
        ...process.env, MAGIC_POINTER_USER_DATA_DIR: output, MAGIC_POINTER_PLUGIN_DIR: plugins,
      }},
      input: {root: process.cwd(), frameLease: lease},
      timeoutMs: 30_000,
      onProgress: (record: {phase: string; fields: Record<string, string>}) => {
        if (record.phase === 'perception_provider') {
          progress.push(JSON.parse(Buffer.from(record.fields.b64, 'base64').toString('utf8')));
        } else if (record.phase === 'snapshot_cleanup') {
          progress.push({provider: 'worker-cleanup', ...record.fields});
        }
      },
      onComplete: resolve,
    });
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const snapshot = result.selectionSnapshot;
  assert.ok(String(snapshot.content).includes(witness), 'Historical frozen pixels must retain the known witness text');
  assert.equal(snapshot.frame_lease.frameLeaseId, lease.frameLeaseId);
  assert.equal(snapshot.capture_attestation.source, lease.source);
  assert.equal(snapshot.capture_attestation.frameAgeMs, lease.captureLatencyMs);
  assert.ok(progress.some(row => row.provider === 'pixel-ocr' && row.state === 'fulfilled'));
  assert.ok(progress.some(row => row.provider === 'worker-cleanup' && row.state === 'completed'));
  const report = {
    input: path.resolve(input), source: lease.source, frameLeaseId: lease.frameLeaseId,
    worker: compiled ? 'compiled' : 'source',
    usedBackend: snapshot.usedBackend, durationMs: performance.now() - started,
    witnessRetained: true, liveIdentityMatched: snapshot.perception_trace.liveIdentityMatched,
    trace: snapshot.perception_trace.attempts, progress,
    modelCalls: 0, installedApp: false,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
