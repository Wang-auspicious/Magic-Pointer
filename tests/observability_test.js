'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const observability = require('../electron/observability');
const { redactSecrets } = require('../scripts/collect-diagnostics');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-obs-'));
observability.install({ runtimeDir: tmp, enableCrashReporter: false });

observability.writeEvent('unit.test', { hello: 'world', n: 1 });
observability.bump('unit.counter');
observability.bump('unit.counter', 4);

const { eventLogPath } = observability.paths();
assert.ok(fs.existsSync(eventLogPath), 'events.jsonl must be created');
const lines = fs.readFileSync(eventLogPath, 'utf8').trim().split('\n');
assert.ok(lines.length >= 2, 'session.start and unit.test events must be logged');
const parsed = lines.map((l) => JSON.parse(l));
assert.equal(parsed[0].type, 'session.start');
const hit = parsed.find((r) => r.type === 'unit.test');
assert.ok(hit && hit.hello === 'world' && hit.n === 1, 'writeEvent payload must round-trip');

const snap = observability.snapshotCounters();
assert.equal(snap['unit.counter'], 5, 'counters must accumulate');

const redacted = redactSecrets('api_key=sk-abcdef1234567890 password=hunter2 token=xyzxyzxyz\n');
assert.ok(!redacted.includes('sk-abcdef1234567890'), 'sk- keys must be redacted');
assert.ok(!redacted.includes('hunter2'), 'passwords must be redacted');
assert.ok(!redacted.includes('xyzxyzxyz'), 'tokens must be redacted');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log('observability_test: PASS');
