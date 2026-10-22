import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {registerCodingTools} from '../electron/runtime/agent_files';
import {runAgent} from '../electron/runtime/agent';
import {RuntimeActivitySink} from '../electron/runtime/agent_activity';
import {ToolRegistry} from '../electron/runtime/tools';
import {EventSession} from '../electron/runtime/session';
import {createConversationStore} from '../electron/conversation_store';
import {readFileDiffPresentation} from '../electron/file_diff_presentation';

const chat = require('../electron/renderer/chat_view');

async function withFiles(run: (fixture: any) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-file-diff-ui-'));
  const session = await EventSession.open(root, 'agent-file-diff-ui');
  await session.startTurn();
  const registry = new ToolRegistry();
  registerCodingTools(registry, root, session);
  const packets: any[] = [];
  const sink = new RuntimeActivitySink((phase, fields) =>
    packets.push({phase, fields}),
  );
  let call = 0;
  const execute = async (name: string, args: Record<string, unknown>) => {
    const result = await registry.execute({
      id: `c${++call}`,
      name,
      arguments: args,
    });
    assert.equal(result.is_error, false, result.error_message);
    if (name !== 'Read') {
      sink.onEvent({kind: 'tool_call_finished', result});
    }
    return result as any;
  };
  try {
    await run({root, session, execute, sink, packets});
  } finally {
    await session.endTurn('completed');
    await rm(root, {recursive: true, force: true});
  }
}

test('an overwrite preview retains actual before and after after reopening history', () =>
  withFiles(async f => {
    const before = 'retained first\nold middle\nretained last\n';
    const after = 'retained first\nnew middle\nretained last\n';
    await writeFile(path.join(f.root, 'file.txt'), before);
    await f.execute('Read', {path: 'file.txt'});
    const result = await f.execute('Write', {path: 'file.txt', content: after});
    const retained = await readFileDiffPresentation(result.presentation);
    if (!retained.ok) {
      throw new Error(retained.error);
    }
    assert.deepEqual(retained.presentation, {
      kind: 'file_diff',
      beforeText: before,
      afterText: after,
    });
    assert.doesNotMatch(JSON.stringify(result.value), /beforeText|afterText/);
    await writeFile(path.join(f.root, 'file.txt'), 'later user modification');
    const store = createConversationStore({baseDir: f.root});
    const saved = store.appendTurn({
      newConversation: true,
      question: 'Overwrite',
      answer: 'Saved',
      trajectory: f.sink.trajectory,
    });
    store.flush();
    const turn = createConversationStore({baseDir: f.root}).get(saved.id)!
      .turns[0];
    const stored = turn.trajectory!.find((row: any) => row.presentation)!;
    assert.deepEqual(stored.presentation, result.presentation);
    stored.presentation = (
      (await readFileDiffPresentation(stored.presentation as any)) as any
    ).presentation;
    const html = chat
      .assistantTurnNode(turn)
      .map((node: any) => node.outerHTML)
      .join('');
    assert.match(html, /data-kind="context"> {2}retained first/);
    assert.ok(html.includes('- old middle'));
    assert.ok(html.includes('+ new middle'));
    assert.doesNotMatch(html, /later user modification|\+ retained first/);
    const packet = f.packets.find(
      (entry: any) => entry.phase === 'tool_result',
    );
    const live = chat.liveActivityNode({
      phase: packet.phase,
      fields: JSON.parse(Buffer.from(packet.fields.b64, 'base64').toString()),
    }).outerHTML;
    assert.ok(live.includes('load-file-diff'));
  }));

test('Edit retains whole-file context and Write CSV copies actual encoded content', () =>
  withFiles(async f => {
    const before = 'context first\r\nold\ncontext last\r\n';
    await writeFile(path.join(f.root, 'edit.txt'), before);
    await f.execute('Read', {path: 'edit.txt'});
    const edited = await f.execute('Edit', {
      path: 'edit.txt',
      old_string: 'old',
      new_string: 'new',
    });
    const editView = await readFileDiffPresentation(edited.presentation);
    if (!editView.ok) {
      throw new Error(editView.error);
    }
    assert.equal(editView.presentation.beforeText, before);
    assert.equal(
      editView.presentation.afterText,
      await readFile(path.join(f.root, 'edit.txt'), 'utf8'),
    );
    const batch = await f.execute('Edit', {
      path: 'edit.txt',
      edits: [
        {old_string: 'new', new_string: 'final'},
        {old_string: 'context last', new_string: 'updated last'},
      ],
    });
    const batchHtml = chat.toolRowNode(
      chat.toolRowModel('Edit', JSON.stringify(batch.arguments), {
        text: JSON.stringify(batch.value),
        presentation: (
          (await readFileDiffPresentation(batch.presentation)) as any
        ).presentation,
      }),
    ).outerHTML;
    assert.equal((batchHtml.match(/mp-chat-diff-copy/g) || []).length, 1);
    assert.match(batchHtml, /data-kind="context"> {2}context first/);
    const csv = await f.execute('Write', {
      path: 'table.csv',
      content: 'col,value\n一,2\n',
    });
    const persisted = await readFile(path.join(f.root, 'table.csv'), 'utf8');
    const csvView = await readFileDiffPresentation(csv.presentation);
    if (!csvView.ok) {
      throw new Error(csvView.error);
    }
    assert.equal(csvView.presentation.beforeText, '');
    assert.equal(csvView.presentation.afterText, persisted);
    assert.ok(persisted.startsWith('\ufeff'));
    const model = chat.toolRowModel('Write', JSON.stringify(csv.arguments), {
      text: JSON.stringify(csv.value),
      presentation: csvView.presentation,
    });
    const html = chat.toolRowNode(model).outerHTML;
    assert.ok(html.includes('data-mp-chat-copy="' + persisted + '"'));
  }));

test('presentation stays per call and does not survive failed verification', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'Presented',
    description: 'File preview',
    input_schema: {type: 'object', properties: {}, required: []},
    execute: (_args, context) => {
      context.present?.({
        kind: 'file_diff',
        beforePath: '/old',
        afterPath: '/new',
      });
      return 'ok';
    },
  });
  registry.register({
    name: 'Plain',
    description: 'No preview',
    input_schema: {type: 'object', properties: {}, required: []},
    execute: () => 'ok',
  });
  registry.register({
    ...registry.get('Presented'),
    name: 'Rejected',
    verify_result: () => {
      throw new Error('not verified');
    },
  });
  assert.ok(
    (await registry.execute({id: '1', name: 'Presented', arguments: {}}))
      .presentation,
  );
  assert.equal(
    (await registry.execute({id: '2', name: 'Plain', arguments: {}}))
      .presentation,
    undefined,
  );
  const failed = await registry.execute({
    id: '3',
    name: 'Rejected',
    arguments: {},
  });
  assert.equal(failed.is_error, true);
  assert.equal(failed.presentation, undefined);
});

test('large and binary file results explicitly omit a fabricated diff', () =>
  withFiles(async f => {
    for (const [file, content, reason] of [
      ['large.txt', 'x'.repeat(200001), 'too_large'],
      ['binary.txt', 'prefix\u0000suffix', 'binary'],
    ]) {
      const result = await f.execute('Write', {path: file, content});
      assert.deepEqual(result.presentation, {
        kind: 'file_diff_unavailable',
        reason,
      });
      const model = chat.toolRowModel(
        'Write',
        JSON.stringify(result.arguments),
        {text: JSON.stringify(result.value), presentation: result.presentation},
      );
      const html = chat.toolRowNode(model).outerHTML;
      assert.doesNotMatch(html, /data-kind="add"|mp-chat-diff-copy/);
      assert.match(html, /mp-chat-diff-notice/);
    }
  }));

test('display-only file content does not enter the next model request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-presentation-model-'));
  try {
    const session = await EventSession.open(root, 'agent-presentation-model');
    const registry = new ToolRegistry();
    registry.register({
      name: 'Preview',
      description: 'Produce a UI view',
      input_schema: {type: 'object', properties: {}, required: []},
      execute: (_args, context: any) => {
        context.present({
          kind: 'file_diff',
          beforePath: path.join(root, 'before.txt'),
          afterPath: path.join(root, 'after.txt'),
        });
        return {message: 'ok'};
      },
    });
    await writeFile(path.join(root, 'before.txt'), 'DISPLAY_ONLY_SENTINEL');
    await writeFile(path.join(root, 'after.txt'), 'view');
    const sink = new RuntimeActivitySink(() => {});
    let round = 0;
    const result = await runAgent({
      root,
      userDataDir: root,
      session,
      registry,
      onEvent: sink.onEvent,
      model: async request => {
        if (++round === 1) {
          return {
            text: '',
            tool_calls: [{id: 'p', name: 'Preview', arguments: {}}],
          };
        }
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /DISPLAY_ONLY_SENTINEL|beforeText|afterText/,
        );
        return {text: 'Done', tool_calls: []};
      },
    });
    assert.equal(result.reason, 'completed', result.message);
    assert.equal(round, 2);
    const display = await readFileDiffPresentation(
      sink.trajectory.find(row => row.presentation)!.presentation as any,
    );
    assert.equal(display.ok, true);
    if (display.ok) {
      assert.equal(display.presentation.beforeText, 'DISPLAY_ONLY_SENTINEL');
    }
    assert.doesNotMatch(
      JSON.stringify(session.deriveMessages()),
      /DISPLAY_ONLY_SENTINEL/,
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a preview capture failure leaves the real verified Write successful', async t => {
  const files = require('node:fs/promises');
  const original = files.writeFile;
  t.mock.method(
    files,
    'writeFile',
    async (file: unknown, ...args: unknown[]) => {
      if (String(file).endsWith('.after.txt')) {
        throw new Error('preview storage unavailable');
      }
      return original(file, ...args);
    },
  );
  await withFiles(async f => {
    const result = await f.execute('Write', {
      path: 'saved.txt',
      content: 'actual saved file',
    });
    assert.equal(
      await readFile(path.join(f.root, 'saved.txt'), 'utf8'),
      'actual saved file',
    );
    assert.deepEqual(result.presentation, {
      kind: 'file_diff_unavailable',
      reason: 'capture_failed',
    });
    assert.equal(result.value.verification.matched, true);
  });
});
