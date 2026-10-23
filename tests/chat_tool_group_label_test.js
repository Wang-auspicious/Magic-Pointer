'use strict';

// The recovered Cu summary describes observed actions even while busy.
// Per-row gerunds remain separate from these mixed-group phrases.

const assert = require('node:assert/strict');

global.document = undefined;
const ChatView = require('../electron/renderer/chat_view');
const {toolGroupLabel} = ChatView.__test;

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
assert.equal(
  toolGroupLabel([done('read'), done('read'), done('read')]),
  'Read 3 files',
);
assert.equal(toolGroupLabel([done('edit')]), 'Edited a file');
assert.equal(
  toolGroupLabel([done('bash'), chip('bash', {text: 'x', isError: true})]),
  'Ran 2 commands (1 failed)',
  'a failure count rides its own clause',
);

// Pending keys count once and do not keep a stale failed outcome.
assert.equal(toolGroupLabel([running('read')]), 'Read a file');
assert.equal(
  toolGroupLabel([running('read'), running('read'), running('read')]),
  'Read 3 files',
);
assert.equal(
  toolGroupLabel([running('bash'), running('bash')]),
  'Ran 2 commands',
);
assert.equal(toolGroupLabel([running('write')]), 'Created a file');
assert.equal(toolGroupLabel([running('edit')]), 'Edited a file');

assert.equal(toolGroupLabel([running('Frobnicate')]), 'Used a tool');

// A family with no running form gets the count fallback for several tools.
assert.equal(
  toolGroupLabel([running('Frobnicate'), running('Frobnicate')]),
  'Used 2 tools',
);

// Categories retain their first observed order.
assert.equal(
  toolGroupLabel([done('bash'), running('read'), running('read')]),
  'Ran a command, read 2 files',
  'busy state does not reorder the actual action summary',
);

console.log('chat tool group label ok');
