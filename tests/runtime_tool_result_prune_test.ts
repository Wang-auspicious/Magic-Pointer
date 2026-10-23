'use strict';
// C3 tool-result pruning + P2 look-staleness seam (2026-10-12 RUNTIME-B lane).
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {pruneToolResults} = require('../electron/runtime/session');
const {lookStaleness} = require('../electron/runtime/desktop_perception');

const tool = (
  id: string,
  name: string,
  content: string,
  isError = false,
) => ({
  role: 'tool',
  content,
  tool_call_id: id,
  name,
  is_error: isError,
});

test('dedup collapses repeated results to a hash note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const first = tool('a1', 'read', 'same body');
  const second = tool('a2', 'read', 'same body');
  const {messages, stats} = pruneToolResults([first, second], dir);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /duplicate read output [0-9a-f]{8} omitted/);
  assert.equal(messages[1].content, 'same body');
  assert.equal(messages[1].tool_call_id, 'a2');
  assert.equal(stats.deduped, 1);
});

test('only the newest results stay full; older ones demote to one line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const input = [];
  for (let i = 0; i < 12; i++) {
    input.push(tool(`id-${i}`, 'read', `body number ${i} with padding xxxxx`));
  }
  const {messages, stats} = pruneToolResults(input, dir);
  assert.equal(messages.length, 12);
  assert.equal(messages[11].content.includes('body number 11'), true);
  assert.equal(messages[1].content.includes('body number 1'), true);
  assert.match(messages[0].content, /\[read output demoted: body number 0/);
  assert.equal(stats.demoted, 2);
});

test('results over 64k spill to disk with a pointer left behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const big = 'z'.repeat(70000);
  const {messages, stats} = pruneToolResults([tool('b1', 'read', big)], dir);
  assert.equal(stats.spilled, 1);
  const note = messages[0].content;
  assert.match(note, /spilled to [0-9a-f]{32}\.txt \(70000 chars\)/);
  const file = note.match(/spilled to ([0-9a-f]{32}\.txt)/)[1];
  assert.equal(fs.readFileSync(path.join(dir, file), 'utf8').length, 70000);
});

test('error results keep their flag when demoted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const input = [tool('e0', 'bash', 'old failure text', true)];
  for (let i = 1; i <= 11; i++) {
    input.push(tool(`id-${i}`, 'read', `fresh body ${i}`));
  }
  const {messages} = pruneToolResults(input, dir);
  assert.equal(messages[0].is_error, true);
  assert.match(messages[0].content, /\[bash failed: old failure text\]/);
});

test('look is fresh with no live observations, stale after one', () => {
  const frame = '2026-10-12T00:00:00.000Z';
  assert.equal(
    lookStaleness(
      [
        {
          type: 'operation/settled',
          data: {outcome: 'succeeded', message: {name: 'read'}},
          time: Date.parse('2026-10-12T01:00:00.000Z'),
        },
      ],
      frame,
    ).stale,
    false,
  );
  const stale = lookStaleness(
    [
      {
        type: 'operation/settled',
        data: {outcome: 'succeeded', message: {name: 'get_app_state'}},
        time: Date.parse('2026-10-12T01:00:00.000Z'),
      },
    ],
    frame,
  );
  assert.equal(stale.stale, true);
  assert.match(stale.detail, /get_app_state/);
});

test('look is fresh without a frame timestamp', () => {
  assert.equal(
    lookStaleness(
      [
        {
          type: 'operation/settled',
          data: {outcome: 'succeeded', message: {name: 'get_app_state'}},
          time: Date.now(),
        },
      ],
      '',
    ).stale,
    false,
  );
});
