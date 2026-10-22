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
  const delays: number[] = [];
  const cancelled = new Set<number>();
  const listeners = new Map<string, (event: unknown) => void>();
  let feedback = '';
  let currentIcon: any;
  const glyph = button.children.find(
    (child: any) =>
      child?.getAttribute?.('class') === 'mp-chat-diff-copy-glyph',
  );
  Object.assign(button, {
    closest: (selector: string) =>
      ['[data-mp-chat-act]', '.mp-chat-diff-copy'].includes(selector)
        ? button
        : null,
    querySelector: (selector: string) =>
      selector === '.mp-chat-diff-copy-glyph' ? glyph : currentIcon,
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
    COPY_RESET_TIMERS: new WeakMap(),
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
    lt: (key: string) =>
      key === 'chat.copy_failed'
        ? 'Copy failure'
        : key === 'chat.copied'
          ? 'Copied'
          : 'Copy',
    window: {
      setTimeout: (callback: () => void, delay: number) => {
        const id = timers.length + 1;
        delays.push(delay);
        timers.push(() => {
          if (!cancelled.has(id)) {
            callback();
          }
        });
        return id;
      },
      clearTimeout: (id: number) => cancelled.add(id),
    },
  });
  vm.runInContext(code, context);
  context.bindDelegation(host);
  listeners.get('click')!({target: button});
  await new Promise(resolve => setImmediate(resolve));
  return {
    copied,
    timers,
    delays,
    get feedback() {
      return glyph
        ? glyph.getAttribute('data-glyph') === '\ue03b'
          ? 'check'
          : 'copy'
        : feedback;
    },
    async fire() {
      listeners.get('click')!({target: button});
      await new Promise(resolve => setImmediate(resolve));
    },
    event(type: string, fields: Record<string, unknown> = {}) {
      let prevented = false;
      listeners.get(type)?.({
        target: button,
        preventDefault: () => {
          prevented = true;
        },
        ...fields,
      });
      return prevented;
    },
  };
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

test('inline diff copy uses the reference Copied label, 1200ms reset and glyph font', async () => {
  const button = buttons({
    path: 'file.txt',
    old_string: 'old',
    new_string: 'new',
  })[0];
  assert.ok(button.outerHTML.includes('mp-chat-diff-copy-glyph'));
  const result = await clickCopy(button);
  assert.equal(button.getAttribute('aria-label'), 'Copied');
  assert.deepEqual(result.delays, [1200]);
  result.timers[0]();
  assert.equal(button.getAttribute('aria-label'), 'Copy');
  assert.equal(result.feedback, 'copy');
});

test('a second diff copy restarts its reset instead of being reverted by the first timer', async () => {
  const button = buttons({
    path: 'file.txt',
    old_string: 'old',
    new_string: 'new',
  })[0];
  const result = await clickCopy(button);
  await result.fire();
  assert.deepEqual(result.copied, ['new', 'new']);
  result.timers[0]();
  assert.equal(result.feedback, 'check');
  result.timers[1]();
  assert.equal(result.feedback, 'copy');
});

test('diff copy preserves text focus on mouse down and suppresses held activation keys', async () => {
  const button = buttons({
    path: 'file.txt',
    old_string: 'old',
    new_string: 'new',
  })[0];
  const result = await clickCopy(button);
  assert.equal(result.event('mousedown'), true);
  assert.equal(result.event('keydown', {key: 'Enter', repeat: true}), true);
  assert.equal(result.event('keydown', {key: ' ', repeat: true}), true);
});
