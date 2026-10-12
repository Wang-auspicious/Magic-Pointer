'use strict';

// Which tool cards open themselves.
//
// The reference opens a card by default in exactly three cases, and MP can
// only express one of them: a question that is still waiting for an answer.
// (`PushNotification` is not a tool MP emits, and MP has no verbose transcript
// mode, so those two arms have no counterpart here.)
//
// The load-bearing part is the negative: everything else stays closed, because
// a transcript that opens cards by itself buries the answer the user asked for.

const assert = require('node:assert/strict');

global.document = undefined;
const ChatView = require('../electron/renderer/chat_view');
const {toolRowModel} = ChatView;

function openState(name, result) {
  const model = toolRowModel(name, JSON.stringify({path: 'a.txt', question: 'Which?'}), result);
  const row = ChatView.toolRowNode(model);
  return row.outerHTML;
}

ChatView.expansion.clear();

const pending = openState('AskUserQuestion', undefined);
assert.match(pending, /data-open="true"/,
  'a question still awaiting an answer opens itself, so it is not missed');
assert.match(pending, /aria-expanded="true"/);

const answered = openState('AskUserQuestion', {text: JSON.stringify({answered: true})});
assert.match(answered, /data-open="false"/,
  'an answered question collapses like any other settled tool');

for (const [name, result] of [
  ['read', undefined],
  ['read', {text: 'ok'}],
  ['bash', undefined],
  ['edit', {text: 'ok'}],
  ['grep', undefined],
]) {
  assert.match(
    openState(name, result),
    /data-open="false"/,
    `${name} must not open itself — only a pending question does`,
  );
}

// A user's own toggle still wins over the default.
const rowId = 'tool:q1';
ChatView.expansion.setRow(rowId, false);
const model = toolRowModel('AskUserQuestion', JSON.stringify({questions: []}));
const collapsed = ChatView.toolRowNode({...model, callId: 'q1'});
assert.match(collapsed.outerHTML, /data-open="false"/,
  'a remembered collapse beats the pending-question default');

console.log('chat default open contract ok');
