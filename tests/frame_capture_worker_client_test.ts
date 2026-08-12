'use strict';

// FrameCaptureWorkerClient: persistent JSONL RPC to scripts/frame_capture_worker.py.
// One child process is reused across every arm/commit of a gesture sequence; the
// client stays idle between gestures and must never leak frame contents into logs.

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { FrameCaptureWorkerClient } = require('../electron/frame_capture_worker_client');

function validLease() {
  return {
    schemaVersion: 1,
    frameLeaseId: 'frame-1',
    epochId: 'epoch-1',
    capturedAtMonotonicMs: 1250.5,
    capturedAtUtc: '2026-08-11T00:00:00.000Z',
    source: 'test',
    targetWindow: { hwnd: 42, processId: 7, processName: 'demo.exe', title: 'Demo' },
    surfaceBoundsPx: [0, 0, 1920, 1080],
    displayId: 'display-1',
    scaleFactor: 1,
    gesture: { coordinateSpace: 'physical_screen_pixels', strokes: [] },
    localArtifact: { path: 'D:/tmp/frame.png', mimeType: 'image/png', width: 1920, height: 1080 },
    contentHash: 'sha256:abc',
    overlayExcluded: true,
    captureLatencyMs: 12.5,
  };
}

function armRequest(epochId = 'epoch-1') {
  return {
    epochId,
    displayId: 'display-1',
    scaleFactor: 1,
    surfaceBoundsPx: [0, 0, 1920, 1080],
    targetWindow: { hwnd: 42, processId: 7, processName: 'demo.exe', title: 'Demo' },
    overlayExcluded: true,
  };
}

function fakeChildProcess() {
  const child = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.requests = [];
  child.kill = () => {
    child.killed = true;
    child.exitCode = 1;
    child.emit('close', 1, null);
  };
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk: any, ...rest: any[]) => {
    child.requests.push(JSON.parse(String(chunk)));
    return write(chunk, ...rest);
  };
  return child;
}

function replyLatest(child: any, payload: any) {
  const id = child.requests.at(-1).id;
  child.stdout.write(JSON.stringify({ id, ...payload }) + '\n');
}

function replyTo(child: any, index: number, payload: any) {
  const id = child.requests[index].id;
  child.stdout.write(JSON.stringify({ id, ...payload }) + '\n');
}

(async function onePersistentChildIsReusedAcrossArmAndCommit() {
  let spawnCount = 0;
  const child = fakeChildProcess();
  const client = new FrameCaptureWorkerClient({
    spawnWorker: () => { spawnCount += 1; return child; },
    requestTimeoutMs: 1000,
  });
  const startPromise = client.start();
  replyLatest(child, { result: { pong: true } });
  await startPromise;

  const armPromise = client.arm(armRequest());
  replyLatest(child, { result: { epochId: 'epoch-1' } });
  await armPromise;

  const commitPromise = client.commit({ epochId: 'epoch-1', gesture: {} });
  replyLatest(child, { result: validLease() });
  const lease = await commitPromise;
  assert.strictEqual(lease.frameLeaseId, 'frame-1');
  assert.strictEqual(spawnCount, 1, 'arm and commit must reuse the same worker process');
  assert.deepStrictEqual(child.requests.map((request: any) => request.method), ['ping', 'arm', 'commit']);
  await client.shutdown();
})();

(async function delayedRepliesResolveTheCorrectRequest() {
  const child = fakeChildProcess();
  const client = new FrameCaptureWorkerClient({ spawnWorker: () => child, requestTimeoutMs: 1000 });
  const startPromise = client.start();
  replyLatest(child, { result: { pong: true } });
  await startPromise;

  const first = client.arm(armRequest('epoch-1'));
  const second = client.arm(armRequest('epoch-2'));
  // Replies arrive out of order; each must resolve its own request.
  replyTo(child, 2, { result: { epochId: 'epoch-2' } });
  await second;
  replyTo(child, 1, { result: { epochId: 'epoch-1' } });
  await first;
  await client.shutdown();
})();

(async function malformedOutputRejectsOnlyTheAffectedRequest() {
  const child = fakeChildProcess();
  const client = new FrameCaptureWorkerClient({ spawnWorker: () => child, requestTimeoutMs: 1000 });
  const protocolErrors: Array<{ error: string; id?: string }> = [];
  client.on('protocol-error', (record: any) => protocolErrors.push(record));
  const startPromise = client.start();
  replyLatest(child, { result: { pong: true } });
  await startPromise;

  const affected = client.arm(armRequest('epoch-broken'));
  // Response carries the id but neither result nor error: malformed for this request.
  child.stdout.write(JSON.stringify({ id: child.requests.at(-1).id }) + '\n');
  await assert.rejects(affected);
  assert(protocolErrors.some((record) => record.error === 'malformed_response'),
    'malformed responses must be recorded as protocol errors');

  const healthy = client.arm(armRequest('epoch-healthy'));
  replyLatest(child, { result: { epochId: 'epoch-healthy' } });
  await healthy;

  // Unparseable output records a protocol error without rejecting anything.
  child.stdout.write('this is not json\n');
  assert(protocolErrors.some((record) => record.error === 'invalid_jsonl'));
  const last = client.arm(armRequest('epoch-last'));
  replyLatest(child, { result: { epochId: 'epoch-last' } });
  await last;
  await client.shutdown();
})();

(async function workerErrorRejectsTheRequestWithItsCode() {
  const child = fakeChildProcess();
  const client = new FrameCaptureWorkerClient({ spawnWorker: () => child, requestTimeoutMs: 1000 });
  const startPromise = client.start();
  replyLatest(child, { result: { pong: true } });
  await startPromise;
  const commitPromise = client.commit({ epochId: 'epoch-1', gesture: {} });
  replyLatest(child, { error: { code: 'epoch_not_armed', message: 'no epoch' } });
  await assert.rejects(commitPromise, /epoch_not_armed/);
  await client.shutdown();
})();

(async function invalidLeaseFromWorkerRejectsCommit() {
  const child = fakeChildProcess();
  const client = new FrameCaptureWorkerClient({ spawnWorker: () => child, requestTimeoutMs: 1000 });
  const startPromise = client.start();
  replyLatest(child, { result: { pong: true } });
  await startPromise;
  const commitPromise = client.commit({ epochId: 'epoch-1', gesture: {} });
  replyLatest(child, { result: { schemaVersion: 1 } });
  await assert.rejects(commitPromise, /frameLeaseId/);
  await client.shutdown();
})();

(async function processExitRejectsAllPendingRequests() {
  const child = fakeChildProcess();
  const client = new FrameCaptureWorkerClient({ spawnWorker: () => child, requestTimeoutMs: 5000 });
  const startPromise = client.start();
  replyLatest(child, { result: { pong: true } });
  await startPromise;
  const first = client.arm(armRequest('epoch-1'));
  const second = client.arm(armRequest('epoch-2'));
  child.emit('close', 1, null);
  await assert.rejects(first, /frame_capture_worker_exited/);
  await assert.rejects(second, /frame_capture_worker_exited/);
})();

(async function timeoutSendsCancelAndRejects() {
  const child = fakeChildProcess();
  const client = new FrameCaptureWorkerClient({ spawnWorker: () => child, requestTimeoutMs: 60 });
  const startPromise = client.start();
  replyLatest(child, { result: { pong: true } });
  await startPromise;
  const armPromise = client.arm(armRequest('epoch-slow'));
  await assert.rejects(armPromise, /timeout/);
  const methods = child.requests.map((request: any) => request.method);
  assert(methods.includes('cancel'), 'a timed-out request must send best-effort cancel');
  assert.strictEqual(child.requests.at(-1).method, 'cancel');
  assert.strictEqual(child.requests.at(-1).params.epochId, 'epoch-slow');
})();

(async function stdoutLoggingNeverIncludesFrameContents() {
  const lines: string[] = [];
  const child = fakeChildProcess();
  const client = new FrameCaptureWorkerClient({
    spawnWorker: () => child,
    requestTimeoutMs: 1000,
    logger: { log: (message: string) => lines.push(message) },
  });
  const startPromise = client.start();
  replyLatest(child, { result: { pong: true } });
  await startPromise;
  const commitPromise = client.commit({ epochId: 'epoch-1', gesture: {} });
  replyLatest(child, { result: validLease() });
  await commitPromise;
  await client.shutdown();
  assert(lines.length > 0, 'the client logs its lifecycle');
  for (const line of lines) {
    assert(!line.includes('D:/tmp/frame.png'), `log leaked the artifact path: ${line}`);
    assert(!line.includes('sha256:'), `log leaked the content hash: ${line}`);
  }
})();

console.log('frame capture worker client test ok');
