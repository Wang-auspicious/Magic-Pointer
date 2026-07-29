'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { VoiceResidentRuntime } = require('../electron/voice_resident_runtime');

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.starts = [];
    this.stops = [];
    this.preloads = 0;
    this.shutdowns = 0;
  }
  ensureStarted({ preload = false } = {}) { if (preload) this.preloads += 1; }
  startDictation(value) {
    this.starts.push(value);
    return { ok: true, requestId: value.requestId, mode: value.inputWav ? 'wav' : 'microphone' };
  }
  stopDictation(requestId, options) { this.stops.push({ requestId, options }); return true; }
  shutdown() { this.shutdowns += 1; }
}

(function residentSessionsReuseOneClientAndRejectLateEvents() {
  const clients = [];
  const delivered = [];
  const statuses = [];
  const runtime = new VoiceResidentRuntime({
    createClient: () => { const client = new FakeClient(); clients.push(client); return client; },
    onDeliver: event => delivered.push(event),
    onStatus: status => statuses.push(status),
  });
  runtime.configure({ enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000, settingsPath: 'C:\\settings.json' });
  assert.strictEqual(runtime.start({ requestId: 'first', surface: 'stage', contextPath: 'C:\\frozen' }).ok, true);
  assert.strictEqual(statuses.at(-1).state, 'warming');
  clients[0].emit('voice-event', { type: 'ready', requestId: 'first', reused: false });
  assert.strictEqual(statuses.at(-1).state, 'recording');
  clients[0].emit('voice-event', { type: 'final', requestId: 'first', transcript: 'one' });
  assert.strictEqual(statuses.at(-1).state, 'releasing');
  clients[0].emit('voice-event', { type: 'microphone_stopped', requestId: 'first' });
  assert.strictEqual(statuses.at(-1).state, 'ready');
  assert.strictEqual(runtime.start({ requestId: 'second', surface: 'stage', contextPath: 'C:\\frozen' }).ok, true);
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(clients[0].starts[1].requestId, 'second');
  clients[0].emit('voice-event', { type: 'final', requestId: 'first', transcript: 'late' });
  clients[0].emit('voice-event', { type: 'ready', requestId: 'second', reused: true });
  assert.deepStrictEqual(delivered.filter(item => item.type === 'final').map(item => item.transcript), ['one']);
  assert.strictEqual(delivered.at(-1).reused, true);
}());

(function disabledModeUsesOnlyLegacyBridge() {
  const clients = [];
  const legacy = [];
  const runtime = new VoiceResidentRuntime({
    createClient: () => { const client = new FakeClient(); clients.push(client); return client; },
    startLegacy: value => { legacy.push(value); return { ok: true }; },
  });
  runtime.configure({ enabled: false, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  assert.strictEqual(runtime.start({ requestId: 'legacy', surface: 'stage', contextPath: 'C:\\frozen' }).ok, true);
  assert.strictEqual(clients.length, 0);
  assert.strictEqual(legacy.length, 1);
}());

(function activeConfigurationChangeIsRejectedAndIdleChangeRebuildsWorker() {
  const clients = [];
  const runtime = new VoiceResidentRuntime({ createClient: () => { const client = new FakeClient(); clients.push(client); return client; } });
  runtime.configure({ enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  runtime.warmUp();
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(runtime.start({ requestId: 'active', surface: 'stage', contextPath: '' }).ok, true);
  assert.deepStrictEqual(runtime.configure({ enabled: true, memoryLimitMb: 2048, idleUnloadMs: 300000 }), { ok: false, error: 'voice_session_active' });
  clients[0].emit('voice-event', { type: 'microphone_stopped', requestId: 'active' });
  assert.deepStrictEqual(runtime.configure({ enabled: true, memoryLimitMb: 2048, idleUnloadMs: 300000 }),
    { ok: true, rebuilt: true, changed: true });
  assert.strictEqual(clients[0].shutdowns, 1);
  runtime.warmUp();
  assert.strictEqual(clients.length, 2);
}());

(function cancellationSuppressesTranscriptUntilMicrophoneStopped() {
  const client = new FakeClient();
  const delivered = [];
  const runtime = new VoiceResidentRuntime({ createClient: () => client, onDeliver: event => delivered.push(event) });
  runtime.configure({ enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  runtime.start({ requestId: 'cancel', surface: 'stage', contextPath: '' });
  assert.strictEqual(runtime.stop('cancel', { cancel: true }), true);
  client.emit('voice-event', { type: 'partial', requestId: 'cancel', transcript: 'ignore' });
  client.emit('voice-event', { type: 'final', requestId: 'cancel', transcript: 'ignore' });
  assert.strictEqual(runtime.active.requestId, 'cancel');
  assert.strictEqual(delivered.some(item => item.type === 'final'), false);
  client.emit('voice-event', { type: 'microphone_stopped', requestId: 'cancel' });
  assert.strictEqual(runtime.active, null);
}());

(function microphoneErrorRemainsOwnedUntilStoppedAndRejectsLateResults() {
  const client = new FakeClient();
  const delivered = [];
  const runtime = new VoiceResidentRuntime({ createClient: () => client, onDeliver: event => delivered.push(event) });
  runtime.configure({ enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  runtime.start({ requestId: 'crash', surface: 'stage', contextPath: '' });
  client.emit('voice-event', { type: 'microphone_started', requestId: 'crash' });
  client.emit('voice-event', { type: 'error', requestId: 'crash', code: 'microphone_unavailable', error: 'no mic' });
  assert.strictEqual(runtime.active.requestId, 'crash');
  assert.strictEqual(runtime.active.faulted, true);
  assert.deepStrictEqual(
    runtime.configure({ enabled: true, memoryLimitMb: 2048, idleUnloadMs: 300000 }),
    { ok: false, error: 'voice_session_active' },
  );
  client.emit('voice-event', { type: 'final', requestId: 'crash', transcript: 'late' });
  assert.deepStrictEqual(delivered.map(event => event.type), ['error']);
  client.emit('voice-event', { type: 'microphone_stopped', requestId: 'crash' });
  assert.strictEqual(runtime.active, null);
}());

(function microphoneErrorBeforeCaptureStartsEndsImmediately() {
  const client = new FakeClient();
  const runtime = new VoiceResidentRuntime({ createClient: () => client });
  runtime.configure({ enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  runtime.start({ requestId: 'pre-capture-error', surface: 'stage', contextPath: '' });
  client.emit('voice-event', {
    type: 'error',
    requestId: 'pre-capture-error',
    code: 'microphone_unavailable',
    error: 'no mic',
  });
  assert.strictEqual(runtime.active, null);
}());

(function failedResidentStopClearsRuntimeAndReportsTransportFailure() {
  const client = new FakeClient();
  client.stopDictation = () => false;
  const statuses = [];
  const runtime = new VoiceResidentRuntime({
    createClient: () => client,
    onStatus: status => statuses.push(status),
  });
  runtime.configure({ enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  runtime.start({ requestId: 'cannot-stop', surface: 'stage', contextPath: '' });
  assert.strictEqual(runtime.stop('cannot-stop', { cancel: true }), false);
  assert.strictEqual(runtime.active, null);
  assert.strictEqual(statuses.at(-1).state, 'error');
  assert.strictEqual(statuses.at(-1).errorCode, 'voice_worker_transport_failed');
}());

(function configurationReportsWhetherItChanged() {
  const runtime = new VoiceResidentRuntime();
  const config = { enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000 };
  assert.deepStrictEqual(runtime.configure(config), { ok: true, rebuilt: false, changed: true });
  assert.deepStrictEqual(runtime.configure(config), { ok: true, rebuilt: false, changed: false });
}());

(function preloadStatusIsTruthfulAndProjectsNoRawWorkerErrorOrPath() {
  const client = new FakeClient();
  const statuses = [];
  const runtime = new VoiceResidentRuntime({
    createClient: () => client,
    onStatus: status => statuses.push(status),
  });
  runtime.configure({ enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  runtime.warmUp();
  client.emit('worker-status', {
    type: 'ready',
    state: 'ready',
    engine: 'whisper-tiny-local',
    memory_mb: 442.25,
    error: 'C:\\Users\\private\\.cache\\whisper\\tiny.pt',
  });
  assert.strictEqual(statuses.at(-1).state, 'ready');
  assert.strictEqual(statuses.at(-1).workerEvent.memory_mb, 442.25);
  assert.strictEqual(JSON.stringify(statuses.at(-1)).includes('C:\\\\Users\\\\private'), false);
}());

(function disabledModeDelegatesStopToTheLegacyController() {
  const stops = [];
  const runtime = new VoiceResidentRuntime({
    startLegacy: () => ({ ok: true }),
    stopLegacy: value => { stops.push(value); return true; },
  });
  runtime.configure({ enabled: false, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  runtime.start({ requestId: 'legacy-stop', surface: 'stage', contextPath: '' });
  assert.strictEqual(runtime.stop('legacy-stop', { graceful: false, cancel: true }), true);
  assert.deepStrictEqual(stops, [{
    requestId: 'legacy-stop',
    surface: 'stage',
    graceful: false,
    cancel: true,
  }]);
  assert.strictEqual(runtime.active.cancelled, true);
}());

(function mainOwnedWavEvidenceEndsOnFinalWithoutWaitingForMicrophoneStopped() {
  const client = new FakeClient();
  const runtime = new VoiceResidentRuntime({ createClient: () => client });
  runtime.configure({ enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  runtime.start({
    requestId: 'desktop-wav',
    surface: 'stage',
    contextPath: '',
    inputWav: 'C:\\evidence\\speech.wav',
  });
  assert.strictEqual(client.starts[0].inputWav, 'C:\\evidence\\speech.wav');
  client.emit('voice-event', { type: 'final', requestId: 'desktop-wav', transcript: 'done' });
  assert.strictEqual(runtime.active, null);
}());

(function synchronousWorkerStartFailureIsContainedAndReported() {
  const statuses = [];
  const runtime = new VoiceResidentRuntime({
    createClient: () => ({
      on: () => {},
      ensureStarted: () => { throw new Error('spawn failed'); },
      shutdown: () => {},
      removeAllListeners: () => {},
    }),
    onStatus: status => statuses.push(status),
  });
  runtime.configure({ enabled: true, memoryLimitMb: 1024, idleUnloadMs: 300000 });
  assert.doesNotThrow(() => runtime.warmUp());
  assert.strictEqual(statuses.at(-1).state, 'error');
  assert.strictEqual(statuses.at(-1).errorCode, 'voice_worker_start_failed');
}());

console.log('voice_resident_runtime_test: all assertions passed');
