import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const chat = require('../electron/renderer/chat_view');
const locale = require('../electron/renderer/locale');
function find(root: any, predicate: (node: any) => boolean): any {
  if (typeof root?.getAttribute !== 'function') return undefined;
  if (predicate(root)) return root;
  for (const node of root.children) {
    const found = find(node, predicate);
    if (found) return found;
  }
}
function render(count: number, turnIndex = 0) {
  const root = chat.assistantTurnNode({
    conversationId: 'file-expansion',
    turnIndex,
    answer: 'Saved.',
    trajectory: [
      {kind: 'tool', name: 'Read', text: '{}', result: 'Read context.'},
      ...Array.from({length: count}, (_, i) => ({
        kind: 'tool',
        name: 'Write',
        callId: `write-${i}`,
        text: JSON.stringify({
          path: `folder/file-${i}.txt`,
          content: `actual ${i}`,
        }),
        result: JSON.stringify({
          path: `folder/file-${i}.txt`,
          absolutePath: `D:/retained/folder/file-${i}.txt`,
          created: true,
        }),
      })),
    ],
  })[0];
  const card = find(
    root,
    node => node.getAttribute('class') === 'mp-chat-files',
  );
  const more = find(
    card,
    node => node.getAttribute('class') === 'mp-chat-files-more',
  );
  return {
    card,
    more,
    button: find(
      more,
      node => node.getAttribute('data-mp-chat-act') === 'toggle-files',
    ),
    rest: find(
      more,
      node => node.getAttribute('class') === 'mp-chat-files-more-list',
    ),
  };
}
function click(f: ReturnType<typeof render>) {
  assert.ok(f.button, 'real rendered expansion action');
  const file = 'electron/renderer/chat_view.ts';
  const ast = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions: string[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      ['bindDelegation', 'rememberExpansion'].includes(node.name?.text || '')
    ) {
      functions.push(node.getText(ast));
    } else ts.forEachChild(node, walk);
  };
  walk(ast);
  const listeners = new Map<string, (event: any) => void>();
  f.button.closest = (selector: string) =>
    selector === '[data-mp-chat-act]' ? f.button : f.more;
  f.more.querySelector = (selector: string) =>
    find(f.more, node =>
      node.getAttribute('class')?.split(' ').includes(selector.slice(1)),
    );
  const label = f.more.querySelector('.mp-chat-files-more-label');
  Object.defineProperty(label, 'textContent', {
    configurable: true,
    get: () => label.children.join(''),
    set: (text: string) => {
      label.children = [text];
    },
  });
  const context = vm.createContext({
    DOC: {
      dispatchEvent: () =>
        assert.fail('expanding files must not open a file or issue IPC'),
    },
    rememberGroupToggle: () => {},
    lt: locale.studioT,
    ROW_EXPANSION: {
      set: (key: string, open: boolean) => chat.expansion.setRow(key, open),
    },
  });
  vm.runInContext(
    ts.transpileModule(functions.join('\n'), {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    context,
  );
  context.bindDelegation({
    addEventListener: (name: string, fn: (event: any) => void) =>
      listeners.set(name, fn),
  });
  listeners.get('click')!({target: f.button});
}

test('up to three real files are immediately visible without an overflow action', () => {
  chat.expansion.clear();
  for (const count of [1, 2, 3]) {
    const f = render(count);
    assert.equal(f.more, undefined);
    for (let i = 0; i < count; i++) {
      assert.ok(
        f.card.outerHTML.includes(`data-file-path="folder/file-${i}.txt"`),
      );
    }
  }
});

test('real delegated action expands and collapses remaining files with the control after the rows', () => {
  chat.expansion.clear();
  const f = render(6);
  assert.ok(f.button);
  assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  assert.equal(f.rest.getAttribute('hidden'), 'true');
  assert.ok(f.button.outerHTML.includes('Show 3 more'));
  assert.ok(
    f.more.children.indexOf(f.rest) < f.more.children.indexOf(f.button),
  );
  click(f);
  assert.equal(f.rest.getAttribute('hidden'), null);
  assert.equal(f.button.getAttribute('aria-expanded'), 'true');
  assert.ok(f.button.outerHTML.includes('Show less'));
  assert.ok(
    f.rest.outerHTML.includes(
      'data-file-absolute-path="D:/retained/folder/file-5.txt"',
    ),
  );
  click(f);
  assert.equal(f.rest.getAttribute('hidden'), 'true');
  assert.equal(f.button.getAttribute('aria-expanded'), 'false');
  assert.ok(f.button.outerHTML.includes('Show 3 more'));
});

test('expansion survives refreshed file results and stays isolated to its turn', () => {
  chat.expansion.clear();
  click(render(5));
  const refreshed = render(6);
  assert.equal(refreshed.rest.getAttribute('hidden'), null);
  assert.equal(refreshed.button.getAttribute('aria-expanded'), 'true');
  assert.ok(refreshed.button.outerHTML.includes('Show less'));
  const other = render(6, 1);
  assert.equal(other.rest.getAttribute('hidden'), 'true');
  assert.equal(other.button.getAttribute('aria-expanded'), 'false');
});
