'use strict';


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

const observability = require('../electron/observability');
const { eventLogPath } = observability.install({
  runtimeDir: tmp,
  enableCrashReporter: false,
  rotateBytes: 400,
  history: 3,
});
assert.ok(fs.existsSync(eventLogPath), 'install() must flush session.start immediately');


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


observability.flushEvents();
observability.flushEvents();
const stable = readLines(eventLogPath).length;
observability.flushEvents();
assert.equal(readLines(eventLogPath).length, stable, 'flushEvents() must be idempotent with nothing pending');

observability.bump('rotate.counter', 2);
assert.equal(observability.snapshotCounters()['rotate.counter'], 2);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log('observability_event_log_rotation_test: PASS');
