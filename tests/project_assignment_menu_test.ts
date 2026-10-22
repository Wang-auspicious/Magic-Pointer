import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createConversationStore} from '../electron/conversation_store';

function parse(file: string) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}
const studio = parse('electron/renderer/studio.ts');
const open = studio.statements.find(
  node =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === 'openProjectAssignment',
)!;
const build = studio.statements.find(
  node =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'buildSessionMenu',
)!;
const main = parse('electron/main.ts');
const registration = main.statements.find(
  node =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(main) === 'ipcMain.handle' &&
    node.expression.arguments[0].getText(main) ===
      "'conversations:set-project'",
) as ts.ExpressionStatement;
const handler = (registration.expression as ts.CallExpression).arguments[1];
const libraryCode = [
  'project_scope',
  'conversation_state',
  'studio_libraries',
].map(
  name =>
    ts.transpileModule(
      fs.readFileSync(`electron/renderer/${name}.ts`, 'utf8'),
      {compilerOptions: {target: ts.ScriptTarget.ES2022}},
    ).outputText,
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}

async function fixture(run: (f: any) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-project-menu-'));
  const store = createConversationStore({baseDir: directory});
  const source = store.appendTurn({
    newConversation: true,
    question: 'Move this task',
    answer: 'Saved',
  });
  const projectRoot = path.join(directory, 'target');
  fs.mkdirSync(projectRoot);
  const project = store.registerProject(projectRoot);
  let document: any;
  class Element {
    attrs: Record<string, string> = {};
    dataset: Record<string, string> = {};
    style = {};
    children: Element[] = [];
    parentElement: Element | null = null;
    listeners = new Map<string, Array<(event: any) => void>>();
    observers = new Set<() => void>();
    disabled = false;
    textContent = '';
    value = '';
    constructor(readonly tagName = 'div') {}
    get className() {
      return this.attrs.class || '';
    }
    set className(value: string) {
      this.attrs.class = value;
    }
    get hidden() {
      return this.attrs.hidden !== undefined;
    }
    set hidden(value: boolean) {
      if (value) {
        this.attrs.hidden = '';
      } else {
        delete this.attrs.hidden;
      }
      for (const callback of this.observers) {
        queueMicrotask(callback);
      }
    }
    get isConnected(): boolean {
      return this === document.body || Boolean(this.parentElement?.isConnected);
    }
    get offsetWidth() {
      return 180;
    }
    get offsetHeight() {
      return 80;
    }
    getBoundingClientRect() {
      return {left: 100, right: 280, top: 10, bottom: 34};
    }
    setAttribute(key: string, value: string) {
      this.attrs[key] = value;
      if (key.startsWith('data-')) {
        this.dataset[
          key
            .slice(5)
            .replace(/-([a-z])/g, (_: string, letter: string) =>
              letter.toUpperCase(),
            )
        ] = value;
      }
    }
    getAttribute(key: string) {
      if (key.startsWith('data-')) {
        return (
          this.dataset[
            key
              .slice(5)
              .replace(/-([a-z])/g, (_: string, letter: string) =>
                letter.toUpperCase(),
              )
          ] ?? null
        );
      }
      return this.attrs[key] ?? null;
    }
    removeAttribute(key: string) {
      delete this.attrs[key];
    }
    hasAttribute(key: string) {
      return this.getAttribute(key) !== null;
    }
    append(...children: Element[]) {
      for (const child of children) {
        child.remove();
        child.parentElement = this;
        this.children.push(child);
      }
    }
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter(
          node => node !== this,
        );
      }
      this.parentElement = null;
    }
    contains(node: Element | null): boolean {
      return node === this || this.children.some(child => child.contains(node));
    }
    matches(selector: string): boolean {
      if (selector.startsWith('.')) {
        return this.className.split(' ').includes(selector.slice(1));
      }
      const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (attribute) {
        return (
          this.hasAttribute(attribute[1]) &&
          (attribute[2] === undefined ||
            this.getAttribute(attribute[1]) === attribute[2])
        );
      }
      return this.tagName === selector;
    }
    closest(selector: string): Element | null {
      return selector.split(',').some(part => this.matches(part.trim()))
        ? this
        : this.parentElement?.closest(selector) || null;
    }
    querySelectorAll(selector: string): Element[] {
      return this.children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] || null;
    }
    set innerHTML(html: string) {
      this.children = [];
      const stack: Element[] = [this];
      for (const match of html.matchAll(/<\/(\w+)>|<(\w+)([^>]*)>|([^<]+)/g)) {
        if (match[1]) {
          stack.pop();
          continue;
        }
        if (match[4]) {
          stack.at(-1)!.textContent += match[4];
          continue;
        }
        const child = new Element(match[2]);
        for (const attr of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
          child.setAttribute(attr[1], attr[2] || '');
        }
        child.disabled = child.hasAttribute('disabled');
        stack.at(-1)!.append(child);
        if (child.tagName !== 'input') {
          stack.push(child);
        }
      }
    }
    addEventListener(
      type: string,
      callback: (event: any) => void,
      options?: {signal?: AbortSignal},
    ) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
      options?.signal?.addEventListener(
        'abort',
        () => this.removeEventListener(type, callback),
        {once: true},
      );
    }
    removeEventListener(type: string, callback: (event: any) => void) {
      this.listeners.set(
        type,
        (this.listeners.get(type) || []).filter(entry => entry !== callback),
      );
    }
    dispatch(type: string, fields: Record<string, unknown> = {}) {
      const event = {
        target: this,
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
        ...fields,
      };
      for (const callback of [...(this.listeners.get(type) || [])]) {
        callback(event);
      }
      return event;
    }
    focus() {
      document.activeElement = this;
    }
  }
  document = new Element('document');
  document.body = new Element('body');
  document.activeElement = document.body;
  document.createElement = (tag: string) => new Element(tag);
  class Observer {
    node?: Element;
    constructor(readonly callback: () => void) {}
    observe(node: Element) {
      this.node = node;
      node.observers.add(this.callback);
    }
    disconnect() {
      this.node?.observers.delete(this.callback);
    }
  }
  let changed = 0;
  let rerendered = 0;
  const activeProjects: unknown[][] = [];
  let reads: () => Promise<any> = async () => store.listProjects();
  const writes: string[] = [];
  const context = vm.createContext({
    document,
    MutationObserver: Observer,
    AbortController,
    closeProjectAssignment: null,
    projectAssignmentRequest: 0,
    closeGroupSubmenu: null,
    branchingConversations: new Set(),
    window: {innerWidth: 1200, innerHeight: 900},
    module: {exports: {}},
    localStorage: {getItem: () => null},
    CdsIcons: {html: () => ''},
    studioT: (key: string) => key,
    esc: (value: unknown) => String(value),
    activeConversationId: source.id,
    setActiveProject: (...args: unknown[]) => activeProjects.push(args),
    renderSidebar: async () => {
      rerendered++;
    },
    isDashboardSender: () => true,
    conversations: () => store,
    stageLiveTurns: new Map(),
    activeConversations: new Map(),
    notifyConversationChanged: () => {
      changed++;
    },
    Data: {
      projects: () => reads(),
      conversation: async () => store.get(source.id),
      setConversationProject: async (id: string, root: string) => {
        writes.push(root);
        return context.mainHandler({}, {id, root});
      },
    },
  });
  for (const code of libraryCode) {
    vm.runInContext(code, context);
  }
  context.studioLibraries = context.module.exports;
  vm.runInContext(
    ts.transpileModule(
      `${build.getText(studio)}\n${open.getText(studio)}\nglobalThis.mainHandler = ${handler.getText(main)};`,
      {compilerOptions: {target: ts.ScriptTarget.ES2022}},
    ).outputText,
    context,
  );
  const parent = context.buildSessionMenu(source);
  parent.hidden = false;
  const anchor = parent.querySelector('[data-session-action="project"]')!;
  document.body.append(parent);
  const panel = () => document.body.querySelector('.mp-project-assignment');
  const click = (selector: string) => {
    const popover = panel()!;
    const button = popover.querySelector(selector)!;
    assert.ok(button, selector);
    assert.equal(button.disabled, false);
    popover.dispatch('click', {target: button});
  };
  try {
    await run({
      context,
      source,
      project,
      directory,
      store,
      document,
      parent,
      anchor,
      panel,
      click,
      writes,
      get changed() {
        return changed;
      },
      get rerendered() {
        return rerendered;
      },
      activeProjects,
      setReads(value: () => Promise<any>) {
        reads = value;
      },
      open: () => context.openProjectAssignment(source.id, anchor),
      reopen: () => createConversationStore({baseDir: directory}),
    });
  } finally {
    context.closeProjectAssignment?.();
    store.flush();
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

test('project picker can be dismissed while loading without reopening after the result', () =>
  fixture(async f => {
    const pending = deferred<any>();
    f.setReads(() => pending.promise);
    const opened = f.open();
    assert.ok(
      f.panel(),
      'a pending project action must be visible and dismissible',
    );
    assert.ok(
      f.panel()!.contains(f.document.activeElement),
      'loading must receive keyboard focus',
    );
    f.panel()!.dispatch('keydown', {key: 'Escape'});
    assert.ok(!f.panel());
    pending.resolve([f.project]);
    await opened;
    assert.ok(!f.panel(), 'a dismissed request must never resurrect a portal');
    assert.equal(f.writes.length, 0);
    assert.ok(f.document.activeElement === f.anchor);
  }));

test('closing the parent or clicking outside cancels pending project publication', () =>
  fixture(async f => {
    for (const close of [
      () => {
        f.parent.hidden = true;
      },
      () => f.document.dispatch('pointerdown', {target: f.document.body}),
    ]) {
      f.parent.hidden = false;
      const pending = deferred<any>();
      f.setReads(() => pending.promise);
      const opened = f.open();
      close();
      await Promise.resolve();
      pending.resolve([f.project]);
      await opened;
      assert.ok(!f.panel());
      assert.equal(f.anchor.getAttribute('aria-expanded'), 'false');
      assert.equal(f.document.listeners.get('pointerdown')?.length || 0, 0);
    }
  }));

test('load failures remain actionable and retry reaches the real main handler and persistent store', () =>
  fixture(async f => {
    f.setReads(async () => {
      throw new Error('project list offline');
    });
    await f.open();
    assert.match(
      f.panel()!.querySelector('.mp-library-error')!.textContent,
      /project list offline/,
    );
    assert.ok(
      f.document.activeElement ===
        f.panel()!.querySelector('[data-project-retry]'),
    );
    f.setReads(async () => [f.project]);
    f.click('[data-project-retry]');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(
      f.document.activeElement ===
        f.panel()!.querySelector('[data-project-search]'),
    );
    f.click(`[data-project-root="${f.project.id}"]`);
    await new Promise(resolve => setImmediate(resolve));
    const saved = f.reopen().get(f.source.id);
    assert.equal(saved.projectId, f.project.id);
    assert.equal(saved.workspaceRoot, f.project.root);
    assert.equal(f.changed, 1);
    assert.equal(f.rerendered, 1);
    assert.equal(f.parent.hidden, true);
    assert.ok(!f.panel());
  }));

test('the actual session menu row opens the picker and a failed disk commit can be retried', () =>
  fixture(async f => {
    f.anchor.dispatch('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.anchor.getAttribute('aria-haspopup'), 'menu');
    assert.equal(f.anchor.getAttribute('aria-expanded'), 'true');
    const rename = fs.renameSync;
    fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
      if (String(target) === path.join(f.directory, 'conversations.json')) {
        throw Object.assign(new Error('Saved metadata is locked'), {
          code: 'EPERM',
        });
      }
      return rename(source, target);
    }) as typeof fs.renameSync;
    try {
      f.click(`[data-project-root="${f.project.id}"]`);
    } finally {
      fs.renameSync = rename;
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.match(
      f.panel()!.querySelector('.mp-library-error')!.textContent,
      /convo.save_failed/,
    );
    assert.equal(f.reopen().get(f.source.id).projectId || '', '');
    assert.equal(f.changed, 0);
    f.click(`[data-project-root="${f.project.id}"]`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.reopen().get(f.source.id).projectId, f.project.id);
    assert.equal(f.activeProjects.length, 1);
    assert.ok(!f.panel());
  }));

test('an older pending opening cannot replace the current picker or steal focus back', () =>
  fixture(async f => {
    const first = deferred<any>();
    f.setReads(() => first.promise);
    const older = f.open();
    const olderPanel = f.panel();
    const second = deferred<any>();
    f.setReads(() => second.promise);
    const newer = f.open();
    const current = f.panel();
    assert.ok(current && current !== olderPanel);
    assert.equal(f.document.listeners.get('pointerdown')?.length, 1);
    first.resolve([f.project]);
    await older;
    assert.ok(f.panel() === current);
    f.anchor.focus();
    f.document.body.focus();
    second.resolve([f.project]);
    await newer;
    assert.ok(
      f.document.activeElement === f.document.body,
      'loading must not steal focus after the user leaves',
    );
    assert.ok(f.panel() === current);
  }));

test('a missing conversation is reported instead of leaving an empty or stale picker', () =>
  fixture(async f => {
    f.context.Data.conversation = async () => undefined;
    await f.open();
    assert.match(
      f.panel()!.querySelector('.mp-library-error')!.textContent,
      /convo.not_found/,
    );
    assert.equal(f.writes.length, 0);
    assert.equal(
      f.panel()!.querySelector('[data-project-picker]')!.disabled,
      true,
    );
    assert.equal(
      f.panel()!.querySelector('[data-project-retry]')!.hidden,
      false,
    );
  }));

test('parent dismissal removes a loaded project portal and its outside listener', () =>
  fixture(async f => {
    await f.open();
    assert.ok(f.panel());
    f.parent.hidden = true;
    await Promise.resolve();
    assert.ok(!f.panel());
    assert.equal(f.document.listeners.get('pointerdown')?.length || 0, 0);
  }));

test('a refused active-task move stays open and retries the actual main/store operation', () =>
  fixture(async f => {
    await f.open();
    f.context.stageLiveTurns.set('live', {conversationId: f.source.id});
    f.click(`[data-project-root="${f.project.id}"]`);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(
      f.panel()!.querySelector('.mp-library-error')!.textContent,
      /停止/,
    );
    assert.equal(f.reopen().get(f.source.id).projectId || '', '');
    assert.equal(f.changed, 0);
    f.context.stageLiveTurns.clear();
    f.click(`[data-project-root="${f.project.id}"]`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.reopen().get(f.source.id).projectId, f.project.id);
    assert.equal(f.writes.length, 2);
    assert.ok(!f.panel());
  }));
