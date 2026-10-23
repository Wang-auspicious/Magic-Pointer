import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {buildSync} from 'esbuild';
import os from 'node:os';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';
import {registerArtifactTools} from '../electron/runtime/artifacts';
import {RuntimeActivitySink} from '../electron/runtime/agent_activity';
import {createConversationStore} from '../electron/conversation_store';

const chat = require('../electron/renderer/chat_view');
const label = (calls: any[]) => chat.__test.toolGroupLabel(calls);
let id = 0;
function call(name: string, path?: string, result: any = {text: 'done'}) {
  return {
    name,
    argsRaw: JSON.stringify(path ? {path} : {}),
    callId: String(++id),
    result,
  };
}
function failed(name: string, path?: string) {
  return call(name, path, {text: 'Disk full', isError: true});
}

test('one file is named once and combines verbs in their original observed order', () => {
  assert.equal(
    label([
      call('Read', 'src/main.ts'),
      call('Edit', 'src/main.ts'),
      call('Edit', 'src/main.ts'),
    ]),
    'Read and edited main.ts',
  );
  assert.equal(
    label([
      call('Read', 'a.ts'),
      call('Read', 'a.ts'),
      call('Read', 'b.ts'),
      call('Bash'),
    ]),
    'Read 2 files, ran a command',
  );
  assert.equal(
    label([call('Bash'), call('Read', 'a.ts')]),
    'Ran a command, read a.ts',
  );
});

test('supported aliases and ordinary Windows file paths retain one filename', () => {
  assert.equal(
    label([call('Read', 'client\\index.ts'), call('Edit', 'client/index.ts')]),
    'Read and edited index.ts',
  );
  assert.equal(
    label([
      call('read_file', 'src/main.ts'),
      call('write_file', 'src/main.ts', {
        text: JSON.stringify({created: false}),
      }),
      call('edit_file', 'src/main.ts'),
    ]),
    'Read and edited main.ts',
  );
  assert.equal(
    label([
      call('Read', 'D:\\work\\main.ts'),
      call('Edit', 'D:\\work\\main.ts'),
    ]),
    'Read and edited main.ts',
  );
  assert.equal(
    label([
      call('Read', 'a.ts'),
      failed('Edit', 'a.ts'),
      call('NotebookEdit', 'a.ts'),
    ]),
    'Read and edited a.ts',
  );
});

test('a file outcome follows retries without inflating failures or treating a pending retry as failed', () => {
  assert.equal(
    label([failed('Edit', 'a.ts'), call('Edit', 'a.ts'), call('Bash')]),
    'Edited a.ts, ran a command',
  );
  const pending = call('Edit', 'a.ts');
  pending.result = undefined;
  assert.equal(
    label([failed('Edit', 'a.ts'), pending, call('Bash')]),
    'Edited a.ts, ran a command',
  );
  assert.equal(
    label([call('Edit', 'a.ts'), failed('Edit', 'a.ts'), call('Bash')]),
    'Edited a.ts (1 failed), ran a command',
  );
  assert.equal(
    label([
      call('Bash', undefined, {text: 'permission_denied', isError: true}),
      call('Read', 'a.ts'),
    ]),
    'Ran a command (1 blocked), read a.ts',
  );
});

test('Write update is an edit and the first successful creation kind stays stable for that file', () => {
  const write = (created: boolean) =>
    call('Write', 'a.ts', {text: JSON.stringify({created})});
  assert.equal(
    label([write(false), call('Read', 'a.ts')]),
    'Edited and read a.ts',
  );
  assert.equal(
    label([write(true), write(false), call('Bash')]),
    'Created a.ts, ran a command',
  );
  assert.equal(
    label([failed('Write', 'a.ts'), write(false), call('Bash')]),
    'Edited a.ts, ran a command',
  );
});

test('four groups remain visible and five groups fold by remaining action count', () => {
  const prefix = () => [
    call('Bash'),
    call('Read', 'a.ts'),
    call('Grep'),
    call('Glob'),
  ];
  assert.equal(
    label(prefix()),
    'Ran a command, read a.ts, searched code, found files',
  );
  assert.equal(
    label([...prefix(), call('Glob'), call('Glob'), call('WebFetch')]),
    'Ran a command, read a.ts, searched code, and 4 more actions',
  );
});

test('folded remaining actions keep their failed and blocked counts visible', () => {
  const blocked = call('WebFetch', undefined, {
    text: 'permission_denied',
    isError: true,
  });
  assert.equal(
    label([
      call('Bash'),
      call('Read', 'a.ts'),
      call('Grep'),
      call('Glob'),
      failed('Glob'),
      call('Glob'),
      blocked,
    ]),
    'Ran a command, read a.ts, searched code, and 4 more actions (1 failed, 1 blocked)',
  );
});

test('non-file calls keep their actual invocation count and unknown tools use the original fallback', () => {
  assert.equal(label([call('Bash'), call('Bash')]), 'Ran 2 commands');
  assert.equal(label([call('Frobnicate'), call('Frobnicate')]), 'Used 2 tools');
  const stopped = call('Edit', 'a.ts', {text: 'Stopped', interrupted: true});
  assert.equal(
    label([failed('Edit', 'a.ts'), stopped]),
    'Edited a.ts (1 failed)',
  );
});

test('Artifact reads and writes of one actual identifier become one updated artifact', () => {
  const artifact = (name: string, artifactId: string) => ({
    ...call(name),
    argsRaw: JSON.stringify({artifact_id: artifactId}),
  });
  assert.equal(
    label([
      artifact('Artifact.read', 'draft'),
      artifact('Artifact.update', 'draft'),
    ]),
    'Updated an artifact',
  );
  assert.equal(
    label([
      artifact('Artifact.read', 'draft'),
      artifact('Artifact.update', 'other'),
    ]),
    'Read an artifact, updated an artifact',
  );
});

function nodes(root: any, name: string): any[] {
  if (typeof root?.getAttribute !== 'function') return [];
  return [
    ...(root.getAttribute('class')?.split(' ').includes(name) ? [root] : []),
    ...root.children.flatMap((child: any) => nodes(child, name)),
  ];
}

test('actual mixed header renders structured filename navigation and honest error phrases', () => {
  const records = (calls: any[]) =>
    calls.map(call => ({
      kind: 'tool',
      name: call.name,
      callId: call.callId,
      text: call.argsRaw,
      result: call.result?.text,
      isError: call.result?.isError,
    }));
  const render = (calls: any[]) =>
    chat.assistantTurnNode({
      conversationId: 'summary',
      turnIndex: 0,
      trajectory: records(calls),
      request: {executionWorkspaceRoot: 'D:/work'},
      answer: 'Saved.',
    })[0];
  const root = render([
    call('Read', 'src/main.ts'),
    call('Edit', 'src/main.ts'),
  ]);
  const file = nodes(root, 'mp-chat-group-file')[0];
  assert.ok(file);
  assert.equal(file.getAttribute('data-mp-chat-act'), 'open-file');
  assert.equal(file.getAttribute('data-file-path'), 'src/main.ts');
  assert.equal(
    file.getAttribute('data-file-absolute-path'),
    'D:/work/src/main.ts',
  );
  const failedRoot = render([failed('Edit', 'a.ts'), call('Bash')]);
  const header = nodes(failedRoot, 'mp-chat-tool-group-title')[0];
  assert.equal(
    nodes(header, 'mp-chat-group-phrase')[0].getAttribute('data-error'),
    'true',
  );
  assert.equal(nodes(header, 'mp-chat-group-file').length, 0);
});

test('JSON file contents are not mistaken for a Read receipt or used as a different open target', () => {
  const root = chat.assistantTurnNode({
    trajectory: [
      {kind: 'tool', name: 'Bash', callId: 'shell', text: '{}', result: 'done'},
      {
        kind: 'tool',
        name: 'Read',
        callId: 'json-read',
        text: JSON.stringify({path: 'config.json'}),
        result: JSON.stringify({absolutePath: 'D:/unrelated/other.json'}),
      },
    ],
    request: {executionWorkspaceRoot: 'D:/work'},
    answer: 'Read.',
  })[0];
  assert.equal(
    nodes(root, 'mp-chat-group-file')[0].getAttribute(
      'data-file-absolute-path',
    ),
    'D:/work/config.json',
  );
});

test('only the final file phrase in a settled summary becomes a file opener', () => {
  const render = (calls: any[]) =>
    chat.assistantTurnNode({
      trajectory: calls.map(call => ({
        kind: 'tool',
        name: call.name,
        text: call.argsRaw,
        callId: call.callId,
        result: call.result?.text,
        state: call.result === undefined ? 'running' : 'done',
      })),
      request: {executionWorkspaceRoot: 'D:/work'},
      answer: 'Read.',
    })[0];
  assert.equal(
    nodes(render([call('Read', 'a.ts'), call('Bash')]), 'mp-chat-group-file')
      .length,
    0,
  );
  assert.equal(
    nodes(render([call('Bash'), call('Read', 'a.ts')]), 'mp-chat-group-file')
      .length,
    1,
  );
  const pending = call('Read', 'a.ts');
  pending.result = undefined;
  assert.equal(
    nodes(render([call('Bash'), pending]), 'mp-chat-group-file').length,
    0,
  );
});

test('a busy mixed group shows its current running tool instead of its counted settled summary', () => {
  const root = chat.assistantTurnNode({
    trajectory: [
      {kind: 'tool', name: 'Read', callId: 'first', text: JSON.stringify({path: 'a.ts'}), state: 'running'},
      {kind: 'tool', name: 'Read', callId: 'second', text: JSON.stringify({path: 'b.ts'}), state: 'running'},
    ],
  })[0];
  const title = nodes(root, 'mp-chat-tool-group-title')[0];
  assert.equal(nodes(title, 'mp-shimmer-clone')[0].children.join(''), 'Reading a.ts');
  assert.equal(nodes(title, 'mp-chat-group-file').length, 0);
});

test('the real browser bundle exposes the summary API and both surfaces load it before ChatView', () => {
  const source = fs.readFileSync('scripts/build-electron.ts', 'utf8');
  const ast = ts.createSourceFile(
    'build.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const entry = ast.statements.find(
    node =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'buildSync' &&
      node.getText(ast).includes("'chat_tool_summary.ts'"),
  );
  assert.ok(entry);
  let output = '';
  vm.runInNewContext(entry.getText(ast), {
    path,
    sourceRoot: path.resolve('electron'),
    outputRoot: path.resolve('data/runtime/tool-group-summary-43/not-written'),
    buildSync: (options: any) => {
      output = buildSync({...options, write: false, sourcemap: false})
        .outputFiles![0].text;
    },
  });
  const browser = vm.createContext({});
  vm.runInContext(output, browser);
  assert.equal(
    vm.runInContext(
      'ChatToolSummary.summaryText(ChatToolSummary.summarizeToolCalls([{category:"read",key:"a.ts",filePath:"a.ts",outcome:"succeeded",canLinkFile:true}]))',
      browser,
    ),
    'Read a.ts',
  );
  for (const surface of ['studio', 'stage']) {
    const html = fs.readFileSync(
      'electron/renderer/' + surface + '.html',
      'utf8',
    );
    const position = html.indexOf('src="chat_tool_summary.js"');
    assert.ok(position > 0 && position < html.indexOf('src="chat_view.js'));
  }
});

test('actual Artifact creation, reading and updating persist as one updated artifact summary', async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'mp-summary-artifact-'),
  );
  const session = await EventSession.open(root, 'summary-artifact');
  try {
    const registry = new ToolRegistry();
    registerArtifactTools(registry, session);
    const sink = new RuntimeActivitySink(() => {});
    let seq = 0;
    const run = async (name: string, args: Record<string, unknown>) => {
      const result = await registry.execute({
        id: String(++seq),
        name,
        arguments: args,
      });
      assert.equal(result.is_error, false, result.error_message);
      sink.onEvent({kind: 'tool_call_finished', result});
      return result.value as any;
    };
    const created = await run('Artifact.create', {
      title: 'Draft',
      kind: 'markdown',
      content: 'first',
    });
    const read = await run('Artifact.read', {artifact_id: created.artifactId});
    assert.equal(read.content, 'first');
    const updated = await run('Artifact.update', {
      artifact_id: created.artifactId,
      expected_revision: read.revision,
      content: 'second',
    });
    assert.equal(updated.content, 'second');
    assert.equal(updated.revision, read.revision + 1);
    const store = createConversationStore({baseDir: root});
    const saved = store.appendTurn({
      newConversation: true,
      question: 'Update draft',
      answer: 'Done.',
      trajectory: sink.trajectory,
    });
    store.flush();
    const turn = createConversationStore({baseDir: root}).get(saved.id)!
      .turns[0];
    const title = nodes(
      chat.assistantTurnNode(turn)[0],
      'mp-chat-tool-group-title',
    )[0];
    const text = (node: any): string =>
      typeof node === 'string' ? node : node.children.map(text).join('');
    assert.equal(text(title), 'Updated an artifact');
    assert.equal(
      (await run('Artifact.read', {artifact_id: created.artifactId})).content,
      'second',
    );
  } finally {
    await fs.promises.rm(root, {recursive: true, force: true});
  }
});
