import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function library(cells = new Map<string, string>()) {
  const sandbox = {
    module: {exports: {}},
    localStorage: {
      getItem: (key: string) => cells.get(key),
      setItem: (key: string, value: string) => cells.set(key, value),
    },
    CdsIcons: {html: (name: string) => `<i>${name}</i>`},
  };
  for (const name of [
    'project_scope',
    'conversation_state',
    'studio_libraries',
  ]) {
    vm.runInNewContext(
      ts.transpileModule(
        fs.readFileSync(`electron/renderer/${name}.ts`, 'utf8'),
        {compilerOptions: {target: ts.ScriptTarget.ES2022}},
      ).outputText,
      sandbox,
    );
  }
  return sandbox.module.exports as any;
}

test('Code group controls persist actual sidebar ordering and visibility independently of the chats page', () => {
  const lib = library();
  const rows = [
    {id: 'a', title: 'Alpha', createdAt: 1, updatedAt: 2},
    {id: 'b', title: 'Beta', createdAt: 2, updatedAt: 1},
  ];
  lib.setFilter('status', 'archived');
  assert.deepEqual(
    Array.from(lib.sidebarRows(rows)).map((row: any) => row.id),
    ['a', 'b'],
  );
  lib.setSidebarOption('sort', 'name');
  lib.setSidebarOption('ascending', true);
  assert.deepEqual(
    Array.from(lib.sidebarRows(rows)).map((row: any) => row.id),
    ['a', 'b'],
  );
  lib.setSidebarOption('ascending', false);
  assert.deepEqual(
    Array.from(lib.sidebarRows(rows)).map((row: any) => row.id),
    ['b', 'a'],
  );
  lib.setSidebarOption('metadata', true);
  assert.equal(lib.preferences.sidebar.metadata, true);
  lib.setSidebarOption('group', 'none');
  lib.addSidebarSection('Research');
  lib.setSessionGroup('a', 'Research');
  const grouped = lib.sidebarSections(lib.sidebarRows(rows), []);
  assert.deepEqual(
    Array.from(grouped[0].items).map((row: any) => row.id),
    ['a'],
  );
  assert.equal(grouped[0].label, 'Research');
  lib.addSidebarSection('Empty section');
  assert.ok(
    lib
      .sidebarSections(lib.sidebarRows(rows), [])
      .some((group: any) => group.label === 'Empty section'),
  );
  const menu = lib.groupMenuMarkup();
  for (const label of [
    'Group by',
    'Sort by',
    'Show',
    'New section',
    'Reset to defaults',
    'View all',
  ]) {
    assert.ok(menu.includes(label), label);
  }
  assert.ok(!menu.includes('Execution environments'));
});

test('pinned movement skips archived and deleted preferences and persists the visible result', () => {
  const cells = new Map<string, string>();
  const lib = library(cells);
  const rows = [{id: 'a'}, {id: 'archived'}, {id: 'b'}];
  for (const [order, id] of ['a', 'archived', 'deleted', 'b'].entries()) {
    lib.setSessionPreference(id, {pinned: true, order, group: 'Research'});
  }
  lib.setSessionPreference('archived', {archived: true});
  const pinned = (value: any) =>
    Array.from(value.sidebarSections(value.sidebarRows(rows), [])[0].items).map(
      (row: any) => row.id,
    );
  assert.deepEqual(pinned(lib), ['a', 'b']);
  lib.movePinned('a', 1, pinned(lib));
  const reopened = library(cells);
  assert.deepEqual(pinned(reopened), ['b', 'a']);
  assert.equal(reopened.sessionPreference('a').group, 'Research');
  assert.equal(reopened.sessionPreference('archived').archived, true);
});

test('pinned movement uses the displayed tie order and only crosses the displayed neighbour', () => {
  const lib = library();
  const rows = [
    {id: 'a', title: 'Alpha'},
    {id: 'b', title: 'Beta'},
  ];
  lib.setSessionPreference('a', {pinned: true});
  lib.setSessionPreference('b', {pinned: true});
  lib.setSidebarOption('sort', 'name');
  lib.setSidebarOption('ascending', false);
  const pinned = () =>
    Array.from(lib.sidebarSections(lib.sidebarRows(rows), [])[0].items).map(
      (row: any) => row.id,
    );
  assert.deepEqual(pinned(), ['b', 'a']);
  lib.movePinned('b', 1, pinned());
  assert.deepEqual(pinned(), ['a', 'b']);
  lib.movePinned('a', -1, ['a']);
  assert.deepEqual(pinned(), ['a', 'b']);
});

test('new chat home does not replace its existing presentation with invented Sessions and Projects lists', () => {
  const home = require('../electron/renderer/studio_home');
  const element = (): any => ({
    hidden: false,
    textContent: '',
    dataset: {},
    children: [],
    content: {querySelector: () => null, childNodes: []},
    setAttribute() {},
    addEventListener() {},
    append(...children: any[]) {
      this.children.push(...children);
    },
    replaceChildren(...children: any[]) {
      this.children = children;
    },
  });
  const attention = element();
  const nodes: Record<string, any> = {
    'studio-home-attention': attention,
    'studio-home-title': element(),
    'studio-home-stats': element(),
  };
  const previous = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = {innerHeight: 900} as Window & typeof globalThis;
  globalThis.document = {
    getElementById: (id: string) => nodes[id] || null,
    querySelectorAll: () => [],
    createElement: element,
  } as unknown as Document;
  try {
    home.render({
      stats: null,
      conversations: [
        {id: 'attention', title: 'Existing unfinished task', state: 'awaiting'},
      ],
      projects: [],
    });
    assert.equal(attention.hidden, true);
    assert.equal(attention.children.length, 0);
  } finally {
    globalThis.document = previous;
    globalThis.window = previousWindow;
  }
});
