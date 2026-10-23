import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';
import {registerCodingTools} from '../electron/runtime/agent_files';
import {RuntimeActivitySink} from '../electron/runtime/agent_activity';
import {createConversationStore} from '../electron/conversation_store';
import {readFileDiffPresentation} from '../electron/file_diff_presentation';

const chat = require('../electron/renderer/chat_view');
function nodes(root: any, name: string): any[] {
  if (typeof root?.getAttribute !== 'function') return [];
  return [
    ...(root.getAttribute('class')?.split(' ').includes(name) ? [root] : []),
    ...root.children.flatMap((child: any) => nodes(child, name)),
  ];
}
function text(node: any): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}
function call(id: string, name = 'Edit', path = 'src/main.ts', added = 1) {
  return {
    kind: 'tool',
    callId: id,
    name,
    text: JSON.stringify({
      path,
      content: `saved ${id}\n`,
      old_string: `old ${id}`,
      new_string: `new ${id}`,
    }),
    result: JSON.stringify({
      path,
      absolutePath: `D:/work/${path}`,
      created: name === 'Write',
      diffStat: {added, removed: 1},
      turnDiffStat: {added: 1, removed: 1},
    }),
  };
}
function render(trajectory: any[]) {
  return chat.assistantTurnNode({
    conversationId: 'coalescing',
    turnIndex: 0,
    answer: 'Saved.',
    trajectory,
    request: {executionWorkspaceRoot: 'D:/work'},
  })[0];
}

test('same-operation same-path edits have one independent header and every result body', () => {
  const root = render([call('a'), call('b')]);
  const group = nodes(root, 'mp-chat-tool-group')[0];
  assert.equal(group.getAttribute('data-single'), 'true');
  assert.equal(nodes(root, 'mp-chat-tool').length, 1);
  assert.equal(nodes(root, 'mp-chat-coalesced-result').length, 2);
  assert.equal(nodes(root, 'mp-chat-files').length, 0);
  assert.equal(
    text(nodes(group, 'mp-chat-tool-group-title')[0]),
    'Edited main.ts+2−2',
  );
  const results = nodes(root, 'mp-chat-coalesced-result');
  assert.deepEqual(
    results.map(node => node.getAttribute('data-call-id')),
    ['a', 'b'],
  );
  assert.match(results[0].outerHTML, /old a|new a/);
  assert.match(results[1].outerHTML, /old b|new b/);
});

test('repeated Write takes the last successful statistic instead of summing overwritten content', () => {
  const root = render([
    call('a', 'Write', 'notes.txt', 3),
    call('b', 'Write', 'notes.txt', 7),
  ]);
  assert.equal(
    text(nodes(root, 'mp-chat-tool-group-title')[0]),
    'Created notes.txt+7−1',
  );
  assert.equal(nodes(root, 'mp-chat-coalesced-result').length, 2);
  assert.equal(nodes(root, 'mp-chat-files').length, 0);
});

test('adjacent file calls coalesce inside a mixed group while other calls and footer stay accessible', () => {
  const root = render([
    call('read', 'Read'),
    call('a'),
    call('b'),
    call('shell', 'Bash'),
  ]);
  assert.equal(
    nodes(root, 'mp-chat-tool-group')[0].getAttribute('data-single'),
    null,
  );
  assert.equal(nodes(root, 'mp-chat-tool').length, 3);
  assert.equal(nodes(root, 'mp-chat-coalesced-result').length, 2);
  assert.equal(nodes(root, 'mp-chat-files').length, 1);
});

test('operation, path, narration, notice and thinking boundaries do not lose separate results', () => {
  for (const tail of [call('b', 'Write'), call('b', 'Edit', 'other.ts')]) {
    assert.equal(
      nodes(render([call('a'), tail]), 'mp-chat-coalesced-result').length,
      0,
    );
  }
  for (const boundary of [
    {kind: 'message', text: 'Next.'},
    {kind: 'notice', text: 'Notice.'},
    {kind: 'think', text: 'Reasoning.'},
  ]) {
    const root = render([call('a'), boundary, call('b')]);
    assert.equal(nodes(root, 'mp-chat-coalesced-result').length, 0);
    assert.equal(nodes(root, 'mp-chat-tool').length, 2);
    assert.equal(nodes(root, 'mp-chat-files').length, 1);
  }
  const aliases = render([
    call('a'),
    call('b', 'MultiEdit'),
    call('c', 'edit_file'),
  ]);
  assert.equal(
    nodes(aliases, 'mp-chat-tool-group')[0].getAttribute('data-single'),
    'true',
  );
  assert.equal(nodes(aliases, 'mp-chat-coalesced-result').length, 3);
});

test('a coalesced row follows running and final outcome without hiding earlier failures', () => {
  const first = call('a');
  const failed = {...call('b'), result: 'Disk full', isError: true};
  const pending = {...call('b'), result: undefined, state: 'running'};
  const running = render([first, pending]);
  assert.equal(
    nodes(running, 'mp-chat-tool')[0].getAttribute('data-state'),
    'running',
  );
  assert.match(
    text(nodes(running, 'mp-chat-tool-group-title')[0]),
    /^Editing /,
  );
  const failure = render([first, failed]);
  assert.equal(
    nodes(failure, 'mp-chat-tool')[0].getAttribute('data-state'),
    'error',
  );
  assert.match(text(failure), /Disk full/);
  const recovered = render([
    {...first, result: 'Earlier failure', isError: true},
    call('b'),
  ]);
  assert.equal(
    nodes(recovered, 'mp-chat-tool')[0].getAttribute('data-state'),
    'ok',
  );
  assert.match(text(recovered), /Earlier failure/);
  assert.match(
    text(nodes(recovered, 'mp-chat-tool-group-title')[0]),
    /^Edited /,
  );
});

test('coalesced Read shows the original complete range annotation only for known ranges', () => {
  const reads = [1, 11].map((offset, i) => ({
    ...call(String(i), 'Read'),
    text: JSON.stringify({path: 'src/main.ts', offset, limit: 10}),
    result: `range ${offset}`,
  }));
  const root = render(reads);
  assert.equal(
    text(nodes(root, 'mp-chat-tool-group-title')[0]),
    'Read main.ts (1–10, 11–20)',
  );
  assert.equal(nodes(root, 'mp-chat-coalesced-result').length, 2);
});

test('unknown counts stay unknown, failed calls do not inflate counts, and stopped outcomes remain stopped', () => {
  const first = call('a');
  const unknown = {
    ...call('b'),
    result: JSON.stringify({path: 'src/main.ts', diffStat: null}),
  };
  assert.equal(
    nodes(
      nodes(render([first, unknown]), 'mp-chat-tool-group-title')[0],
      'mp-chat-diff-stat',
    ).length,
    0,
  );
  const failed = {...call('b'), result: 'Disk full', isError: true};
  const root = render([first, failed]);
  assert.equal(
    text(
      nodes(nodes(root, 'mp-chat-tool-group-title')[0], 'mp-chat-diff-stat')[0],
    ),
    '+1−1',
  );
  assert.match(text(nodes(root, 'mp-chat-tool-group-header')[0]), /Failed/);
  assert.match(
    text(
      nodes(
        render([{...first, result: 'First failure', isError: true}, failed]),
        'mp-chat-tool-group-title',
      )[0],
    ),
    /^Failed to edit/,
  );
  const stopped = {
    ...call('b'),
    result: 'Interrupted before writing',
    interrupted: true,
  };
  assert.equal(
    nodes(render([first, stopped]), 'mp-chat-tool')[0].getAttribute(
      'data-state',
    ),
    'stopped',
  );
});

test('shared result bodies retain shell output, questions, plans, search results and child navigation', () => {
  const row = (name: string, args: unknown, result: unknown, id = '') =>
    chat.toolRowNode(
      chat.toolRowModel(
        name,
        JSON.stringify(args),
        {text: JSON.stringify(result)},
        id,
      ),
    );
  assert.match(
    text(
      row(
        'Bash',
        {command: 'echo result'},
        {stdout: 'actual stdout', stderr: '', exit: 0},
      ),
    ),
    /actual stdout/,
  );
  const todos = [{content: 'Inspect the file', status: 'completed'}];
  assert.equal(
    nodes(row('Todo', {todos}, {plan: todos}), 'mp-chat-todo-item').length,
    1,
  );
  const questions = [{question: 'Which format?', options: [{label: 'Report'}]}];
  assert.match(
    text(
      row(
        'AskUser',
        {questions},
        {answered: true, answers: {'Which format?': 'Report'}},
      ),
    ),
    /Which format\?Report/,
  );
  const search = row(
    'WebSearch',
    {query: 'source'},
    {
      results: [
        {
          title: 'Actual source',
          url: 'https://example.com/source',
          content: 'Actual excerpt',
        },
      ],
    },
  );
  assert.match(text(search), /Actual source/);
  assert.match(search.outerHTML, /1 result/);
  assert.match(
    row('Agent', {description: 'Inspect child'}, {status: 'completed'}, 'child')
      .outerHTML,
    /data-mp-chat-act="open-subagent"/,
  );
});

test('expansion survives growing a file row, entering a mixed group and returning', () => {
  chat.expansion.clear();
  let root = render([call('a')]);
  const groupId = nodes(root, 'mp-chat-tool-group-header')[0].getAttribute(
    'data-group-id',
  );
  chat.expansion.setGroup(groupId, true);
  root = render([call('a'), call('b')]);
  assert.equal(nodes(root, 'mp-chat-tool-group')[0].getAttribute('open'), '');
  root = render([call('a'), call('b'), call('read', 'Read')]);
  const row = nodes(root, 'mp-chat-tool')[0];
  const disclosure = nodes(row, 'mp-chat-disclosure')[0];
  const rowId = disclosure.getAttribute('data-row-id');
  assert.equal(disclosure.getAttribute('data-open'), 'true');
  chat.expansion.setRow(rowId, true);
  root = render([call('a'), call('b')]);
  assert.equal(nodes(root, 'mp-chat-tool-group')[0].getAttribute('open'), '');
  chat.expansion.setGroup(groupId, false);
  root = render([call('a'), call('b')]);
  assert.equal(nodes(root, 'mp-chat-tool-group')[0].getAttribute('open'), null);
});

test('actual persisted edits keep both lazy versions and net footer counts when coalesced in a mixed group', async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), 'mp-coalesced-edits-'),
  );
  const session = await EventSession.open(workspace, 'coalesced-files');
  await session.startTurn();
  try {
    const registry = new ToolRegistry();
    registerCodingTools(registry, workspace, session);
    const sink = new RuntimeActivitySink(() => {});
    const run = async (
      id: string,
      name: string,
      args: Record<string, unknown>,
    ) => {
      const result = await registry.execute({id, name, arguments: args});
      assert.equal(result.is_error, false, result.error_message);
      sink.onEvent({kind: 'tool_call_finished', result});
    };
    await writeFile(path.join(workspace, 'main.ts'), 'value=0\nretained\n');
    await run('read', 'Read', {path: 'main.ts'});
    await run('a', 'Edit', {
      path: 'main.ts',
      old_string: 'value=0',
      new_string: 'value=1',
    });
    await run('b', 'Edit', {
      path: 'main.ts',
      old_string: 'value=1',
      new_string: 'value=2',
    });
    assert.equal(
      await readFile(path.join(workspace, 'main.ts'), 'utf8'),
      'value=2\nretained\n',
    );
    const store = createConversationStore({baseDir: workspace});
    const saved = store.appendTurn({
      newConversation: true,
      question: 'Edit twice',
      answer: 'Saved.',
      trajectory: sink.trajectory,
    });
    store.flush();
    const turn = createConversationStore({baseDir: workspace}).get(saved.id)!
      .turns[0];
    let root = chat.assistantTurnNode(turn)[0];
    assert.equal(nodes(root, 'mp-chat-tool').length, 2);
    assert.equal(nodes(root, 'mp-chat-diff-load').length, 2);
    const grouped = nodes(root, 'mp-chat-tool')[1];
    assert.equal(text(nodes(grouped, 'mp-chat-title')[0]), 'Edited');
    assert.equal(text(nodes(grouped, 'mp-chat-diff-stat')[0]), '+2−2');
    assert.equal(
      text(nodes(nodes(root, 'mp-chat-files')[0], 'mp-chat-diff-stat')[0]),
      '+1−1',
    );
    const retained = [];
    for (const record of turn.trajectory || []) {
      if (!record.presentation) continue;
      const loaded = await readFileDiffPresentation(record.presentation as any);
      assert.equal(loaded.ok, true);
      if (loaded.ok) {
        retained.push(loaded.presentation);
        record.presentation = loaded.presentation;
      }
    }
    assert.deepEqual(retained, [
      {
        kind: 'file_diff',
        beforeText: 'value=0\nretained\n',
        afterText: 'value=1\nretained\n',
      },
      {
        kind: 'file_diff',
        beforeText: 'value=1\nretained\n',
        afterText: 'value=2\nretained\n',
      },
    ]);
    root = chat.assistantTurnNode(turn)[0];
    const fragments = nodes(root, 'mp-chat-coalesced-result');
    assert.equal(
      nodes(fragments[0], 'mp-chat-diff-copy')[0].getAttribute(
        'data-mp-chat-copy',
      ),
      'value=1\nretained\n',
    );
    assert.equal(
      nodes(fragments[1], 'mp-chat-diff-copy')[0].getAttribute(
        'data-mp-chat-copy',
      ),
      'value=2\nretained\n',
    );
  } finally {
    await session.endTurn('completed');
    await rm(workspace, {recursive: true, force: true});
  }
});

test('actual live renderer keeps its root and expansion while file calls coalesce and finish', () => {
  const source = fs.readFileSync('tests/chat_live_turn_test.js', 'utf8');
  const ast = ts.createSourceFile(
    'fixture.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const fixture = ast.statements.find(ts.isClassDeclaration)!.getText(ast);
  const script = `
    const assert = require('node:assert/strict');
    ${fixture}
    TestNode.prototype.hasAttribute = function(key) {return Object.hasOwn(this.attrs, key)};
    global.HTMLElement = TestNode;
    global.document = {
      documentElement: {lang:'en', dataset:{}},
      createElement: tag => new TestNode(tag),
      createElementNS: (_ns, tag) => new TestNode(tag),
      createTextNode: value => new TestNode('', value),
    };
    const chat = require('./electron/renderer/chat_view');
    const host = new TestNode('div');
    const live = chat.createLiveTurn(host, 'stream#0');
    const first = ${JSON.stringify(call('a'))};
    const second = ${JSON.stringify(call('b'))};
    live.update({trajectory:[first]});
    const group = host.querySelector('.mp-chat-tool-group');
    const id = host.querySelector('.mp-chat-tool-group-header').getAttribute('data-group-id');
    group.setAttribute('open', '');
    chat.expansion.setGroup(id, true);
    live.update({trajectory:[first, {...second,result:undefined,state:'running'}]});
    assert.equal(host.querySelector('.mp-chat-tool-group'), group);
    assert.equal(group.getAttribute('data-single'), 'true');
    assert.equal(group.getAttribute('open'), '');
    assert.equal(host.querySelectorAll('.mp-chat-tool').length, 1);
    assert.equal(host.querySelector('.mp-chat-tool').getAttribute('data-state'), 'running');
    live.update({trajectory:[first,second]});
    assert.equal(host.querySelector('.mp-chat-tool-group'), group);
    assert.equal(host.querySelectorAll('.mp-chat-coalesced-result').length, 2);
    assert.equal(host.querySelector('.mp-chat-tool').getAttribute('data-state'), 'ok');
    live.finish({trajectory:[first,second]});
    assert.equal(host.querySelector('.mp-chat-tool-group').getAttribute('open'), '');
    assert.equal(host.querySelectorAll('.mp-chat-tool').length, 1);
    assert.equal(host.querySelectorAll('.mp-chat-coalesced-result').length, 2);
    assert.equal(host.querySelectorAll('.mp-chat-files').length, 0);
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
