'use strict';

const assert = require('assert');
const { scheduleBackgroundLearning } = require('../electron/background_learning');

{
  const calls: any[] = [];
  const logs: string[] = [];
  const scheduled = scheduleBackgroundLearning({
    enabled: true,
    request: { requested: true, sessionId: 'agent-s1', terminalReason: 'completed' },
    runBridge: (...args: any[]) => {
      calls.push(args);
      return { pid: 42 };
    },
    log: (message: string) => logs.push(message),
  });
  assert.strictEqual(scheduled, true);
  assert.strictEqual(calls[0][1], 'learning_review');
  assert.strictEqual(calls[0][2], null);
  assert.strictEqual(calls[0][3].allowWithoutSurface, true);
  calls[0][3].onComplete({ ok: true, candidateIds: ['c1'] });
  assert.ok(logs[0].includes('candidates=1'));
}

{
  let called = false;
  const scheduled = scheduleBackgroundLearning({
    enabled: true,
    request: { requested: false, sessionId: 'agent-s1', terminalReason: 'completed' },
    runBridge: () => { called = true; },
  });
  assert.strictEqual(scheduled, false);
  assert.strictEqual(called, false);
}

{
  let called = false;
  const scheduled = scheduleBackgroundLearning({
    enabled: false,
    request: { requested: true, sessionId: 'agent-s1', terminalReason: 'completed' },
    runBridge: () => { called = true; },
  });
  assert.strictEqual(scheduled, false);
  assert.strictEqual(called, false);
}

console.log('background_learning_wiring_test: all assertions passed');

const {test} = require('node:test');
const {mkdtemp, mkdir, readFile, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {createServer} = require('node:http');
const {EventSession} = require('../electron/runtime/session');
const {reviewLearning, LearningStore} = require('../electron/runtime/learning');
const {createArtifact, patchArtifact} = require('../electron/runtime/artifacts');

test('learning uses the latest human correction, reads the full target, and requires verified evidence for procedures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mp-learning-evidence-'));
  await mkdir(path.join(root, 'learning'));
  const original = 'Original rule.\n' + 'Keep this existing preference.\n'.repeat(100) + 'file-tail-marker\n';
  await writeFile(path.join(root, 'learning', 'MEMORY.md'), original);
  const session = await EventSession.open(root, 'agent-learning-fixture');
  await session.append('user/message', {message: {role: 'user', origin: 'instruction', content: 'Prepare a draft.'}}, 'append');
  for (let index = 0; index < 40; index++) {
    await session.appendMessage({role: 'assistant', content: 'Earlier evidence. '.repeat(100)});
  }
  const correction = await session.append('user/message', {message: {role: 'user', origin: 'instruction', content: 'latest-human-correction: Always use the new wording.'}}, 'append');
  const draft = await createArtifact(session, 'Use the old heading.', 'Heading');
  await patchArtifact(session, draft.artifactId, 1, 'Use the edited-only-wording heading.', {author: 'user'});
  const edited = session.events.at(-1);
  await session.append('receipt/issued', {receiptId: 'unverified-receipt', status: 'unverified', wrote: true, verified: false, memoryEligible: false, targets: []});
  const requests: string[] = [];
  let changeDuringDraft = false;
  const server = createServer(async (req: any, res: any) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(body);
    const reply = requests.length === 1 ? [
      {kind: 'memory', target: 'learning/MEMORY.md', rationale: 'The user corrected a durable wording preference.', evidenceIds: [`event:${correction.seq}`, `event:${edited.seq}`]},
      {kind: 'skill', target: 'skills/unverified/SKILL.md', rationale: 'Claimed workflow success.', evidenceIds: ['receipt:unverified-receipt']},
    ] : {edits: [{before: changeDuringDraft ? 'New wording rule.' : 'Original rule.', after: changeDuringDraft ? 'Later rule.' : 'New wording rule.'}]};
    if (changeDuringDraft && requests.length === 2) {
      const target = path.join(root, 'learning', 'MEMORY.md');
      await writeFile(target, (await readFile(target, 'utf8')) + '\nConcurrent user addition.');
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {role: 'assistant', content: JSON.stringify(reply)}}]}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = {model: 'fixture', apiMode: 'chat-completions', credential: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`};
    const result = await reviewLearning(root, session.id, session.events, 'completed', config);
    assert.ok(requests[0].includes('latest-human-correction'), 'the end-of-task correction was dropped behind early tool output');
    assert.ok(requests[0].includes('edited-only-wording'), 'user edits outside chat must remain learning evidence');
    assert.equal(requests.length, 2, 'only the grounded memory candidate should receive a full-target draft pass');
    assert.ok(requests[1].includes('file-tail-marker'), 'the draft model must see the complete target file');
    assert.equal(result.candidateIds.length, 1);
    assert.ok(result.warnings.some((warning: string) => /evidence|verified/i.test(warning)));
    const store = new LearningStore(root);
    const candidate = store.get(result.candidateIds[0]);
    assert.equal(candidate.original_content, original);
    assert.equal(candidate.proposed_content, original.replace('Original rule.', 'New wording rule.'));
    assert.equal(candidate.status, 'pending');
    assert.ok(candidate.evidence.some((item: {id: string}) => item.id === `event:${correction.seq}`));
    assert.equal(await readFile(path.join(root, 'learning', 'MEMORY.md'), 'utf8'), original, 'review must not apply a candidate');
    await store.mutate(candidate.id, 'apply');
    assert.equal(await readFile(path.join(root, 'learning', 'MEMORY.md'), 'utf8'), candidate.proposed_content);
    requests.length = 0;
    changeDuringDraft = true;
    const raced = await reviewLearning(root, session.id, session.events, 'completed', config);
    assert.equal(raced.candidateIds.length, 0, 'a file changed during model drafting must not get a stale proposal');
    assert.ok(raced.warnings.some((warning: string) => /changed during learning review/.test(warning)));
    assert.match(await readFile(path.join(root, 'learning', 'MEMORY.md'), 'utf8'), /New wording rule\.[\s\S]*Concurrent user addition\./);
  } finally {
    await new Promise<void>(resolve => server.close(resolve));
  }
});
