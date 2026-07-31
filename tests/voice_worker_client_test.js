'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
const { VoiceWorkerClient } = require('../electron/voice_worker_client');

function fakeChild() {
  const child = new EventEmitter();
  child.spawnArgs = [];
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.commands = [];
  child.stdin = {
    writable: true,
    write: value => { child.commands.push(JSON.parse(value)); },
  };
  child.kill = () => { child.killed = true; };
  return child;
}

(function preloadsOnceAndRoutesMultipleSessionsThroughOneWorker() {
  const children = [];
  const client = new VoiceWorkerClient({
    root: path.resolve('.'),
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
  });
  client.ensureStarted({ preload: true });
  assert.strictEqual(children.length, 1);
  assert.strictEqual(children[0].commands[0].command, 'load');

  const events = [];
  client.on('voice-event', event => events.push(event));
  assert.strictEqual(client.startDictation({ requestId: 'one', inputWav: 'one.wav' }).ok, true);
  children[0].stdout.emit('data', '{"type":"ready","reused":true}\n{"type":"final","transcript":"one"}\n');
  assert.strictEqual(events.at(-1).requestId, 'one');
  assert.strictEqual(client.active, null);

  assert.strictEqual(client.startDictation({ requestId: 'two', inputWav: 'two.wav' }).ok, true);
  assert.strictEqual(children.length, 1);
  children[0].stdout.emit('data', '{"type":"final","transcript":"two"}\n');
  assert.deepStrictEqual(events.filter(item => item.type === 'final').map(item => item.transcript), ['one', 'two']);
  client.shutdown({ force: true });
})();

(function microphoneCancellationSuppressesTranscriptButWaitsForStopped() {
  const child = fakeChild();
  const client = new VoiceWorkerClient({ root: path.resolve('.'), spawnProcess: () => child });
  const events = [];
  client.on('voice-event', event => events.push(event));
  client.startDictation({ requestId: 'mic-1', silenceMs: 900 });
  assert.strictEqual(client.stopDictation('mic-1', { cancel: true }), true);
  child.stdout.emit('data', '{"type":"final","requestId":"mic-1","transcript":"ignored"}\n');
  assert.strictEqual(events.some(item => item.type === 'final'), false);
  assert.notStrictEqual(client.active, null);
  child.stdout.emit('data', '{"type":"microphone_stopped","requestId":"mic-1"}\n');
  assert.strictEqual(client.active, null);
  client.shutdown({ force: true });
})();

(function rejectsConcurrentSessionsAndSurfacesWorkerFailure() {
  const child = fakeChild();
  const client = new VoiceWorkerClient({ root: path.resolve('.'), spawnProcess: () => child });
  const events = [];
  client.on('voice-event', event => events.push(event));
  assert.strictEqual(client.startDictation({ requestId: 'a' }).ok, true);
  assert.deepStrictEqual(client.startDictation({ requestId: 'b' }), { ok: false, error: 'voice_worker_busy' });
  child.emit('close', 7);
  assert.strictEqual(events.at(-1).type, 'error');
  assert.strictEqual(events.at(-1).requestId, 'a');
})();

(function dropsEventsForOldRequestIdsBeforeTheyReachTheRuntime() {
  const child = fakeChild();
  const client = new VoiceWorkerClient({ root: path.resolve('.'), spawnProcess: () => child });
  const events = [];
  client.on('voice-event', event => events.push(event));
  client.startDictation({ requestId: 'current' });
  child.stdout.emit('data', '{"type":"final","requestId":"old","transcript":"must not leak"}\n');
  assert.deepStrictEqual(events, []);
  client.shutdown({ force: true });
})();

(function bundledRuntimeUsesIsolatedPythonInvocationAndScrubbedEnvironment() {
  let invocation = null;
  const client = new VoiceWorkerClient({
    root: path.resolve('.'),
    pythonExecutable: 'C:\\bundle\\python.exe',
    pythonIsolated: true,
    baseEnv: { PYTHONPATH: 'host-path', VIRTUAL_ENV: 'host-env', KEEP: 'ok' },
    spawnProcess: (executable, args, options) => { invocation = { executable, args, options }; return fakeChild(); },
  });
  client.ensureStarted();
  assert.strictEqual(invocation.args[0], '-I');
  assert.strictEqual(invocation.options.env.PYTHONPATH, undefined);
  assert.strictEqual(invocation.options.env.VIRTUAL_ENV, undefined);
  assert.strictEqual(invocation.options.env.KEEP, 'ok');
  assert.strictEqual(invocation.options.env.PYTHONNOUSERSITE, '1');
}());

(function preloadLifecycleIsReportedWithoutAnActiveDictation() {
  const child = fakeChild();
  const client = new VoiceWorkerClient({
    root: path.resolve('.'),
    spawnProcess: () => child,
  });
  const statuses = [];
  client.on('worker-status', event => statuses.push(event));
  client.ensureStarted({ preload: true });
  child.stdout.emit('data', [
    '{"type":"loading","engine":"whisper-tiny-local"}',
    '{"type":"ready","engine":"whisper-tiny-local","memory_mb":442.25,"reused":false}',
    '',
  ].join('\n'));
  assert.deepStrictEqual(statuses.map(item => item.state), ['warming', 'ready']);
  assert.strictEqual(statuses[1].memory_mb, 442.25);
  client.shutdown({ force: true });
}());

(function failedJsonlWriteDoesNotCreateAPhantomActiveSession() {
  const child = fakeChild();
  child.stdin.writable = false;
  const client = new VoiceWorkerClient({
    root: path.resolve('.'),
    spawnProcess: () => child,
  });
  assert.deepStrictEqual(
    client.startDictation({ requestId: 'cannot-write' }),
    { ok: false, error: 'voice_worker_unavailable' },
  );
  assert.strictEqual(client.active, null);
}());

(function failedStopWriteKillsTheCaptureWorkerAndReportsFailure() {
  const child = fakeChild();
  const client = new VoiceWorkerClient({
    root: path.resolve('.'),
    spawnProcess: () => child,
  });
  assert.strictEqual(client.startDictation({ requestId: 'stop-write-fails' }).ok, true);
  child.stdin.writable = false;
  assert.strictEqual(client.stopDictation('stop-write-fails', { cancel: true }), false);
  assert.strictEqual(child.killed, true);
  assert.strictEqual(client.active, null);
  assert.strictEqual(client.child, null);
}());

(function failedStopWriteDetachesClientInsteadOfLeavingCaptureActive() {
  const child = fakeChild();
  const events = [];
  const client = new VoiceWorkerClient({
    root: path.resolve('.'),
    spawnProcess: () => child,
  });
  client.on('voice-event', event => events.push(event));
  assert.strictEqual(client.startDictation({ requestId: 'stop-write-fails' }).ok, true);
  child.stdin.writable = false;
  const stopped = client.stopDictation('stop-write-fails');
  assert.strictEqual(stopped, false);
  assert.strictEqual(client.active, null);
  assert.strictEqual(events.at(-1).type, 'error');
  assert.strictEqual(events.at(-1).requestId, 'stop-write-fails');
}());

(function childErrorWithoutCloseDetachesSoTheNextAttemptCanRespawn() {
  const children = [];
  const client = new VoiceWorkerClient({
    root: path.resolve('.'),
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
  });
  assert.strictEqual(client.startDictation({ requestId: 'spawn-error' }).ok, true);
  children[0].emit('error', new Error('spawn failed'));
  assert.strictEqual(client.child, null);
  assert.strictEqual(client.active, null);
  assert.strictEqual(client.startDictation({ requestId: 'retry' }).ok, true);
  assert.strictEqual(children.length, 2);
  client.shutdown({ force: true });
}());


(function engineFlowsToSpawnArgsAndIsValidated() {
  const capturedArgs = [];
  const client = new VoiceWorkerClient({
    root: path.resolve('.'),
    engine: 'sense_voice',
    spawnProcess: (executable, args) => { capturedArgs.push(args); return fakeChild(); },
  });
  client.ensureStarted({ preload: true });
  const args = capturedArgs[0];
  assert(args.includes('--engine'), 'spawn args must include --engine');
  assert.strictEqual(args[args.indexOf('--engine') + 1], 'sense_voice');
  client.shutdown({ force: true });

  assert.throws(() => new VoiceWorkerClient({ root: path.resolve('.'), engine: 'bogus' }),
    /engine must be auto, whisper, or sense_voice/);
}());
console.log('voice_worker_client_test: all assertions passed');
