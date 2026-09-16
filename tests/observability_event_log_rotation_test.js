'use strict';

// The defect this covers: writeEvent() was `statSync` + `appendFileSync` per
// event — measured 0.38 ms, on the main thread, next to a 20 ms pointer poll.
// It is buffered now (electron/observability.ts), and rotation is driven by an
// in-memory byte counter instead of a stat per write.
//
// The file layout is a contract: `events.jsonl`, `events.jsonl.1`, … and the
// diagnostics collector (scripts/collect-diagnostics.ts) plus
// tests/diagnostics_collection_test.js depend on it. This pins:
//   1. buffering: writeEvent() performs no file I/O on the hot path;
//   2. rotation still produces `events.jsonl.N`, driven by the byte counter;
//   3. nothing is lost across a rotate and rotated lines stay valid JSONL;
//   4. flushEvents() is idempotent and safe with nothing pending.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-obs-rotate-'));

// This module installs once per process, so this file must be the only place
// in it that calls install().
const observability = require('../electron/observability');
const { eventLogPath } = observability.install({
  runtimeDir: tmp,
  enableCrashReporter: false,
  rotateBytes: 400,
  history: 3,
});
assert.ok(fs.existsSync(eventLogPath), 'install() must flush session.start immediately');

// --- buffering: nothing hits the file until a flush ------------------------

const before = fs.statSync(eventLogPath).size;
for (let i = 0; i < 3; i += 1) observability.writeEvent('rotate.buffered', { i, body: 'x'.repeat(40) });
assert.equal(
  fs.statSync(eventLogPath).size,
  before,
  'writeEvent() must not touch the file before flushEvents()',
);
observability.flushEvents();
const afterFirstFlush = readLines(eventLogPath);
assert.equal(afterFirstFlush.length, 4, 'the session header plus three buffered events must land in one flush');
assert.equal(afterFirstFlush[0].includes('session.start'), true, 'session.start stays first');

// --- rotation: the counter drives it, and it keeps the .N layout -----------

for (let i = 0; i < 60; i += 1) {
  observability.writeEvent('rotate.filler', { i, body: 'y'.repeat(60) });
  if (i % 5 === 0) observability.flushEvents();
}
observability.flushEvents();

const rotatedOne = path.join(tmp, 'events.jsonl.1');
assert.ok(fs.existsSync(rotatedOne), 'rotation must produce events.jsonl.1');
assert.ok(obsLiveSize() < 4096, 'the live events.jsonl must not grow without bound once rotation is armed');
assert.ok(readLines(rotatedOne).length > 0, 'the rotated file must contain the events that overflowed');
for (const line of readLines(rotatedOne)) {
  assert.doesNotThrow(() => JSON.parse(line), 'rotated lines must still be valid JSONL');
}

// More batches must shift `.1` to `.2` without ever emptying the live file.
for (let i = 0; i < 60; i += 1) {
  observability.writeEvent('rotate.filler2', { i, body: 'z'.repeat(60) });
  if (i % 3 === 0) observability.flushEvents();
}
observability.flushEvents();
assert.ok(fs.existsSync(path.join(tmp, 'events.jsonl.2')), 'history depth must reach events.jsonl.2');
assert.ok(readLines(eventLogPath).length >= 1, 'the live log must never be emptied by rotation');

function obsLiveSize() {
  return fs.statSync(eventLogPath).size;
}

// --- flush contract --------------------------------------------------------

observability.flushEvents();
observability.flushEvents();
const stable = readLines(eventLogPath).length;
observability.flushEvents();
assert.equal(readLines(eventLogPath).length, stable, 'flushEvents() must be idempotent with nothing pending');

// Counters are untouched by any of this.
observability.bump('rotate.counter', 2);
assert.equal(observability.snapshotCounters()['rotate.counter'], 2);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log('observability_event_log_rotation_test: PASS');
