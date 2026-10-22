import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile(
  'studio.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const names = [
  'buildSessionMenu',
  'openGroupSubmenu',
  'bindSessionMenuKeys',
  'studioMenuItems',
  'enterStudioMenu',
];
const code = ts.transpileModule(
  names
    .map(name => {
      const node = ast.statements.find(
        entry => ts.isFunctionDeclaration(entry) && entry.name?.text === name,
      );
      assert.ok(node, name);
      return node.getText(ast);
    })
    .join('\n'),
  {compilerOptions: {target: ts.ScriptTarget.ES2022}},
).outputText;
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

function library(cells: Map<string, string>): any {
  const context = vm.createContext({
    module: {exports: {}},
    localStorage: {
      getItem: (key: string) => cells.get(key),
      setItem: (key: string, value: string) => cells.set(key, value),
    },
    CdsIcons: {html: () => ''},
  });
  for (const content of libraryCode) {
    vm.runInContext(content, context);
  }
  return context.module.exports;
}

function fixture() {
  const cells = new Map<string, string>();
  const lib = library(cells);
  lib.addSidebarSection('Research');
  lib.addSidebarSection('Other');
  const timers = new Map<number, () => void>();
  let sequence = 0;
  let document: any;
  class Element {
    attrs: Record<string, string> = {};
    dataset: Record<string, string> = {};
    style = {};
    children: Element[] = [];
    parentElement: Element | null = null;
    listeners = new Map<
      string,
      Array<{callback: (event: any) => void; capture: boolean}>
    >();
    observers = new Set<() => void>();
    disabled = false;
    tabIndex = -1;
    textContent = '';
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
      return this.children.length * 24 + 8;
    }
    set innerHTML(value: string) {
      this.children = [];
      this.textContent = value.replace(/<[^>]*>/g, '');
      for (const match of value.matchAll(
        /<button([^>]*)>([\s\S]*?)<\/button>/g,
      )) {
        const button = new Element('button');
        for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
          button.setAttribute(attr[1], attr[2]);
        }
        for (const attr of match[1].matchAll(/\b(data-[\w-]+)(?=\s|$)/g)) {
          button.setAttribute(attr[1], '');
        }
        button.textContent = match[2].replace(/<[^>]*>/g, '');
        this.append(button);
      }
    }
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
      if (name.startsWith('data-')) {
        this.dataset[
          name
            .slice(5)
            .replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())
        ] = value;
      }
    }
    getAttribute(name: string) {
      if (name.startsWith('data-')) {
        return (
          this.dataset[
            name
              .slice(5)
              .replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())
          ] ?? null
        );
      }
      return this.attrs[name] ?? null;
    }
    hasAttribute(name: string) {
      return this.getAttribute(name) !== null;
    }
    append(...nodes: Element[]) {
      for (const node of nodes) {
        node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
    }
    remove() {
      if (!this.parentElement) {
        return;
      }
      if (this.contains(document.activeElement)) {
        document.activeElement = document.body;
      }
      this.parentElement.children = this.parentElement.children.filter(
        node => node !== this,
      );
      this.parentElement = null;
    }
    contains(node: Element | null): boolean {
      return node === this || this.children.some(child => child.contains(node));
    }
    matches(selector: string): boolean {
      if (selector.startsWith('button')) {
        return this.tagName === 'button' && !this.disabled;
      }
      if (selector.startsWith('.')) {
        return this.className.split(' ').includes(selector.slice(1));
      }
      const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
      return Boolean(
        match &&
        this.hasAttribute(match[1]) &&
        (match[2] === undefined || this.getAttribute(match[1]) === match[2]),
      );
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
    getClientRects() {
      for (let node: Element | null = this; node; node = node.parentElement) {
        if (node.hidden) {
          return [];
        }
      }
      return this.isConnected ? [{}] : [];
    }
    getBoundingClientRect() {
      return {left: 100, right: 280, top: 10, bottom: 34};
    }
    addEventListener(
      type: string,
      callback: (event: any) => void,
      capture = false,
    ) {
      this.listeners.set(type, [
        ...(this.listeners.get(type) || []),
        {callback, capture},
      ]);
    }
    removeEventListener(type: string, callback: (event: any) => void) {
      this.listeners.set(
        type,
        (this.listeners.get(type) || []).filter(
          entry => entry.callback !== callback,
        ),
      );
    }
    dispatch(type: string, fields: Record<string, unknown> = {}): any {
      const event = {
        target: this,
        defaultPrevented: false,
        stopped: false,
        immediate: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
        stopImmediatePropagation() {
          this.immediate = true;
          this.stopped = true;
        },
        ...fields,
      };
      const path: Element[] = [];
      for (let node: Element | null = this; node; node = node.parentElement) {
        path.push(node);
      }
      if (!path.includes(document)) {
        path.push(document);
      }
      for (const capture of [true, false]) {
        for (const node of capture ? [...path].reverse() : path) {
          for (const listener of [...(node.listeners.get(type) || [])]) {
            if (listener.capture === capture) {
              listener.callback(event);
            }
            if (event.immediate) {
              break;
            }
          }
          if (event.stopped) {
            return event;
          }
        }
      }
      return event;
    }
    focus() {
      const old = document.activeElement;
      if (old === this) {
        return;
      }
      document.activeElement = this;
      old?.dispatch('focusout', {relatedTarget: this});
      this.dispatch('focusin', {relatedTarget: old});
    }
    click() {
      this.dispatch('click');
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
  const context = vm.createContext({
    document,
    MutationObserver: Observer,
    closeGroupSubmenu: null,
    closeProjectAssignment: null,
    groupSubmenuAnchor: null,
    window: {
      innerWidth: 1200,
      innerHeight: 900,
      setTimeout: (callback: () => void) => {
        timers.set(++sequence, callback);
        return sequence;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
    CdsIcons: {html: () => ''},
    esc: (value: unknown) => String(value),
    studioLibraries: lib,
    branchingConversations: new Set(),
    renderSidebar: async () => {},
  });
  vm.runInContext(code, context);
  const owner = new Element();
  const trigger = new Element('button');
  document.body.append(owner);
  owner.append(trigger);
  const menu = context.buildSessionMenu({id: 'chat', title: 'Task'});
  owner.append(menu);
  menu.hidden = false;
  document.body.append(menu);
  context.bindSessionMenuKeys(menu, trigger, owner);
  const group = menu.querySelector('[data-session-action="group"]')!;
  const key = (value: string, extra: Record<string, unknown> = {}) => {
    const target = document.activeElement;
    const event = target.dispatch('keydown', {key: value, ...extra});
    if (value === 'Enter' && !event.defaultPrevented) {
      target.click();
    }
    return event;
  };
  const panel = () => document.body.querySelector('.side-session-submenu');
  return {
    context,
    lib,
    cells,
    document,
    menu,
    group,
    trigger,
    key,
    panel,
    timers,
    tick: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(callback => callback());
    },
  };
}

test('ArrowRight enters the real session-group submenu and arrows navigate its rows', () => {
  const f = fixture();
  f.group.focus();
  f.key('ArrowRight');
  const panel = f.panel()!;
  assert.ok(panel);
  const rows = panel.querySelectorAll('button');
  assert.ok(f.document.activeElement === rows[0]);
  f.key('End');
  assert.ok(f.document.activeElement === rows.at(-1));
  f.key('Home');
  assert.ok(f.document.activeElement === rows[0]);
  f.key('ArrowDown');
  assert.ok(f.document.activeElement === rows[1]);
});

test('keyboard focus inside the portal cancels hover-close timers', () => {
  const f = fixture();
  f.group.focus();
  f.group.click();
  f.panel()!.querySelector('button')!.focus();
  f.group.dispatch('mouseleave');
  f.panel()!.dispatch('mouseleave');
  f.tick();
  assert.ok(f.panel()?.isConnected);
});

test('Escape closes one layer and a repeated key does not dismiss its parent', async () => {
  const f = fixture();
  f.group.focus();
  f.group.click();
  f.panel()!.querySelector('button')!.focus();
  f.key('ArrowLeft');
  assert.ok(!f.panel());
  assert.ok(f.document.activeElement === f.group);
  f.key('ArrowRight');
  f.key('Escape');
  assert.ok(!f.panel());
  assert.ok(f.document.activeElement === f.group);
  assert.equal(f.menu.hidden, false);
  f.key('Escape', {repeat: true});
  assert.equal(f.menu.hidden, false);
  f.key('Escape');
  await Promise.resolve();
  assert.equal(f.menu.hidden, true);
  assert.ok(f.document.activeElement === f.trigger);
  assert.equal(f.document.listeners.get('keydown')?.length || 0, 0);
});

test('New section commits the entered name and cancellation preserves the existing group', async () => {
  for (const name of [null, 'Created section']) {
    const f = fixture();
    f.context.studioT = (id: string) => id;
    f.context.requestStudioText = async () => name;
    f.group.click();
    f.panel()!.querySelector('[data-session-group-new]')!.focus();
    f.key('Enter');
    await Promise.resolve();
    assert.equal(
      library(f.cells).sessionPreference('chat').group || '',
      name || '',
    );
    assert.ok(!f.panel());
    assert.equal(f.menu.hidden, true);
  }
});

test('Enter moves the session through the production group store and closes both layers', async () => {
  const f = fixture();
  f.group.focus();
  f.group.click();
  f.panel()!.querySelector('[data-session-group="Research"]')!.focus();
  f.key('Enter');
  await Promise.resolve();
  assert.equal(library(f.cells).sessionPreference('chat').group, 'Research');
  assert.equal(f.menu.hidden, true);
  assert.ok(!f.panel());
  assert.ok(f.document.activeElement === f.trigger);
});

test('reopening and closing does not accumulate anchor listeners or timers', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) {
    f.group.click();
    f.context.closeGroupSubmenu();
  }
  assert.equal(f.group.listeners.get('focusout')?.length || 0, 0);
  assert.equal(f.timers.size, 0);
});

test('IME composition never invokes the session archive shortcut', () => {
  const f = fixture();
  f.group.focus();
  f.key('a', {isComposing: true});
  f.key('a', {keyCode: 229});
  assert.equal(Boolean(f.lib.sessionPreference('chat').archived), false);
});

test('Tab closes both menus and closing a parent removes its floating child', async () => {
  const f = fixture();
  f.group.focus();
  f.group.click();
  f.panel()!.querySelector('button')!.focus();
  f.key('Tab');
  await Promise.resolve();
  assert.equal(f.menu.hidden, true);
  assert.ok(!f.panel());
  assert.ok(f.document.activeElement === f.trigger);
  const other = fixture();
  other.group.click();
  other.menu.hidden = true;
  await Promise.resolve();
  assert.ok(!other.panel());
});
