import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';
import {spawnSync} from 'node:child_process';

const chat = require('../electron/renderer/chat_view');
function nodes(root: any, name: string): any[] {
  if (typeof root?.getAttribute !== 'function') return [];
  return [
    ...(root.getAttribute('class')?.split(' ').includes(name) ? [root] : []),
    ...root.children.flatMap((child: any) => nodes(child, name)),
  ];
}
function turn() {
  return {
    conversationId: 'original',
    turnIndex: 2,
    answer: 'Saved.',
    trajectory: [
      {kind: 'tool', name: 'Read', text: '{}', result: 'Context'},
      ...['src/main.ts', 'notes.txt'].map(path => ({
        kind: 'tool',
        name: 'Write',
        text: JSON.stringify({path, content: 'saved'}),
        result: JSON.stringify({
          path,
          absolutePath: `D:/original/${path}`,
          created: false,
        }),
      })),
    ],
  };
}
test('writable file footer exposes the original Undo action with source conversation and turn identity', () => {
  const root = chat.assistantTurnNode(turn(), undefined, {
    undoFileChanges: true,
  })[0];
  const button = nodes(root, 'mp-chat-files-undo')[0];
  assert.ok(button);
  assert.equal(button.children.join(''), 'Undo');
  assert.equal(button.getAttribute('data-mp-chat-act'), 'undo-files');
  assert.equal(button.getAttribute('data-undo-conversation'), 'original');
  assert.equal(button.getAttribute('data-undo-turn'), '2');
  assert.equal(
    button.getAttribute('title'),
    'Ask Magic Pointer to undo this turn’s file changes',
  );
});
test('Undo is absent for readonly, running, awaiting, artifact-only and artifact-page states', () => {
  const base = turn();
  for (const [input, options] of [
    [base, {}],
    [base, {undoFileChanges: false}],
    [{...base, running: true}, {undoFileChanges: true}],
    [{...base, pendingInput: {kind: 'ask'}}, {undoFileChanges: true}],
    [
      {...base, artifacts: [{artifactId: 'artifact', title: 'Draft'}]},
      {undoFileChanges: true},
    ],
    [
      {...base, trajectory: [], artifacts: [{artifactId: 'artifact'}]},
      {undoFileChanges: true},
    ],
  ]) {
    const root = chat.assistantTurnNode(input, undefined, options)[0];
    assert.equal(nodes(root, 'mp-chat-files-undo').length, 0);
  }
});
test('Undo prompt uses the clicked turn actual unique file list and matches the reference follow-up wording', () => {
  const base = turn();
  assert.equal(
    chat.fileUndoQuestion(base),
    'Undo the changes you made to these 2 files in your last turn and restore them to their previous state:\n- `src/main.ts`\n- `notes.txt`',
  );
  assert.equal(
    chat.fileUndoQuestion({...base, trajectory: base.trajectory.slice(0, 2)}),
    'Undo the changes you made to `src/main.ts` in your last turn and restore it to its previous state.',
  );
  assert.equal(chat.fileUndoQuestion({...base, trajectory: []}), undefined);
});

test('Undo delegation sends once and exposes a failed request so the action can retry', () => {
  const handlers = new Map<string, (event: any) => void>();
  const sent: any[] = [];
  const errors: any[] = [];
  const attrs: Record<string, string> = {
    'data-mp-chat-act': 'undo-files',
    'data-undo-conversation': 'original',
    'data-undo-turn': '2',
  };
  const card = {
    querySelector: () => null,
    appendChild: (node: any) => errors.push(node),
  };
  const button: any = {
    dataset: {},
    isConnected: true,
    getAttribute: (name: string) => attrs[name],
    setAttribute: (name: string, value: string) => (attrs[name] = value),
    closest: () => card,
  };
  const context = vm.createContext({
    DOC: {
      dispatchEvent: (event: any) => sent.push(event),
      createElement: () => ({setAttribute() {}}),
    },
    CustomEvent: class {
      detail: any;
      constructor(
        readonly type: string,
        options: any,
      ) {
        this.detail = options.detail;
      }
    },
    host: {
      addEventListener: (name: string, listener: any) =>
        handlers.set(name, listener),
    },
    rememberGroupToggle() {},
    lt: (name: string) => name,
  });
  const source = fs.readFileSync('electron/renderer/chat_view.ts', 'utf8');
  const ast = ts.createSourceFile(
    'chat_view.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let binding: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'bindDelegation')
      binding = node;
    else ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(binding);
  vm.runInContext(
    ts.transpileModule(binding.getText(ast) + '\nbindDelegation(host);', {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    context,
  );
  let prevented = 0;
  const click = () =>
    handlers.get('click')!({
      target: {closest: () => button},
      preventDefault() {
        prevented++;
      },
      stopPropagation() {},
    });
  click();
  click();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'mp:undo-file-changes');
  assert.equal(sent[0].detail.conversationId, 'original');
  assert.equal(sent[0].detail.turnIndex, 2);
  assert.equal(button.disabled, true);
  sent[0].detail.respond({ok: false, error: 'Actual send failure'});
  assert.equal(button.disabled, false);
  assert.equal(errors[0].textContent, 'Actual send failure');
  click();
  assert.equal(sent.length, 2);
  sent[1].detail.respond({ok: true});
  assert.equal(button.disabled, false);
  assert.equal(prevented, 3);
});

test('actual conversation rendering updates Undo availability when the session starts or stops running', () => {
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
    global.HTMLElement=TestNode;
    global.document={documentElement:{lang:'en',dataset:{}},createElement:tag=>new TestNode(tag),createElementNS:(_ns,tag)=>new TestNode(tag),createTextNode:value=>new TestNode('',value)};
    const chat=require('./electron/renderer/chat_view');
    const host=new TestNode('div'), view=chat.createConversationView(host);
    const record={id:'original',agentSessionId:'agent-original',turns:[${JSON.stringify(turn())}]};
    view.update(record);
    assert.equal(host.querySelectorAll('.mp-chat-files-undo').length,1);
    view.update({...record,hasPendingWork:true});
    assert.equal(host.querySelectorAll('.mp-chat-files-undo').length,0);
    view.update(record);
    assert.equal(host.querySelectorAll('.mp-chat-files-undo').length,1);
    view.update({...record,agentSessionId:undefined});
    assert.equal(host.querySelectorAll('.mp-chat-files-undo').length,0);
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', script],
    {cwd: process.cwd(), encoding: 'utf8', timeout: 10000},
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
