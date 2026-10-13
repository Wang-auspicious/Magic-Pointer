'use strict';

// A tool row names what it is doing in the tense it is doing it.
//
// The reference keeps three verbs per tool and selects by status: a gerund
// while the call is in flight, the completed verb once it lands, and a failed
// verb on error. Two properties are load-bearing and easy to regress:
//   - the gerunds are not mechanical ("Write" runs as "Creating", not
//     "Writing"), so they must stay a lookup rather than a suffix rule;
//   - a tool nobody has named keeps its raw name mid-flight, because showing
//     the wrong tool is worse than showing the wrong tense.

const assert = require('node:assert/strict');

global.document = undefined;
const ChatView = require('../electron/renderer/chat_view');

function title(name, args, result) {
  return ChatView.toolRowModel(name, JSON.stringify(args), result).title;
}

const running = undefined;
const ok = {text: 'done'};
const failed = {text: 'boom', isError: true};

assert.equal(title('read', {path: 'a.txt'}, running), 'Reading',
  'a read in flight is a gerund');
assert.equal(title('read', {path: 'a.txt'}, ok), 'Read',
  'a settled read drops back to the completed verb');

assert.equal(title('write', {path: 'a.txt'}, running), 'Creating',
  'the reference runs Write as "Creating", not "Writing" — the gerund is a lookup, not a suffix');
assert.equal(title('write', {path: 'a.txt'}, ok), 'Created',
  'the reference past-tenses settled Write as "Created" (group singular "Created a file"), not "Wrote"');

assert.equal(title('edit_file', {path: 'a.txt'}, running), 'Editing');
assert.equal(title('bash', {command: 'ls'}, running), 'Running');
assert.equal(title('grep', {pattern: 'x'}, running), 'Searching');

assert.equal(title('Frobnicate', {arg: 'x'}, running), 'Frobnicate',
  'an unnamed tool keeps its raw name mid-flight; a wrong tool beats a wrong tense');

assert.equal(title('read', {path: 'a.txt'}, failed), 'Read',
  'a failure falls back to the completed verb until a failed verb is defined for it');
assert.equal(title('bash', {command: 'ls'}, failed), 'Ran');

// The running verb must reach the row, not just the model.
ChatView.expansion.clear();
const row = ChatView.toolRowNode(ChatView.toolRowModel('read', JSON.stringify({path: 'a.txt'})));
assert.match(row.outerHTML, /Reading/,
  'an in-flight row shows its gerund');
const settledRow = ChatView.toolRowNode(
  ChatView.toolRowModel('read', JSON.stringify({path: 'a.txt'}), ok),
);
assert.doesNotMatch(settledRow.outerHTML, /Reading/,
  'a settled row must not still say it is reading');

console.log('chat tool verb contract ok');
