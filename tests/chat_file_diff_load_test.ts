import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, rm, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {readFileDiffPresentation} from '../electron/file_diff_presentation';

const chat = require('../electron/renderer/chat_view');
const {parseProgressLine} = require('../electron/bridge_progress_lines');
const parse = (file: string) =>
  ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
const chatAst = parse('electron/renderer/chat_view.ts');
const functions: string[] = [];
const visit = (node: ts.Node): void => {
  if (
    ts.isFunctionDeclaration(node) &&
    [
      'loadFileDiff',
      'bindDelegation',
      'toggleDisclosure',
      'rememberGroupToggle',
    ].includes(node.name?.text || '')
  ) {
    functions.push(node.getText(chatAst));
  } else {
    ts.forEachChild(node, visit);
  }
};
visit(chatAst);
const mainAst = parse('electron/main.ts');
const registration = mainAst.statements.find(
  node =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(mainAst) === 'ipcMain.handle' &&
    node.expression.arguments[0].getText(mainAst) === "'files:diff-preview'",
) as ts.ExpressionStatement;
assert.ok(registration);
const handler = (
  registration.expression as ts.CallExpression
).arguments[1].getText(mainAst);
const preloadAst = parse('electron/preload.ts');
const expose = preloadAst.statements.find(
  node =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(preloadAst) ===
      'contextBridge.exposeInMainWorld' &&
    node.expression.arguments[0].getText(preloadAst) === "'magicPointer'",
) as ts.ExpressionStatement;
const api = (expose.expression as ts.CallExpression)
  .arguments[1] as ts.ObjectLiteralExpression;
const read = api.properties.find(
  node => node.name?.getText(preloadAst) === 'readFileDiff',
) as ts.PropertyAssignment;
const code = ts.transpileModule(
  [
    ...functions,
    `globalThis.handle = ${handler}; globalThis.read = ${read.initializer.getText(preloadAst)};`,
  ].join('\n'),
  {compilerOptions: {target: ts.ScriptTarget.ES2022}},
).outputText;

function find(node: any, predicate: (entry: any) => boolean): any {
  if (typeof node?.getAttribute !== 'function') {
    return undefined;
  }
  if (predicate(node)) {
    return node;
  }
  for (const child of node.children) {
    const found = find(child, predicate);
    if (found) {
      return found;
    }
  }
}

async function fixture(run: (f: any) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mp-lazy-diff-'));
  try {
    const reference = {
      kind: 'file_diff',
      beforePath: path.join(directory, 'before.bin'),
      afterPath: path.join(directory, 'after.txt'),
    };
    await writeFile(reference.beforePath, 'retained\nold text\n');
    await writeFile(reference.afterPath, 'retained\nnew text\n');
    const wire = Buffer.from(
      JSON.stringify({
        id: 'write',
        name: 'Write',
        args: JSON.stringify({path: 'file.txt', content: 'new text'}),
        result: JSON.stringify({
          absolutePath: path.join(directory, 'file.txt'),
        }),
        state: 'done',
        presentation: reference,
      }),
    ).toString('base64');
    const progress = parseProgressLine(`@@mp phase=tool_result b64=${wire}`);
    assert.ok(progress.fields.presentation);
    const rendered = chat.liveActivityNode(progress);
    const root = find(
      rendered,
      node => node.getAttribute('data-file-diff-reference') !== null,
    );
    assert.ok(root);
    const button = find(
      root,
      node => node.getAttribute('data-mp-chat-act') === 'load-file-diff',
    );
    assert.ok(button);
    root.isConnected = true;
    root.replaceChildren = (...children: any[]) => {
      root.children = children;
    };
    button.closest = (selector: string) =>
      selector === '[data-mp-chat-act]' ? button : root;
    const listeners = new Map<string, (event: unknown) => void>();
    let pending: Promise<unknown> | undefined;
    let count = 0;
    const sender = {};
    const context = vm.createContext({
      DOC: {},
      rememberGroupToggle: () => {},
      isDashboardSender: () => true,
      stageWindow: null,
      readFileDiffPresentation,
      deriveDiff: chat.__test.deriveDiff,
      diffPreviewNode: (diff: unknown, model: unknown) => ({
        childNodes: chat.__test.diffPreviewNode(diff, model).children,
      }),
      lt: (key: string) => key,
      ipcRenderer: {
        invoke: (channel: string, value: unknown) => {
          assert.equal(channel, 'files:diff-preview');
          return context.handle({sender}, value);
        },
      },
      window: {
        magicPointer: {
          readFileDiff: (value: unknown) => {
            count++;
            pending = context.read(value);
            return pending;
          },
        },
      },
    });
    vm.runInContext(code, context);
    context.bindDelegation({
      addEventListener: (name: string, callback: (event: unknown) => void) =>
        listeners.set(name, callback),
    });
    const fire = () => listeners.get('click')!({target: button});
    const settle = async () => {
      await pending;
      await new Promise(resolve => setImmediate(resolve));
    };
    await run({
      reference,
      root,
      button,
      context,
      sender,
      fire,
      settle,
      count: () => count,
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('real rendered action traverses preload and main before reading snapshots', () =>
  fixture(async f => {
    assert.equal(f.count(), 0);
    assert.doesNotMatch(f.root.outerHTML, /old text|\+ new text/);
    f.fire();
    assert.equal(f.button.disabled, true);
    await f.settle();
    assert.equal(f.count(), 1);
    assert.match(f.root.outerHTML, /data-kind="context"> {2}retained/);
    assert.ok(f.root.outerHTML.includes('- old text'));
    assert.ok(f.root.outerHTML.includes('+ new text'));
    assert.equal(f.root.getAttribute('data-file-diff-reference'), null);
  }));

test('a failed snapshot load exposes retry and the same action later loads real content', () =>
  fixture(async f => {
    await unlink(f.reference.afterPath);
    f.fire();
    await f.settle();
    assert.equal(f.button.disabled, false);
    assert.equal(f.button.textContent, 'chat.diff_retry');
    assert.ok(f.button.title.includes('ENOENT'));
    await writeFile(f.reference.afterPath, 'retained\nretried content\n');
    f.fire();
    await f.settle();
    assert.equal(f.count(), 2);
    assert.ok(f.root.outerHTML.includes('+ retried content'));
  }));

test('duplicate loads coalesce and a detached preview is never replaced', () =>
  fixture(async f => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const original = f.context.read;
    f.context.read = async (reference: unknown) => {
      await gate;
      return original(reference);
    };
    f.fire();
    f.fire();
    assert.equal(f.count(), 1);
    f.root.isConnected = false;
    release();
    await f.settle();
    assert.ok(f.root.getAttribute('data-file-diff-reference'));
    assert.doesNotMatch(f.root.outerHTML, /\+ new text/);
  }));

test('a keyboard load moves focus to its real rendered code group', () =>
  fixture(async f => {
    let focused = 0;
    f.context.DOC.activeElement = f.button;
    f.root.querySelector = () => {
      const code = find(f.root, node => node.getAttribute('tabindex') === '0');
      assert.ok(code);
      code.focus = (options: any) => {
        assert.equal(options.preventScroll, true);
        focused++;
      };
      return code;
    };
    f.fire();
    await f.settle();
    assert.equal(focused, 1);
  }));

test('opening an expanded group loads its preview but skips closed nested rows', () =>
  fixture(async f => {
    let expanded = false;
    const originalClosest = f.button.closest;
    f.button.closest = (selector: string) =>
      selector === '.mp-chat-disclosure'
        ? {getAttribute: () => (expanded ? 'true' : 'false')}
        : originalClosest(selector);
    const target = {
      classList: {contains: () => true},
      querySelector: () => ({getAttribute: () => null}),
      querySelectorAll: () => [f.button],
      hasAttribute: () => true,
    };
    f.context.rememberGroupToggle({target});
    assert.equal(f.count(), 0);
    expanded = true;
    f.context.rememberGroupToggle({target});
    await f.settle();
    assert.equal(f.count(), 1);
  }));

test('a completed load does not steal focus after the user moves elsewhere', () =>
  fixture(async f => {
    f.context.DOC.activeElement = f.button;
    let focused = 0;
    f.root.querySelector = () => ({
      focus: () => {
        focused++;
      },
    });
    f.fire();
    f.context.DOC.activeElement = {};
    await f.settle();
    assert.equal(focused, 0);
  }));

test('the same real loader works for the Stage window sender', () =>
  fixture(async f => {
    f.context.isDashboardSender = () => false;
    f.context.stageWindow = {webContents: f.sender, isDestroyed: () => false};
    f.fire();
    await f.settle();
    assert.ok(f.root.outerHTML.includes('- old text'));
    assert.ok(f.root.outerHTML.includes('+ new text'));
  }));
