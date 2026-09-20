import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
const source = fs.readFileSync(path.resolve(__dirname, '../electron/main.ts'), 'utf8');
const begin = source.indexOf('async function sendConversation(');
const validation = source.slice(begin, source.indexOf('  const conversationId =', begin)) + ' return { ok: true, question }; }';
const sandbox: any = {};
vm.runInNewContext(transformSync(validation, { loader: 'ts' }).code, sandbox);
(async () => {
  const question = '中'.repeat(12000);
  assert.equal((await sandbox.sendConversation({ question })).question.length, question.length, 'all text accepted by the composer reaches the runtime unchanged');
  assert.equal((await sandbox.sendConversation({ question: question + 'x' })).ok, false, 'oversize input is rejected before history mutation');
  console.log('conversation_question_length_test: passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
