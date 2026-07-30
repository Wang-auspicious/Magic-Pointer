'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  collectDiagnosticFiles,
  redactSecrets,
} = require('../scripts/collect-diagnostics');

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-diag-runtime-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-diag-outside-'));
fs.writeFileSync(path.join(runtime, 'events.jsonl'), '{"type":"started"}\n');
fs.writeFileSync(path.join(runtime, 'events.jsonl.1'), '{"type":"old"}\n');
fs.writeFileSync(path.join(runtime, 'electron.log'), 'safe log\n');
fs.writeFileSync(path.join(runtime, 'current-object.json'), '{"content":"private selection"}\n');
fs.writeFileSync(path.join(runtime, 'task-artifact.png'), 'private binary capture');
fs.mkdirSync(path.join(runtime, 'artifacts'));
fs.writeFileSync(path.join(runtime, 'artifacts', 'notes.txt'), 'private task result');
fs.writeFileSync(path.join(outside, 'external.log'), 'outside data');
try {
  fs.symlinkSync(path.join(outside, 'external.log'), path.join(runtime, 'linked.log'));
} catch (_) {
  // Symlink creation can require a Windows developer privilege; the collector
  // still has a direct lstat contract exercised when the link is available.
}

const files = collectDiagnosticFiles(runtime).map((entry) => entry.rel).sort();
assert.deepStrictEqual(files, ['electron.log', 'events.jsonl', 'events.jsonl.1'],
  'diagnostics must contain only the reviewed root log allowlist, never user content or links');

const redacted = redactSecrets(JSON.stringify({
  api_key: 'sk-secret',
  nested: { authorization: 'Bearer very-secret', token: 'abc' },
  message: 'password=hunter2 github_pat_1234567890abcdefghijklmnop',
}));
assert.doesNotMatch(redacted, /sk-secret|very-secret|hunter2|github_pat_1234567890abcdefghijklmnop/,
  'diagnostic serialization must redact sensitive JSON fields and common token forms');

fs.rmSync(runtime, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log('diagnostics collection test ok');
