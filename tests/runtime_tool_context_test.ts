import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {runAgent, buildSystemPrompt} from '../electron/runtime/agent';
import {ToolRegistry} from '../electron/runtime/tools';
import {
  initialToolNames,
  projectContextMessages,
  registerToolResultReader,
} from '../electron/runtime/agent_services';
import ExcelJS from 'exceljs';
import {prepareTaskContext} from '../electron/runtime/context_prepare';
import {handleArtifact, projectArtifacts} from '../electron/runtime/artifacts';

const schema = {type: 'object', properties: {}, required: []};

test('initial schemas stay small while the actual registry directory and exact loading remain available', () => {
  const registry = new ToolRegistry();
  for (const name of [
    'Tools',
    'AskUser',
    'ToolResult.read',
    'Read',
    'Write',
    'Edit',
    'Patch',
    'Glob',
    'Bash',
    'get_app_state',
    'Agent',
  ]) {
    registry.register({
      name,
      description: `${name} fixture`,
      input_schema: schema,
      execute: () => name,
    });
  }
  registry.setInitialTools(initialToolNames({workspace: 'C:/work'}));
  assert.deepEqual(
    registry.schemas().map(item => item.name),
    ['Tools', 'AskUser', 'ToolResult.read', 'Read', 'Write', 'Edit', 'Patch'],
  );
  assert(registry.directory().split(', ').includes('Bash'));
  assert(!registry.directory().split(', ').includes('Read'));
  registry.discover({names: ['Bash', 'Agent']});
  assert(registry.schemas().some(item => item.name === 'Bash'));
  assert(registry.schemas().some(item => item.name === 'Agent'));
});

test('ordinary task metadata is not described as a user screen selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-prompt-selection-'));
  const prompt = await buildSystemPrompt({
    userDataDir: root,
    workspace: root,
    evidence: 'Current task sources and references: []',
  });
  assert.doesNotMatch(prompt, /用户圈选了对象/);
});

test('structured source and desktop target add only their direct readers without text routing', () => {
  const names = initialToolNames({
    taskContext: {sources: [{sourceId: 'attached', kind: 'file'}]},
    selectionSnapshot: {snapshot_id: 'target'},
  });
  assert(names.includes('Context.read'));
  assert(names.includes('Context.search'));
  assert(names.includes('look'));
  assert(names.includes('get_app_state'));
  assert(!names.includes('Bash'));
  assert(!names.includes('Agent'));
  assert.deepEqual(
    initialToolNames({workspace: 'C:/work', permissionMode: 'safe'}),
    ['Tools', 'AskUser', 'ToolResult.read', 'Read'],
  );
  assert.ok(
    initialToolNames({
      taskContext: {
        sources: [{kind: 'document', capabilities: ['read', 'patch']}],
      },
    }).includes('Document.propose_patch'),
  );
});

test('a document edit pauses at one reviewable draft and resumes after its verified application', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-document-review-'));
  const file = path.join(root, 'review.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.getCell('B2').value = 120;
  sheet.getCell('C2').value = 'neighbor';
  await workbook.xlsx.writeFile(file);
  const session = await EventSession.open(root, 'agent-document-review');
  const registry = new ToolRegistry();
  const source = {
    sourceId: 'source:sheet',
    taskId: session.id,
    kind: 'document',
    title: 'review.xlsx',
    identity: {absolutePath: file},
    revision: {authority: 'disk'},
    capabilities: ['read', 'patch'],
    origin: 'user-pointed',
    parentSourceId: null,
  };
  const reference = {
    referenceId: 'target:B2',
    sourceId: source.sourceId,
    locator: {kind: 'cell-range', value: {sheet: 'Sheet1', range: 'B2'}},
    label: 'B2',
    role: 'target',
    active: true,
    ordinal: 1,
    frameLeaseId: null,
    capturedAtMs: Date.now(),
  };
  const prepared = await prepareTaskContext(
    session,
    {
      question: 'Change B2 to 210',
      sources: [source],
      inputArtifact: {references: [reference]},
    },
    {root, userDataDir: root, registry},
  );
  let calls = 0;
  const first = await runAgent({
    root,
    userDataDir: root,
    session,
    registry,
    instruction: 'Change B2 to 210',
    system: 'Test',
    authorizeAccess: prepared.authorizeAccess,
    model: async () => {
      calls++;
      if (calls === 1)
        return {
          text: '',
          tool_calls: [
            {
              id: 'read-sheet',
              name: 'Context.read',
              arguments: {source_id: source.sourceId},
            },
          ],
        };
      if (calls === 2)
        return {
          text: '',
          tool_calls: [
            {
              id: 'review-sheet',
              name: 'Document.propose_patch',
              arguments: {
                summary: 'B2 120 → 210',
                operations: [
                  {
                    operationId: 'b2',
                    operation: 'set_cell_values',
                    sourceId: source.sourceId,
                    referenceId: reference.referenceId,
                    locator: reference.locator,
                    before: [[120]],
                    after: [[210]],
                  },
                ],
              },
            },
          ],
        };
      return {
        text: 'Would keep looking for another execution path',
        tool_calls: [],
      };
    },
  });
  assert.equal(first.reason, 'awaiting_user');
  assert.equal(
    calls,
    2,
    'a review requirement must not cause more model calls or desktop detours',
  );
  assert.equal(first.pending_input?.kind, 'artifact');
  const pending = (
    await EventSession.open(root, session.id, false)
  ).pendingInput();
  assert.equal(pending?.artifactId, first.pending_input?.artifactId);
  const artifactId = String(pending?.artifactId);
  await assert.rejects(
    session.answer(String(pending?.requestId), {
      applied: true,
      artifactRevision: pending?.artifactRevision,
      receiptId: 'claimed-success',
    }),
    /artifact_application_not_verified/,
  );
  const draft = projectArtifacts(session.events).find(
    item => item.artifactId === artifactId,
  )!;
  const patchPayload = structuredClone(draft.patchPayload) as {
    operations: Array<{after: unknown}>;
  };
  patchPayload.operations[0].after = [[211]];
  const edited = await handleArtifact(
    {
      action: 'edit',
      sessionId: session.id,
      artifactId,
      expectedRevision: pending?.artifactRevision,
      content: 'B2 120 → 211, edited by user',
      patchPayload,
    },
    root,
  );
  assert.equal(edited.ok, true);
  const revision = Number((edited.artifact as {revision: number}).revision);
  const accepted = await handleArtifact(
    {action: 'accept', sessionId: session.id, artifactId, revision},
    root,
  );
  assert.equal(accepted.ok, true);
  const applied = await handleArtifact(
    {action: 'apply', sessionId: session.id, artifactId, revision},
    root,
  );
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.readyToResume, true);
  await session.refresh();
  assert.equal(session.pendingInput(), null);
  const finished = await runAgent({
    root,
    userDataDir: root,
    session,
    registry: new ToolRegistry(),
    system: 'Test',
    model: async request => {
      const proposal = [...request.messages].reverse().find(
        message =>
          message.role === 'tool' && message.name === 'Document.propose_patch',
      );
      const reviewed = JSON.parse(proposal!.content!);
      assert.equal(reviewed.applied, true);
      assert.deepEqual(
        reviewed.applicationResult.inverseRecords[0].expectedCurrent,
        [[211]],
        'the model must see the applied user edit, not its original proposal',
      );
      return {text: 'B2 is 211; C2 is unchanged.', tool_calls: []};
    },
  });
  assert.equal(finished.receipt.status, 'succeeded');
  assert.equal(finished.receipt.wrote, true);
  assert.equal(finished.receipt.verified, true);
  const actual = new ExcelJS.Workbook();
  await actual.xlsx.readFile(file);
  assert.equal(actual.worksheets[0].getCell('B2').value, 211);
  assert.equal(actual.worksheets[0].getCell('C2').value, 'neighbor');
});

test('large results project to a short model message and remain readable by call id', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-tool-context-'));
  const session = await EventSession.open(root, 'tool-context');
  const full = 'START\n' + 'x'.repeat(12000) + '\nEND';
  await session.append('operation/prepared', {
    operationId: 'op',
    callId: 'call-1',
    name: 'Inspect',
    effect: 'read',
    dispatched: true,
  });
  await session.append('operation/settled', {
    operationId: 'op',
    outcome: 'succeeded',
    message: {
      role: 'tool',
      name: 'Inspect',
      tool_call_id: 'call-1',
      content: full,
    },
  });
  const registry = new ToolRegistry();
  registerToolResultReader(registry, session);
  const projected = projectContextMessages([
    {role: 'tool', name: 'Inspect', tool_call_id: 'call-1', content: full},
  ]);
  assert(projected[0]!.content!.length < 4000);
  assert.match(projected[0]!.content!, /ToolResult\.read/);
  assert.match(projected[0]!.content!, /call-1/);
  const page = await registry.execute({
    id: 'read-result',
    name: 'ToolResult.read',
    arguments: {tool_call_id: 'call-1', offset: 11900, limit: 200},
  });
  assert.equal(page.is_error, false, page.error_message);
  assert.equal((page.value as {content: string}).content, full.slice(11900));
});

test('production loop retains a result over 64K and reads its tail through the model tool', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-large-result-'));
  const session = await EventSession.open(root, 'large-result');
  const registry = new ToolRegistry();
  registerToolResultReader(registry, session);
  const full = 'START\n' + 'x'.repeat(70000) + '\nEND';
  registry.register({
    name: 'LargeEvidence',
    description: 'Read large evidence',
    input_schema: schema,
    execute: () => full,
  });
  let step = 0;
  const result = await runAgent({
    root,
    userDataDir: root,
    session,
    registry,
    system: 'Test',
    instruction: 'Read the tail of evidence',
    model: async request => {
      step++;
      if (step === 1)
        return {
          text: '',
          tool_calls: [{id: 'big', name: 'LargeEvidence', arguments: {}}],
        };
      if (step === 2) {
        const projected = request.messages.at(-1)!.content!;
        assert(projected.length < 4000);
        assert.match(projected, /ToolResult\.read/);
        return {
          text: '',
          tool_calls: [
            {
              id: 'tail',
              name: 'ToolResult.read',
              arguments: {tool_call_id: 'big', offset: 69950, limit: 100},
            },
          ],
        };
      }
      assert.match(request.messages.at(-1)!.content!, /END/);
      return {text: 'Read back', tool_calls: []};
    },
  });
  assert.equal(result.reason, 'completed');
  assert.equal(step, 3);
  const saved = session.events.find(
    event => event.type === 'operation/settled' && event.data.operationId,
  )?.data.message as {content: string};
  assert.equal(saved.content, full);
});
