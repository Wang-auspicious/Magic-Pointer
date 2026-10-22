import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const chat = require('../electron/renderer/chat_view');
const source = fs.readFileSync('electron/renderer/chat_view.ts', 'utf8');
const ast = ts.createSourceFile(
  'chat_view.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  'bindDelegation',
  'copyToClipboard',
  'fallbackCopyText',
]);
const functions: string[] = [];
const visit = (node: ts.Node): void => {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text || '')) {
    functions.push(node.getText(ast));
  } else {
    ts.forEachChild(node, visit);
  }
};
visit(ast);
assert.equal(functions.length, names.size);
const code = ts.transpileModule(functions.join('\n'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
}).outputText;

function buttons(args: Record<string, unknown>, name = 'Edit'): any[] {
  const root = chat.toolRowNode(chat.toolRowModel(name, JSON.stringify(args)));
  const found: any[] = [];
  const walk = (node: any): void => {
    if (typeof node?.getAttribute !== 'function') {
      return;
    }
    if (node.getAttribute('class')?.split(' ').includes('mp-chat-diff-copy')) {
      found.push(node);
    }
    node.children.forEach(walk);
  };
  walk(root);
  return found;
}

async function clickCopy(button: any, fail = false) {
  const copied: string[] = [];
  const timers: Array<() => void> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let feedback = '';
  let currentIcon: any;
  Object.assign(button, {
    closest: () => button,
    querySelector: () => currentIcon,
    appendChild: (icon: any) => {
      currentIcon = icon;
      feedback = icon.name;
    },
  });
  const host = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
  };
  const context = vm.createContext({
    DOC: {},
    rememberGroupToggle: () => {},
    navigator: {
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
          if (fail) {
            throw new Error('clipboard unavailable');
          }
        },
      },
    },
    document: {
      createElement: () => ({style: {}, select: () => {}}),
      body: {appendChild: () => {}, removeChild: () => {}},
      execCommand: () => false,
    },
    icon: (name: string) => ({
      name,
      remove: () => {
        currentIcon = undefined;
      },
    }),
    lt: (key: string) => (key === 'chat.copy_failed' ? 'Copy failure' : 'Copy'),
    window: {setTimeout: (callback: () => void) => timers.push(callback)},
  });
  vm.runInContext(code, context);
  context.bindDelegation(host);
  listeners.get('click')!({target: button});
  await new Promise(resolve => setImmediate(resolve));
  return {copied, timers, feedback};
}

test('diff copy uses exact replacement text and the real delegated action', async () => {
  const value = '  keep indent\r\n<new & quoted "text">\r\n';
  const actions = buttons({
    path: 'file.txt',
    old_string: 'old',
    new_string: value,
  });
  assert.equal(actions.length, 1);
  const result = await clickCopy(actions[0]);
  assert.deepEqual(result.copied, [value]);
  assert.equal(result.feedback, 'check');
  result.timers[0]();
  assert.equal(actions[0].getAttribute('aria-label'), 'Copy');
});

test('batch copies remain separate and a deletion copies removed content', async () => {
  const actions = buttons({
    path: 'file.txt',
    edits: [
      {old_string: 'first old', new_string: 'first new'},
      {old_string: 'removed\n', new_string: ''},
    ],
  });
  assert.equal(actions.length, 2);
  assert.deepEqual((await clickCopy(actions[0])).copied, ['first new']);
  assert.deepEqual((await clickCopy(actions[1])).copied, ['removed\n']);
});

test('copy rejection reports failure and returns to its initial label', async () => {
  const actions = buttons({
    path: 'file.txt',
    old_string: 'old',
    new_string: 'new',
  });
  assert.equal(actions.length, 1);
  const result = await clickCopy(actions[0], true);
  assert.equal(result.feedback, 'copy');
  assert.equal(actions[0].getAttribute('aria-label'), 'Copy failure');
  result.timers[0]();
  assert.equal(actions[0].getAttribute('aria-label'), 'Copy');
});

test('Write and costly previews copy full source rather than visible lines', async () => {
  const content = 'first\n' + '\n'.repeat(12000) + 'last\n';
  const writes = buttons({path: 'file.txt', content}, 'Write');
  assert.equal(writes.length, 1);
  assert.deepEqual((await clickCopy(writes[0])).copied, [content]);
  const lines = Array.from({length: 700}, (_, i) => `line ${i}\n`);
  const after = [...lines].reverse().join('');
  const edits = buttons({
    path: 'file.txt',
    old_string: lines.join(''),
    new_string: after,
  });
  assert.equal(edits.length, 1);
  assert.deepEqual((await clickCopy(edits[0])).copied, [after]);
});
