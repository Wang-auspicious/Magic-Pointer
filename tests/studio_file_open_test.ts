import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const {readProjectPreview} = require('../electron/project_inspector');
const {EventSession} = require('../electron/runtime/session');
const {ToolRegistry} = require('../electron/runtime/tools');
const {registerCodingTools} = require('../electron/runtime/agent_files');
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
  'activateWorkspaceResource',
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
const openEvent = ast.statements.find(
  n =>
    ts.isExpressionStatement(n) &&
    ts.isCallExpression(n.expression) &&
    n.expression.expression.getText(ast) === 'document.addEventListener' &&
    n.expression.arguments[0].getText(ast) === "'mp:open-file'",
) as ts.ExpressionStatement;
assert.ok(openEvent);
const openCallback = (openEvent.expression as ts.CallExpression).arguments[1];
const openCode = ts.transpileModule(
  `globalThis.openDelivered = ${openCallback.getText(ast)}`,
  {compilerOptions: {target: ts.ScriptTarget.ES2022}},
).outputText;

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
    'project-file-open',
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
    selectedProjectFileSnapshot: false,
    selectedProjectFileReadFailed: false,
    ChatView: require('../electron/renderer/chat_view'),
    studioT: (id: string) => (id === 'files.deleted' ? 'Deleted' : id),
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
      readProjectFile: async (folder: string, file: string) => {
        try {
          return {ok: true, ...(await readProjectPreview(folder, file))};
        } catch (error) {
          return {ok: false, error: String(error)};
        }
      },
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
  vm.runInContext(openCode, ctx);
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

test('a deleted-file action opens its actual retained snapshot and restores that target from the resource tab', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-deleted-file-'));
  try {
    fs.writeFileSync(path.join(root, 'gone.txt'), 'retained old content\n');
    fs.writeFileSync(path.join(root, 'present.txt'), 'current file\n');
    const session = await EventSession.open(root, 'agent-deleted-preview');
    const registry = new ToolRegistry();
    registerCodingTools(registry, root, session);
    const result = await registry.execute({
      id: 'delete',
      name: 'Patch',
      arguments: {
        patch: '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch',
      },
    });
    assert.equal(result.is_error, false, result.error_message);
    const change = (result.value as any).fileChanges[0];
    const {ctx, nodes} = fixture(root);
    const original = ctx.selectProjectFile;
    let selected: Promise<void> | undefined;
    ctx.selectProjectFile = (...args: any[]) => (selected = original(...args));
    const rendered = ctx.ChatView.assistantTurnNode({
      answer: 'Deleted.',
      trajectory: [
        {kind: 'tool', name: 'Patch', result: JSON.stringify(result.value)},
      ],
    })
      .map((n: {outerHTML: string}) => n.outerHTML)
      .join('');
    const button = rendered.match(
      /<button[^>]*data-file-path="gone\.txt"[^>]*>/,
    )![0];
    const attrs = Object.fromEntries(
      [...button.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [
        match[1],
        match[2],
      ]),
    );
    const events = new Map<string, (event: any) => void>();
    let delivered: Promise<void> | undefined;
    ctx.DOC = {
      dispatchEvent: (event: any) => {
        delivered = ctx.openDelivered(event);
        return true;
      },
    };
    ctx.CustomEvent = class {
      detail: any;
      constructor(_type: string, options: any) {
        this.detail = options.detail;
      }
    };
    ctx.rememberGroupToggle = () => {};
    ctx.fileHost = {
      addEventListener: (name: string, listener: (event: any) => void) =>
        events.set(name, listener),
    };
    vm.runInContext(
      `(${ctx.ChatView.bindDelegation.toString()})(fileHost)`,
      ctx,
    );
    events.get('click')!({
      target: {closest: () => ({getAttribute: (name: string) => attrs[name]})},
    });
    await delivered;
    await selected;
    assert.equal(ctx.selectedProjectFile, change.previewPath);
    assert.equal(ctx.selectedProjectFileSnapshot, true);
    assert.match(
      nodes.get('project-file-name').textContent,
      /gone.txt.*Deleted/,
    );
    assert.match(
      nodes.get('project-file-content').children[0].outerHTML,
      /data-kind="del"[^>]*>- retained old content/,
    );
    assert.equal(nodes.get('project-file-open').disabled, true);
    const snapshotTab = ctx.workspaceResourceTabs.find(
      (tab: any) => tab.snapshot,
    );
    assert.ok(snapshotTab);
    await ctx.selectProjectFile('present.txt');
    assert.equal(nodes.get('project-file-open').disabled, false);
    ctx.activateWorkspaceResource(snapshotTab.id);
    await selected;
    assert.equal(ctx.selectedProjectFileSnapshot, true);
    assert.equal(ctx.selectedProjectFileText, 'retained old content\n');
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

test('a snapshot read error is displayed as an error instead of deleted file content', async () => {
  const {ctx, nodes} = fixture('D:/fixture');
  ctx.Data.readProjectFile = async () => ({
    ok: false,
    error: 'Unsupported binary preview',
  });
  await ctx.selectProjectFile('.mp/retained.bin', {
    snapshot: true,
    title: 'image.png · Deleted',
  });
  assert.equal(
    nodes.get('project-file-content').textContent,
    'Unsupported binary preview',
  );
  assert.equal(nodes.get('project-file-open').disabled, true);
});
