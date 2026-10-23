import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';

const chat = require('../electron/renderer/chat_view');
function nodes(root: any, name: string): any[] {
  if (typeof root?.getAttribute !== 'function') return [];
  return [
    ...(root.getAttribute('class')?.split(' ').includes(name) ? [root] : []),
    ...root.children.flatMap((child: any) => nodes(child, name)),
  ];
}
function text(root: any): string {
  return typeof root === 'string' ? root : root.children.map(text).join('');
}

test('expanded thinking retains the full original text without invented length caps or Show more', () => {
  for (const reasoning of [
    'short',
    'one long paragraph '.repeat(120),
    'line\n'.repeat(100),
  ]) {
    for (const running of [true, false]) {
      const root = chat.thinkNode(reasoning, running, 'body');
      assert.equal(root.getAttribute('data-long'), null);
      assert.equal(nodes(root, 'mp-chat-think-more').length, 0);
      assert.equal(nodes(root, 'mp-chat-think-fade').length, 0);
      assert.equal(text(nodes(root, 'mp-chat-think-body')[0]), reasoning);
    }
  }
});

test('the actual live thinking body stays in place and settles with all streamed text visible', () => {
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
    const assert=require('node:assert/strict');
    ${fixture}
    global.HTMLElement=TestNode;
    global.document={documentElement:{lang:'en',dataset:{}},createElement:tag=>new TestNode(tag),createElementNS:(_ns,tag)=>new TestNode(tag),createTextNode:value=>new TestNode('',value)};
    const chat=require('./electron/renderer/chat_view');
    const host=new TestNode('div'),live=chat.createLiveTurn(host,'thinking#0');
    const original='Read actual sources.\\n'.repeat(90);
    live.update({thinking:original});
    const root=host.querySelector('.mp-chat-think'),body=host.querySelector('.mp-chat-think-body');
    root.setAttribute('data-open','true');
    live.update({thinking:original+'Last evidence.',answer:'Finished.'});
    assert.equal(host.querySelector('.mp-chat-think-body'),body);
    assert.equal(body.textContent,original+'Last evidence.');
    assert.equal(root.getAttribute('data-open'),'true');
    assert.equal(root.getAttribute('data-long'),null);
    assert.equal(root.querySelector('.mp-chat-think-more'),null);
    assert.equal(root.querySelector('.mp-chat-think-fade'),null);
    assert.equal(root.getAttribute('data-state'),'ok');
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', script],
    {cwd: process.cwd(), encoding: 'utf8', timeout: 10000},
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('thinking exposes a quote-copy action without duplicating the full body in a button attribute', () => {
  const root = chat.thinkNode(
    'Read the actual source.\n\nKeep every line.',
    false,
  );
  const copy = nodes(root, 'mp-chat-think-copy')[0];
  assert.ok(copy);
  assert.equal(copy.getAttribute('data-mp-chat-act'), 'copy-thinking');
  assert.equal(copy.getAttribute('aria-label'), 'Copy as quote');
  assert.equal(copy.getAttribute('data-mp-chat-copy'), null);
  assert.equal(
    nodes(copy, 'mp-chat-think-copy-glyph')[0].getAttribute('data-glyph'),
    '\ue056',
  );
});

async function copyThinking(
  reasoning: string,
  fail = false,
  write?: (value: string) => Promise<void>,
) {
  const root = chat.thinkNode(reasoning, false);
  const body = nodes(root, 'mp-chat-think-body')[0];
  const button = nodes(root, 'mp-chat-think-copy')[0];
  const glyph = nodes(button, 'mp-chat-think-copy-glyph')[0];
  const events = new Map<string, (event: any) => void>();
  const copied: string[] = [];
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  Object.defineProperty(body, 'textContent', {get: () => text(body)});
  root.querySelector = () => body;
  button.closest = (selector: string) =>
    selector === '.mp-chat-think'
      ? root
      : ['[data-mp-chat-act]', '.mp-chat-think-copy'].includes(selector)
        ? button
        : null;
  button.querySelector = (selector: string) =>
    selector === '.mp-chat-think-copy-glyph' ? glyph : null;
  const source = fs.readFileSync('electron/renderer/chat_view.ts', 'utf8');
  const ast = ts.createSourceFile(
    'chat_view.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const functions: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isFunctionDeclaration(node) &&
      [
        'bindDelegation',
        'copyToClipboard',
        'fallbackCopyText',
        'thinkingQuote',
      ].includes(node.name?.text || '')
    )
      functions.push(node.getText(ast));
    else ts.forEachChild(node, visit);
  }
  visit(ast);
  const context = vm.createContext({
    DOC: {},
    COPY_RESET_TIMERS: new WeakMap(),
    rememberGroupToggle() {},
    navigator: {
      clipboard: {
        writeText: async (value: string) => {
          copied.push(value);
          await write?.(value);
          if (fail) throw new Error('Clipboard unavailable');
        },
      },
    },
    document: {
      createElement: () => ({style: {}, select() {}}),
      body: {appendChild() {}, removeChild() {}},
      execCommand: () => false,
    },
    lt: (id: string) => require('../electron/renderer/locale').studioT(id),
    window: {
      setTimeout: (callback: () => void, delay: number) => {
        timers.push(callback);
        delays.push(delay);
        return timers.length;
      },
      clearTimeout() {},
    },
    host: {
      addEventListener: (name: string, listener: any) =>
        events.set(name, listener),
    },
  });
  vm.runInContext(
    ts.transpileModule(functions.join('\n') + '\nbindDelegation(host);', {
      compilerOptions: {target: ts.ScriptTarget.ES2022},
    }).outputText,
    context,
  );
  return {
    body,
    button,
    glyph,
    copied,
    timers,
    delays,
    async click() {
      events.get('click')!({target: button});
      await new Promise(resolve => setImmediate(resolve));
    },
    event(name: string, fields: any = {}) {
      let prevented = false;
      events.get(name)!({
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

test('the actual delegated clipboard action quotes the latest complete thinking body and preserves text selection', async () => {
  const value = 'first\r\n\r\nlast\u2028tail\r';
  const f = await copyThinking(value);
  f.body.appendChild('new evidence');
  assert.equal(f.event('mousedown'), true);
  assert.equal(f.event('keydown', {key: 'Enter', repeat: true}), true);
  assert.equal(f.copied.length, 0);
  await f.click();
  const current = value + 'new evidence';
  assert.deepEqual(f.copied, [
    `> **Thinking** (~${Math.round(current.length / 4)} tok)\n>\n> first\n>\n> last\n> tail\n> new evidence`,
  ]);
  assert.equal(f.glyph.getAttribute('data-glyph'), '\ue03b');
  assert.equal(f.button.getAttribute('aria-label'), 'Copied');
  assert.deepEqual(f.delays, [2000]);
  f.timers[0]();
  assert.equal(f.glyph.getAttribute('data-glyph'), '\ue056');
  assert.equal(f.button.getAttribute('aria-label'), 'Copy as quote');
});

test('the quote copy keeps every line while applying the original clipboard hook trailing trim', async () => {
  const f = await copyThinking('keep leading indent\n   ');
  await f.click();
  assert.deepEqual(f.copied, [
    '> **Thinking** (~6 tok)\n>\n> keep leading indent\n>',
  ]);
  assert.equal(
    chat.thinkNode('', true).outerHTML.includes('hidden="true"'),
    true,
  );
});

test('a failed thinking copy does not display success and resets to its original accessible label', async () => {
  const f = await copyThinking('actual reasoning', true);
  await f.click();
  assert.equal(f.glyph.getAttribute('data-glyph'), '\ue056');
  assert.equal(f.button.getAttribute('aria-label'), 'Copy failure');
  f.timers[0]();
  assert.equal(f.button.getAttribute('aria-label'), 'Copy as quote');
});

for (const latestFails of [false, true]) {
  test(`a late earlier clipboard result cannot replace the latest ${latestFails ? 'failed' : 'successful'} copy feedback`, async () => {
    const pending: Array<{
      resolve: () => void;
      reject: (error: Error) => void;
    }> = [];
    const f = await copyThinking(
      'first',
      false,
      () =>
        new Promise<void>((resolve, reject) => {
          pending.push({resolve, reject});
        }),
    );
    await f.click();
    f.body.appendChild(' updated');
    await f.click();
    assert.equal(pending.length, 2);
    if (latestFails) {
      pending[1].reject(new Error('Latest copy refused'));
    } else {
      pending[1].resolve();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      f.button.getAttribute('aria-label'),
      latestFails ? 'Copy failure' : 'Copied',
    );
    const timers = f.timers.length;
    if (latestFails) {
      pending[0].resolve();
    } else {
      pending[0].reject(new Error('Earlier copy refused'));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      f.button.getAttribute('aria-label'),
      latestFails ? 'Copy failure' : 'Copied',
    );
    assert.equal(
      f.glyph.getAttribute('data-glyph'),
      latestFails ? '\ue056' : '\ue03b',
    );
    assert.equal(f.timers.length, timers);
    f.timers.at(-1)!();
    assert.equal(f.button.getAttribute('aria-label'), 'Copy as quote');
  });
}
