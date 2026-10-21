import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildSystemPrompt} from '../electron/runtime/agent';
const {createConversationStore} = require('../electron/conversation_store');

test('Work and Code use distinct task instructions on the same runtime', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mp-work-mode-'));
  const work = await buildSystemPrompt({
    userDataDir,
    workspace: '',
    workMode: 'work',
  } as Parameters<typeof buildSystemPrompt>[0]);
  const code = await buildSystemPrompt({
    userDataDir,
    workspace: '',
    workMode: 'code',
  } as Parameters<typeof buildSystemPrompt>[0]);
  assert.match(work, /工作模式：Work/);
  assert.match(code, /工作模式：Code/);
  assert.notEqual(work, code);
});

test('conversation mode survives reopen and branch', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-work-session-'));
  const store = createConversationStore({baseDir});
  const conversation = store.appendTurn({
    question: 'Create a research brief',
    workMode: 'work',
    answer: 'Draft',
  });
  store.flush();
  const reopened = createConversationStore({baseDir});
  assert.equal(reopened.get(conversation.id).workMode, 'work');
  assert.equal(reopened.list()[0].workMode, 'work');
  assert.equal(reopened.branch(conversation.id, 0).workMode, 'work');
});
