'use strict';

// Group labels read differently while the group is still running.
//
// The reference counts only the tools still in flight, uses gerunds for the
// running form, and reserves the "{verb} {count} {noun}" shape for the five
// names in its read/write/edit/bash set. Two things are easy to regress:
//   - counting the whole run instead of the in-flight remainder;
//   - inventing a running form for a family that has none ("Running 2 tools…"
//     is the fallback, not "Using 2 tools…").
//
// The completed forms are pinned here too, because they are the half already
// matching the reference and must not drift while the running half changes.

const assert = require('node:assert/strict');

global.document = undefined;
const ChatView = require('../electron/renderer/chat_view');
const {toolGroupLabel, runningGroupClause} = ChatView.__test;

const chip = (name, result) => ({
  name,
  args: '{}',
  result,
  rowId: `${name}-${Math.round(Math.abs(Math.random() * 1e6))}`,
});
const running = name => chip(name, undefined);
const done = name => chip(name, {text: 'ok'});

// Completed forms match the reference verbatim (report 32 §2: singulars use
// "a", not "1" — `Ran a command`, `Read a file`, `Edited a file`).
assert.equal(toolGroupLabel([done('bash')]), 'Ran a command');
assert.equal(toolGroupLabel([done('bash'), done('bash')]), 'Ran 2 commands');
assert.equal(toolGroupLabel([done('read')]), 'Read a file');
assert.equal(toolGroupLabel([done('read'), done('read'), done('read')]), 'Read 3 files');
assert.equal(toolGroupLabel([done('edit')]), 'Edited a file');
assert.equal(
  toolGroupLabel([done('bash'), chip('bash', {text: 'x', isError: true})]),
  'Ran 2 commands (1 failed)',
  'a failure count rides its own clause',
);

// Running forms: gerund + in-flight count + ellipsis.
assert.equal(runningGroupClause([running('read')]), 'Reading 1 file…');
assert.equal(
  runningGroupClause([running('read'), running('read'), running('read')]),
  'Reading 3 files…',
);
assert.equal(runningGroupClause([running('bash'), running('bash')]), 'Running 2 commands…');
assert.equal(runningGroupClause([running('write')]), 'Creating 1 file…',
  'the reference runs Write as "Creating" in groups too');
assert.equal(runningGroupClause([running('edit')]), 'Editing 1 file…');

// A single unnamed tool falls back to its own running verb, not a bare count.
assert.equal(runningGroupClause([running('Frobnicate')]), 'Frobnicate…',
  'an unnamed tool is shown by name rather than swallowed into a count');

// A family with no running form gets the count fallback for several tools.
assert.equal(
  runningGroupClause([running('Frobnicate'), running('Frobnicate')]),
  '2 tools running…',
);

// The count is of what is still in flight, not of the whole run.
assert.equal(
  toolGroupLabel([done('bash'), running('read'), running('read')]),
  'Reading 2 files… · Ran a command',
  'settled members move into the completed clause instead of inflating the running count',
);

console.log('chat tool group label ok');
