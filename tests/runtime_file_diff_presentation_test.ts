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
    await run({root, session, registry, execute, sink, packets});
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
    assert.equal(
      (batchHtml.match(/class="mp-chat-action mp-chat-diff-copy"/g) || [])
        .length,
      1,
    );
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

test('multi-file Patch retains each verified file version and lazy preview after reopening history', () =>
  withFiles(async f => {
    const before = 'unchanged first\nold middle\nunchanged last\n';
    await writeFile(path.join(f.root, 'edit.txt'), before);
    await writeFile(path.join(f.root, 'gone.txt'), 'deleted content\n');
    const result = await f.execute('Patch', {
      patch: [
        '*** Begin Patch\n*** Update File: edit.txt\n@@\n-old middle\n+new middle\n*** Add File: new.txt\n+created content\n*** End Patch',
        '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch',
      ],
    });
    assert.equal(result.presentation?.kind, 'file_diffs');
    assert.deepEqual(
      result.presentation.files.map((entry: any) => entry.path),
      ['edit.txt', 'new.txt', 'gone.txt'],
    );
    const versions = [];
    for (const entry of result.presentation.files) {
      const view = await readFileDiffPresentation(entry.presentation);
      assert.equal(view.ok, true);
      versions.push((view as any).presentation);
      assert.equal(
        entry.absolutePath,
        path.join(f.root, entry.path).replaceAll('\\', '/'),
      );
    }
    assert.equal(versions[0].beforeText, before);
    assert.equal(
      versions[0].afterText,
      before.replace('old middle', 'new middle'),
    );
    assert.equal(versions[1].beforeText, '');
    assert.equal(versions[1].afterText, 'created content\n');
    assert.equal(versions[2].beforeText, 'deleted content\n');
    assert.equal(versions[2].afterText, '');
    assert.equal(
      await readFile(result.presentation.files[2].previewPath, 'utf8'),
      'deleted content\n',
    );
    const store = createConversationStore({baseDir: f.root});
    const saved = store.appendTurn({
      newConversation: true,
      question: 'Patch files',
      answer: 'Saved',
      trajectory: f.sink.trajectory,
    });
    store.flush();
    await writeFile(path.join(f.root, 'edit.txt'), 'later user text');
    const turn = createConversationStore({baseDir: f.root}).get(saved.id)!
      .turns[0];
    const stored = turn.trajectory!.find((row: any) => row.presentation)!;
    assert.deepEqual(stored.presentation, result.presentation);
    const html = chat
      .assistantTurnNode(turn)
      .map((node: any) => node.outerHTML)
      .join('');
    assert.equal((html.match(/data-file-diff-reference=/g) || []).length, 3);
    assert.ok(
      html.includes(
        'data-preview-path="' + result.presentation.files[2].previewPath + '"',
      ),
    );
    assert.doesNotMatch(
      html,
      /later user text|checkpoint_restore|file_bytes_readback/,
    );
    assert.doesNotMatch(
      JSON.stringify(result.value),
      /beforeText|afterText|\.after\.txt/,
    );
    assert.doesNotMatch(
      JSON.stringify(f.session.deriveMessages()),
      /unchanged first|unchanged last/,
    );
  }));

test('multiple patches of one file preview the tool call net versions once', () =>
  withFiles(async f => {
    await writeFile(path.join(f.root, 'file.txt'), 'context\nbefore\n');
    const result = await f.execute('Patch', {
      patch: [
        '*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+intermediate\n*** End Patch',
        '*** Begin Patch\n*** Update File: file.txt\n@@\n-intermediate\n+final\n*** End Patch',
      ],
    });
    assert.equal(result.presentation.files.length, 1);
    const view = await readFileDiffPresentation(
      result.presentation.files[0].presentation,
    );
    assert.equal((view as any).presentation.beforeText, 'context\nbefore\n');
    assert.equal((view as any).presentation.afterText, 'context\nfinal\n');
  }));

test('a moved Patch file retains source deletion and destination bytes, including CSV encoding', () =>
  withFiles(async f => {
    await writeFile(path.join(f.root, 'source.csv'), 'col,value\nold,1\n');
    const result = await f.execute('Patch', {
      patch:
        '*** Begin Patch\n*** Update File: source.csv\n*** Move to: destination.csv\n@@\n-old,1\n+new,2\n*** End Patch',
    });
    assert.equal(result.presentation?.files.length, 2);
    const [removed, created] = await Promise.all(
      result.presentation.files.map((entry: any) =>
        readFileDiffPresentation(entry.presentation),
      ),
    );
    assert.equal((removed as any).presentation.afterText, '');
    assert.equal(
      (removed as any).presentation.beforeText,
      'col,value\nold,1\n',
    );
    assert.equal((created as any).presentation.beforeText, '');
    assert.equal(
      (created as any).presentation.afterText,
      await readFile(path.join(f.root, 'destination.csv'), 'utf8'),
    );
  }));

test('partially failed Patch retains actual file receipts and never advertises an unverified group preview', () =>
  withFiles(async f => {
    const result = await f.registry.execute({
      id: 'partial',
      name: 'Patch',
      arguments: {
        patch: [
          '*** Begin Patch\n*** Add File: first.txt\n+confirmed\n*** End Patch',
          '*** Begin Patch\n*** Update File: missing.txt\n@@\n-missing\n+new\n*** End Patch',
        ],
      },
    });
    assert.equal(result.is_error, true);
    assert.equal(result.presentation, undefined);
    assert.equal(
      await readFile(path.join(f.root, 'first.txt'), 'utf8'),
      'confirmed\n',
    );
    assert.equal(result.value.patches[0].fileChanges[0].path, 'first.txt');
  }));

test('Rewind presents actual inverse versions once per restored file and retains a removed file opener', () =>
  withFiles(async f => {
    await writeFile(path.join(f.root, 'edited.txt'), 'context\noriginal\n');
    await writeFile(path.join(f.root, 'deleted.txt'), 'restored deletion\n');
    await f.execute('Read', {path: 'edited.txt'});
    await f.execute('Edit', {
      path: 'edited.txt',
      old_string: 'original',
      new_string: 'intermediate',
    });
    await f.execute('Edit', {
      path: 'edited.txt',
      old_string: 'intermediate',
      new_string: 'final',
    });
    await f.execute('Write', {
      path: 'created.txt',
      content: 'removed creation\n',
    });
    await f.execute('Patch', {
      patch: '*** Begin Patch\n*** Delete File: deleted.txt\n*** End Patch',
    });
    const result = await f.execute('Rewind', {steps: 0});
    assert.equal(result.presentation?.kind, 'file_diffs');
    assert.equal(result.presentation.files.length, 3);
    const versions = new Map<string, any>();
    for (const file of result.presentation.files) {
      const display = await readFileDiffPresentation(file.presentation);
      assert.equal(display.ok, true);
      versions.set(file.path, (display as any).presentation);
    }
    assert.deepEqual(versions.get('edited.txt'), {
      kind: 'file_diff',
      beforeText: 'context\nfinal\n',
      afterText: 'context\noriginal\n',
    });
    assert.deepEqual(versions.get('deleted.txt'), {
      kind: 'file_diff',
      beforeText: '',
      afterText: 'restored deletion\n',
    });
    assert.deepEqual(versions.get('created.txt'), {
      kind: 'file_diff',
      beforeText: 'removed creation\n',
      afterText: '',
    });
    const removed = result.presentation.files.find(
      (file: any) => file.path === 'created.txt',
    );
    assert.equal(
      await readFile(removed.previewPath, 'utf8'),
      'removed creation\n',
    );
    assert.match(removed.previewPath, /\.txt$/);
    const html = chat.toolRowNode(
      chat.toolRowModel('Rewind', '{}', {
        text: JSON.stringify(result.value),
        presentation: result.presentation,
      }),
    ).outerHTML;
    assert.equal((html.match(/data-file-diff-reference=/g) || []).length, 3);
    assert.ok(html.includes('data-preview-path="' + removed.previewPath + '"'));
    assert.doesNotMatch(html, /checkpoint_restore|restored_files_only/);
    assert.doesNotMatch(
      JSON.stringify(result.value),
      /\.after\.txt|beforeText|afterText/,
    );
    const store = createConversationStore({baseDir: f.root});
    const saved = store.appendTurn({
      newConversation: true,
      question: 'Restore files',
      answer: 'Restored',
      trajectory: f.sink.trajectory,
    });
    store.flush();
    await writeFile(path.join(f.root, 'edited.txt'), 'later text');
    const turn = createConversationStore({baseDir: f.root}).get(saved.id)!
      .turns[0];
    assert.deepEqual(
      turn.trajectory!.filter((row: any) => row.presentation).at(-1)!
        .presentation,
      result.presentation,
    );
    assert.equal(versions.get('edited.txt').afterText, 'context\noriginal\n');
  }));

test('partial-step Rewind shows the inverse of just the selected checkpoint', () =>
  withFiles(async f => {
    await writeFile(path.join(f.root, 'file.txt'), 'original\n');
    await f.execute('Read', {path: 'file.txt'});
    await f.execute('Edit', {
      path: 'file.txt',
      old_string: 'original',
      new_string: 'first',
    });
    await f.execute('Edit', {
      path: 'file.txt',
      old_string: 'first',
      new_string: 'second',
    });
    const result = await f.execute('Rewind', {steps: 1});
    assert.equal(result.presentation?.files.length, 1);
    const display = await readFileDiffPresentation(
      result.presentation.files[0].presentation,
    );
    assert.deepEqual((display as any).presentation, {
      kind: 'file_diff',
      beforeText: 'second\n',
      afterText: 'first\n',
    });
    assert.equal(
      await readFile(path.join(f.root, 'file.txt'), 'utf8'),
      'first\n',
    );
  }));

test('Rewind with no retained checkpoints does not create a fake preview', () =>
  withFiles(async f => {
    const result = await f.execute('Rewind', {steps: 0});
    assert.equal(result.presentation, undefined);
    assert.deepEqual(result.value.restored, []);
  }));

test('a binary Rewind result retains its removed bytes without fabricating a text diff', () =>
  withFiles(async f => {
    await f.execute('Write', {
      path: 'binary.dat',
      content: 'prefix\u0000suffix',
    });
    const result = await f.execute('Rewind', {steps: 1});
    const entry = result.presentation.files[0];
    assert.equal(entry.exists, false);
    assert.deepEqual(entry.presentation, {
      kind: 'file_diff_unavailable',
      reason: 'binary',
    });
    assert.equal(
      await readFile(entry.previewPath, 'utf8'),
      'prefix\u0000suffix',
    );
    const html = chat.toolRowNode(
      chat.toolRowModel('Rewind', '{}', {
        text: JSON.stringify(result.value),
        presentation: result.presentation,
      }),
    ).outerHTML;
    assert.match(html, /mp-chat-diff-notice/);
    assert.doesNotMatch(
      html,
      /data-kind="add"|data-kind="del"|mp-chat-diff-copy/,
    );
  }));

test('an optional Rewind snapshot failure does not undo the verified restore', async t => {
  const files = require('node:fs/promises');
  const original = files.writeFile;
  await withFiles(async f => {
    await f.execute('Write', {
      path: 'created.txt',
      content: 'removed creation\n',
    });
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
    const result = await f.execute('Rewind', {steps: 1});
    assert.equal(result.value.verification.matched, true);
    assert.deepEqual(result.presentation.files[0].presentation, {
      kind: 'file_diff_unavailable',
      reason: 'capture_failed',
    });
    assert.equal(
      await readFile(result.presentation.files[0].previewPath, 'utf8'),
      'removed creation\n',
    );
  });
});

test('a failed deleted-preview copy leaves a truthful restored result and a plain filename', async t => {
  const files = require('node:fs/promises');
  await withFiles(async f => {
    await f.execute('Write', {
      path: 'created.txt',
      content: 'removed creation\n',
    });
    t.mock.method(files, 'copyFile', async () => {
      throw new Error('preview copy unavailable');
    });
    const result = await f.execute('Rewind', {steps: 1});
    assert.equal(result.value.verification.matched, true);
    const entry = result.presentation.files[0];
    assert.equal(entry.exists, false);
    assert.equal(entry.previewPath, undefined);
    assert.deepEqual(entry.presentation, {
      kind: 'file_diff_unavailable',
      reason: 'capture_failed',
    });
    const html = chat.toolRowNode(
      chat.toolRowModel('Rewind', '{}', {
        text: JSON.stringify(result.value),
        presentation: result.presentation,
      }),
    ).outerHTML;
    assert.match(html, /<span class="mp-chat-diff-path"/);
    assert.doesNotMatch(html, /data-mp-chat-act="open-file"/);
  });
});

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

test('a Patch group keeps unavailable files separate from its readable file', () =>
  withFiles(async f => {
    const result = await f.execute('Patch', {
      patch: `*** Begin Patch\n*** Add File: large.txt\n+${'x'.repeat(200001)}\n*** Add File: binary.txt\n+prefix\u0000suffix\n*** Add File: small.txt\n+readable\n*** End Patch`,
    });
    assert.deepEqual(
      result.presentation.files
        .slice(0, 2)
        .map((entry: any) => entry.presentation),
      [
        {kind: 'file_diff_unavailable', reason: 'too_large'},
        {kind: 'file_diff_unavailable', reason: 'binary'},
      ],
    );
    assert.equal(result.presentation.files[2].presentation.kind, 'file_diff');
    const html = chat.toolRowNode(
      chat.toolRowModel('Patch', JSON.stringify(result.arguments), {
        text: JSON.stringify(result.value),
        presentation: result.presentation,
      }),
    ).outerHTML;
    assert.equal((html.match(/mp-chat-diff-notice/g) || []).length, 2);
    assert.equal((html.match(/data-file-diff-reference=/g) || []).length, 1);
    assert.doesNotMatch(html, /prefix|file_bytes_readback/);
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
    const patch = await f.execute('Patch', {
      patch:
        '*** Begin Patch\n*** Add File: patched.txt\n+also saved\n*** End Patch',
    });
    assert.equal(
      await readFile(path.join(f.root, 'patched.txt'), 'utf8'),
      'also saved\n',
    );
    assert.deepEqual(patch.presentation.files[0].presentation, {
      kind: 'file_diff_unavailable',
      reason: 'capture_failed',
    });
  });
});
