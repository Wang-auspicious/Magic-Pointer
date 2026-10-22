import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const {readProjectPreview} = require('../electron/project_inspector');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile(
  'studio.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const names = [
  'selectProjectFile',
  'openWorkspaceResource',
  'setInspector',
  'refreshProjectInspector',
  'renderSelectedProjectFile',
];
const code = names
  .map(name => {
    const node = ast.statements.find(
      n => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    assert.ok(node, name);
    return node.getText(ast);
  })
  .join('\n');
const compiled = ts.transpileModule(code, {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
}).outputText;

function fixture(root: string) {
  const element = (): any => ({
    hidden: false,
    value: '',
    dataset: {},
    textContent: '',
    children: [],
    classList: {add() {}, remove() {}, toggle() {}},
    setAttribute() {},
    contains: () => false,
    closest: () => null,
    replaceChildren(...children: any[]) {
      this.children = children;
      this.textContent = children.map(n => n.textContent).join('');
    },
  });
  const nodes = new Map<string, any>();
  for (const id of [
    'project-inspector',
    'project-file-preview',
    'project-file-content',
    'project-file-code',
    'project-file-name',
    'inspector-title',
    'file-tree-filter',
  ])
    nodes.set(id, element());
  const ctx: any = {
    Map,
    Set,
    HTMLElement: class {},
    activeProjectRoot: root,
    projectFileRequest: 0,
    selectedProjectPreview: null,
    selectedProjectFile: '',
    selectedProjectFileText: '',
    selectedProjectFileMarkdown: false,
    projectFileCodeView: false,
    projectFileTreeFilter: '',
    projectTreeCache: new Map(),
    expandedProjectDirectories: new Set(),
    workspaceResourceTabs: [],
    workspaceResourceSequence: 0,
    workspaceAutoOpenedResourceKey: '',
    activeInspectorTab: 'files',
    inspectorState: {open: false, tab: 'files'},
    inspectorReturnFocus: null,
    document: {
      getElementById: (id: string) => nodes.get(id),
      createElement: element,
      querySelectorAll: () => [],
      activeElement: null,
      body: element(),
    },
    Data: {
      readProjectFile: async (folder: string, file: string) => ({
        ok: true,
        ...(await readProjectPreview(folder, file)),
      }),
    },
    normalizedProjectRoot: (value: string) => value,
    renderWorkspaceResourceTabs() {},
    resourcePanelFor: () => 'files',
    inspectorStatePolicy: {
      reduceInspectorState: (_state: any, action: any) => ({
        open: action.type === 'open',
        tab: action.tab || 'files',
      }),
    },
    inspectorAvailableWidth: () => 1000,
    sessionPaneSessionId: () => 'fixture',
    trackSessionPaneExpansion() {},
    syncInspectorGeometry() {},
    closeProjectBrowserView() {},
    renderProjectFileTree() {},
    loadProjectDirectory: async () => {
      ctx.projectTreeCache.set('', []);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(compiled, ctx);
  return {ctx, nodes};
}

test('opening a delivered file in a closed uncached inspector displays its actual content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-file-open-'));
  try {
    fs.mkdirSync(path.join(root, 'client'));
    fs.writeFileSync(
      path.join(root, 'client/index.ts'),
      'export const client = "actual client file";',
    );
    const {ctx, nodes} = fixture(root);
    await ctx.selectProjectFile('client/index.ts');
    assert.equal(ctx.inspectorState.open, true);
    assert.equal(ctx.selectedProjectFile, 'client/index.ts');
    assert.match(
      nodes.get('project-file-content').textContent,
      /actual client file/,
    );
    assert.equal(nodes.get('project-file-preview').hidden, false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a late earlier file read cannot replace the newer selection', async () => {
  const {ctx, nodes} = fixture('D:/fixture');
  const pending = new Map<string, (value: any) => void>();
  ctx.Data.readProjectFile = (_root: string, file: string) =>
    new Promise(resolve => pending.set(file, resolve));
  const first = ctx.selectProjectFile('client/index.ts');
  const second = ctx.selectProjectFile('server/index.ts');
  pending.get('server/index.ts')!({ok: true, text: 'server content'});
  await second;
  pending.get('client/index.ts')!({ok: true, text: 'old client content'});
  await first;
  assert.equal(ctx.selectedProjectFile, 'server/index.ts');
  assert.equal(nodes.get('project-file-content').textContent, 'server content');
});
