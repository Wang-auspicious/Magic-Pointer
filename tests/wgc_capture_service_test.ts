import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FrameCaptureService} from '../electron/runtime/desktop_capture';
import type {NativeCaptureSession} from '../electron/runtime/wgc_capture';
import {WgcCaptureSession} from '../electron/runtime/wgc_capture';

async function main() {
  const compiles: Array<(executable: string) => void> = [];
  const starting = new WgcCaptureSession(
    () => new Promise(resolve => compiles.push(resolve)),
  );
  const firstArm = starting.arm({epochId: 'closing'});
  starting.close();
  compiles[0]('must-not-spawn.exe');
  await assert.rejects(
    firstArm,
    /wgc_closed/,
    'close during first native compilation must prevent a late child spawn',
  );
  const nextArm = starting.arm({epochId: 'new-wake'});
  assert.equal(
    compiles.length,
    2,
    'a later wake starts a new native startup after close',
  );
  starting.close();
  compiles[1]('must-not-spawn.exe');
  await assert.rejects(nextArm, /wgc_closed/);
  const root = await mkdtemp(join(tmpdir(), 'mp-wgc-service-'));
  const events: string[] = [];
  const native: NativeCaptureSession = {
    arm: async params => {
      events.push(`arm:${params.epochId}`);
      return {usedBackend: 'wgc-display'};
    },
    commit: async epoch => {
      events.push(`freeze:${epoch}`);
      return {
        png: Buffer.from('frozen-gpu-frame').toString('base64'),
        width: 10,
        height: 10,
        source: 'wgc-display',
        capturedAtUtc: new Date().toISOString(),
        captureLatencyMs: 7,
      };
    },
    cancel: async epoch => {
      events.push(`cancel:${epoch}`);
    },
    close: () => {
      events.push('closed');
    },
  };
  const capture = async () => {
    events.push('gdi');
    return {
      bytes: Buffer.from('gdi-history'),
      width: 10,
      height: 10,
      source: 'gdi-fallback',
      capturedAtUtc: new Date().toISOString(),
    };
  };
  const resolveWindow = async () => ({
    hwnd: 42,
    pid: 7,
    title: 'Witness',
    bbox: [0, 0, 10, 10] as [number, number, number, number],
  });
  const args = {
    epochId: 'one',
    displayId: '1',
    surfaceBoundsPx: [0, 0, 10, 10],
    targetWindow: {hwnd: 42, processId: 7, processName: 'test.exe'},
  };
  const service = new FrameCaptureService(
    root,
    5,
    capture,
    resolveWindow,
    native,
  );
  try {
    await service.arm(args);
    const result = await service.commit({epochId: 'one'});
    assert.equal(
      result.source,
      'wgc-display',
      'production capture service must consume native GPU frames',
    );
    assert.equal(
      (await readFile(result.localArtifact.path)).toString(),
      'frozen-gpu-frame',
    );
    assert.equal(result.captureLatencyMs, 7);
    assert.equal(
      events.includes('gdi'),
      false,
      'WGC arm must not also run the CPU capture timer',
    );
    assert.ok(events.indexOf('freeze:one') >= 0);
    assert.equal(
      events.includes('cancel:one'),
      false,
      'a successful native commit already stops capture and must retain the idle device',
    );
    service.cancel();
    assert.equal(
      events.includes('cancel:'),
      true,
      'an explicit idle cancel must release the retained native device',
    );
    native.arm = async () => {
      throw new Error('wgc_not_supported');
    };
    await service.arm({...args, epochId: 'fallback'});
    await new Promise(resolve => setTimeout(resolve, 10));
    const fallback = await service.commit({epochId: 'fallback'});
    assert.equal(fallback.source, 'gdi-fallback');
    assert.equal(fallback.captureFallbackReason, 'wgc_not_supported');
    native.arm = async () => ({});
    native.commit = async () => {
      throw new Error('wgc_capture_failed:device_removed');
    };
    await service.arm({...args, epochId: 'lost'});
    const callsBeforeCommit = events.length;
    await assert.rejects(service.commit({epochId: 'lost'}), /device_removed/);
    assert.equal(
      events.slice(callsBeforeCommit).includes('gdi'),
      false,
      'commit failure cannot capture newer pixels',
    );
    let finishOld!: (value: Record<string, unknown>) => void;
    const captured = {
      png: Buffer.from('frozen').toString('base64'),
      width: 10,
      height: 10,
      source: 'wgc-display',
      capturedAtUtc: new Date().toISOString(),
      captureLatencyMs: 1,
    };
    native.commit = async epoch =>
      epoch === 'old'
        ? new Promise(resolve => {
            finishOld = resolve;
          })
        : captured;
    await service.arm({...args, epochId: 'old'});
    const oldCommit = service.commit({epochId: 'old'});
    await service.arm({...args, epochId: 'new'});
    finishOld(captured);
    await oldCommit;
    assert.equal(
      (await service.commit({epochId: 'new'})).epochId,
      'new',
      'an older PNG commit finishing must not clear the next gesture',
    );
  } finally {
    service.cancel();
    native.close();
    await rm(root, {recursive: true, force: true});
  }
  console.log('WGC production capture lifecycle passed');
}
void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
