import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';

const {readProjectPreview} = require('../electron/project_inspector');
const {EventSession} = require('../electron/runtime/session');
const {ToolRegistry} = require('../electron/runtime/tools');
const {registerCodingTools} = require('../electron/runtime/agent_files');
const {RuntimeActivitySink} = require('../electron/runtime/agent_activity');
const {createConversationStore} = require('../electron/conversation_store');
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
  'renderProjectFileTree',
  'normalizedProjectRoot',
  'renderProjectChanges',
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
const changeEvent = ast.statements.find(
  n =>
    ts.isExpressionStatement(n) &&
    n
      .getText(ast)
      .startsWith(
        "document.getElementById('project-changes')?.addEventListener('click'",
      ),
) as ts.ExpressionStatement;
assert.ok(changeEvent);
const changeCallback = (changeEvent.expression as ts.CallExpression)
  .arguments[1];
const changeCode = ts.transpileModule(
  `globalThis.clickProjectChange = ${changeCallback.getText(ast)}`,
  {compilerOptions: {target: ts.ScriptTarget.ES2022}},
).outputText;

const mainSource = fs.readFileSync('electron/main.ts', 'utf8');
const mainAst = ts.createSourceFile(
  'main.ts',
  mainSource,
  ts.ScriptTarget.Latest,
  true,
);
const fileHandlerCode = mainAst.statements
  .filter(
    n =>
      ts.isExpressionStatement(n) &&
      ts.isCallExpression(n.expression) &&
      n.expression.expression.getText(mainAst) === 'ipcMain.handle' &&
      [
        "'projects:read-file'",
        "'projects:open-path'",
        "'projects:prepare-deleted-file'",
      ].includes(n.expression.arguments[0].getText(mainAst)),
  )
  .map(n => n.getText(mainAst))
  .join('\n');
const compiledFileHandlers = ts.transpileModule(fileHandlerCode, {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
}).outputText;

function fixture(root: string) {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const openedPaths: string[] = [];
  const knownRoots = new Set([root]);
  const gitFilePreviews =
    new (require('../electron/git_file_previews').GitFilePreviews)(
      path.join(root || os.tmpdir(), 'preview-cache'),
    );
  const mainContext = {
    ipcMain: {
      handle: (name: string, callback: (...args: any[]) => Promise<any>) =>
        handlers.set(name, callback),
    },
    isDashboardSender: () => true,
    knownProjectRoot: (requested: string) =>
      requested && knownRoots.has(requested) ? requested : null,
    path,
    projectPath: require('../electron/project_inspector').projectPath,
    readProjectPreview,
    gitFilePreviews,
    shell: {
      openPath: async (target: string) => {
        openedPaths.push(target);
        return '';
      },
    },
  };
  vm.runInNewContext(compiledFileHandlers, mainContext);
  assert.equal(handlers.size, 3);
  const element = (tag = 'div'): any => {
    const attrs = new Map<string, string>();
    const listeners = new Map<string, () => void>();
    let text = '';
    const node: any = {
      tagName: tag.toUpperCase(),
      hidden: false,
      value: '',
      dataset: {},
      get textContent() {
        return (
          text +
          this.children.map((child: any) => child.textContent || '').join('')
        );
      },
      set textContent(value: string) {
        text = String(value);
        this.children = [];
      },
      children: [],
      get childElementCount() {
        return this.children.length;
      },
      style: {
        setProperty(name: string, value: string) {
          this[name] = value;
        },
      },
      classList: {add() {}, remove() {}, toggle() {}},
      setAttribute(key: string, value: string) {
        attrs.set(key, String(value));
      },
      getAttribute: (key: string) => attrs.get(key),
      removeAttribute: (key: string) => attrs.delete(key),
      addEventListener: (name: string, listener: () => void) =>
        listeners.set(name, listener),
      click: () => listeners.get('click')?.(),
      contains: () => false,
      closest: () => null,
      replaceChildren(...children: any[]) {
        text = '';
        this.children = children;
      },
      append(...children: any[]) {
        for (const child of children) {
          child.parentNode = this;
        }
        this.children.push(...children);
      },
      appendChild(child: any) {
        this.append(child);
        return child;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.children = this.parentNode.children.filter(
            (child: any) => child !== this,
          );
        }
      },
      prepend(...children: any[]) {
        this.children.unshift(...children);
      },
    };
    const updateClasses = (name: string, on: boolean) => {
      const names = new Set(
        String(node.className || '')
          .split(/\s+/)
          .filter(Boolean),
      );
      if (on) names.add(name);
      else names.delete(name);
      node.className = [...names].join(' ');
      return on;
    };
    node.classList = {
      add: (...names: string[]) =>
        names.forEach(name => updateClasses(name, true)),
      remove: (...names: string[]) =>
        names.forEach(name => updateClasses(name, false)),
      contains: (name: string) =>
        String(node.className || '')
          .split(/\s+/)
          .includes(name),
      toggle: (name: string, on?: boolean) =>
        updateClasses(
          name,
          on ??
            !String(node.className || '')
              .split(/\s+/)
              .includes(name),
        ),
    };
    return node;
  };
  const nodes = new Map<string, any>();
  for (const id of [
    'project-inspector',
    'project-file-preview',
    'project-file-content',
    'project-file-code',
    'project-file-open',
    'project-file-copy',
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
    activeConversationId: '',
    projectEnvironment: null,
    pickerCalls: 0,
    openProjectFromPicker: () => {
      ctx.pickerCalls++;
    },
    inspectorError() {},
    projectFileRequest: 0,
    selectedProjectPreview: null,
    selectedProjectFile: '',
    selectedProjectFileText: '',
    selectedProjectFileMarkdown: false,
    selectedProjectFileSnapshot: false,
    selectedProjectFileReadFailed: false,
    ChatView: require('../electron/renderer/chat_view'),
    ProjectPreviewView: {
      renderProjectPreview: (host: any, preview: any) => {
        const globals = globalThis as any;
        const oldDoc = globals.document,
          oldT = globals.studioT;
        globals.document = ctx.document;
        globals.studioT = ctx.studioT;
        try {
          require('../electron/renderer/right_workspace').renderProjectPreview(
            host,
            preview,
          );
        } finally {
          globals.document = oldDoc;
          globals.studioT = oldT;
        }
      },
    },
    studioT: (id: string) => (id === 'files.deleted' ? 'Deleted' : id),
    studioTCount: (_id: string, count: number) => String(count),
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
      getElementById: (id: string) =>
        nodes.get(id) ||
        [...nodes.values()]
          .flatMap(descendants)
          .find((node: any) => node.id === id),
      createElement: element,
      querySelectorAll: () => [],
      activeElement: null,
      body: element(),
    },
    Data: {
      prepareDeletedProjectFile: (folder: string, file: string, base: string) =>
        handlers.get('projects:prepare-deleted-file')!(
          {},
          {projectRoot: folder, path: file, base},
        ),
      readProjectFile: async (folder: string, file: string) => {
        return handlers.get('projects:read-file')!(
          {},
          {projectRoot: folder, path: file},
        );
      },
      openProjectPath: (folder: string, file: string) =>
        handlers.get('projects:open-path')!(
          {},
          {projectRoot: folder, path: file},
        ),
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
    icon: () => '',
    esc: (value: string) => value,
    loadProjectDirectory: async () => {
      ctx.projectTreeCache.set('', []);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(compiled, ctx);
  vm.runInContext(openCode, ctx);
  vm.runInContext(changeCode, ctx);
  return {ctx, nodes, openedPaths, knownRoots};
}

function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=MP Preview',
      '-c',
      'user.email=preview@localhost',
      ...args,
    ],
    {cwd: root, encoding: 'utf8', windowsHide: true},
  );
}

test('a deleted Git row opens its actual index contents without trying to read the missing working file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-git-deleted-row-'));
  try {
    git(root, 'init', '--quiet');
    const relative = 'sub folder/报告.txt';
    fs.mkdirSync(path.join(root, 'sub folder'));
    fs.writeFileSync(path.join(root, relative), 'committed text\n');
    git(root, 'add', '--', relative);
    git(root, 'commit', '-qm', 'baseline');
    fs.writeFileSync(path.join(root, relative), '\nindex content\n\n');
    git(root, 'add', '--', relative);
    fs.unlinkSync(path.join(root, relative));
    const {ctx, nodes} = fixture(root);
    nodes.set('project-changes', ctx.document.createElement('div'));
    ctx.Data.projectEnvironment = async () => ({
      ok: true,
      ...require('../electron/project_environment').parseGitEnvironment({
        root,
        branchOutput: git(root, 'status', '--porcelain=v1', '--branch', '-z'),
      }),
    });
    await ctx.renderProjectChanges();
    const row = descendants(nodes.get('project-changes')).find(
      (node: any) => node.dataset?.changePath === relative,
    );
    assert.ok(row);
    const select = ctx.selectProjectFile;
    let pending: Promise<void> | undefined;
    ctx.selectProjectFile = (...args: any[]) => (pending = select(...args));
    await ctx.clickProjectChange({target: {closest: () => row}});
    await pending;
    assert.equal(ctx.selectedProjectFileText, '\nindex content\n\n');
    assert.equal(ctx.selectedProjectFileSnapshot, true);
    assert.equal(nodes.get('project-file-open').disabled, true);
    assert.equal(fs.existsSync(path.join(root, relative)), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a Git deletion preview exposes a real Git launch failure and can retry the same row', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-git-preview-retry-'));
  const originalPath = process.env.PATH;
  try {
    git(root, 'init', '--quiet');
    fs.writeFileSync(path.join(root, 'gone.txt'), 'original\n');
    git(root, 'add', '--', 'gone.txt');
    git(root, 'commit', '-qm', 'baseline');
    git(root, 'rm', '--quiet', '--', 'gone.txt');
    const {ctx, nodes} = fixture(root);
    nodes.set('project-changes', ctx.document.createElement('div'));
    ctx.Data.projectEnvironment = async () => ({
      ok: true,
      ...require('../electron/project_environment').parseGitEnvironment({
        root,
        branchOutput: git(root, 'status', '--porcelain=v1', '--branch', '-z'),
      }),
    });
    await ctx.renderProjectChanges();
    const row = descendants(nodes.get('project-changes')).find(
      (node: any) => node.dataset?.changePath === 'gone.txt',
    );
    process.env.PATH = '';
    await ctx.clickProjectChange({target: {closest: () => row}});
    const error = ctx.document.getElementById('git-file-preview-error');
    assert.ok(error);
    assert.equal(error.getAttribute('role'), 'alert');
    assert.match(error.textContent, /ENOENT/);
    assert.equal(row.disabled, false);
    assert.equal(ctx.selectedProjectFile, '');
    assert.equal(ctx.workspaceResourceTabs.length, 0);
    process.env.PATH = originalPath;
    await ctx.clickProjectChange({target: {closest: () => row}});
    assert.equal(ctx.selectedProjectFileText, 'original\n');
    assert.equal(
      ctx.document.getElementById('git-file-preview-error'),
      undefined,
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a pending deleted-file preview cannot replace a newer selection and ignores duplicate clicks', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'mp-git-preview-pending-'),
  );
  try {
    git(root, 'init', '--quiet');
    fs.writeFileSync(path.join(root, 'gone.txt'), 'deleted\n');
    git(root, 'add', '--', 'gone.txt');
    fs.unlinkSync(path.join(root, 'gone.txt'));
    fs.writeFileSync(path.join(root, 'current.txt'), 'newer selection\n');
    const {ctx, nodes} = fixture(root);
    nodes.set('project-changes', ctx.document.createElement('div'));
    ctx.Data.projectEnvironment = async () => ({
      ok: true,
      ...require('../electron/project_environment').parseGitEnvironment({
        root,
        branchOutput: git(root, 'status', '--porcelain=v1', '--branch', '-z'),
      }),
    });
    await ctx.renderProjectChanges();
    const row = descendants(nodes.get('project-changes')).find(
      (node: any) => node.dataset?.changePath === 'gone.txt',
    );
    const prepare = ctx.Data.prepareDeletedProjectFile;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    ctx.Data.prepareDeletedProjectFile = async (...args: any[]) => {
      calls++;
      await gate;
      return prepare(...args);
    };
    const pending = ctx.clickProjectChange({target: {closest: () => row}});
    assert.equal(row.disabled, true);
    assert.equal(row.getAttribute('aria-busy'), 'true');
    await ctx.clickProjectChange({target: {closest: () => row}});
    assert.equal(calls, 1);
    await ctx.selectProjectFile('current.txt');
    release();
    await pending;
    assert.equal(ctx.selectedProjectFileText, 'newer selection\n');
    assert.equal(row.disabled, false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('an earlier Git list response cannot replace the newly selected project changes', async () => {
  const {ctx, nodes} = fixture('C:/first-project');
  nodes.set('project-changes', ctx.document.createElement('div'));
  const responses = new Map<string, (value: any) => void>();
  ctx.Data.projectEnvironment = (root: string) =>
    new Promise(resolve => responses.set(root, resolve));
  const earlier = ctx.renderProjectChanges();
  ctx.activeProjectRoot = 'C:/second-project';
  const current = ctx.renderProjectChanges();
  responses.get('C:/second-project')!({
    ok: true,
    branch: 'current',
    fileChanges: [{path: 'new.txt', status: 'M', staged: false}],
  });
  await current;
  responses.get('C:/first-project')!({
    ok: true,
    branch: 'old',
    fileChanges: [
      {path: 'old.txt', status: 'D', staged: true, deletionBase: 'head'},
    ],
  });
  await earlier;
  assert.equal(ctx.projectEnvironment.branch, 'current');
  const paths = descendants(nodes.get('project-changes'))
    .filter((node: any) => node.dataset?.changePath)
    .map((node: any) => node.dataset.changePath);
  assert.deepEqual(paths, ['new.txt']);
});

async function clickDelivered(ctx: any, turn: any, file: string) {
  const html = ctx.ChatView.assistantTurnNode(turn)
    .map((n: any) => n.outerHTML)
    .join('');
  const button = [
    ...html.matchAll(/<button[^>]*data-mp-chat-act="open-file"[^>]*>/g),
  ]
    .map(match => match[0])
    .find(tag => tag.includes(`data-file-path="${file}"`));
  assert.ok(button, file);
  const attrs = Object.fromEntries(
    [...button.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [
      match[1],
      match[2],
    ]),
  );
  const events = new Map<string, (event: any) => void>();
  let pending: Promise<void> | undefined;
  ctx.DOC = {
    dispatchEvent: (event: any) => {
      pending = ctx.openDelivered(event);
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
  vm.runInContext(`(${ctx.ChatView.bindDelegation.toString()})(fileHost)`, ctx);
  events.get('click')!({
    target: {closest: () => ({getAttribute: (name: string) => attrs[name]})},
  });
  await pending;
}

test('a relative file receipt reopens its actual execution target with no project or another project selected', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-origin-file-'));
  try {
    const origin = path.join(base, 'origin');
    const other = path.join(base, 'other');
    fs.mkdirSync(origin);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'result.txt'), 'wrong project file\n');
    const session = await EventSession.open(origin, 'agent-origin-file');
    const registry = new ToolRegistry();
    registerCodingTools(registry, origin, session);
    const result = await registry.execute({
      id: 'origin-write',
      name: 'Write',
      arguments: {path: 'result.txt', content: 'actual execution file\n'},
    });
    assert.equal(result.is_error, false, result.error_message);
    assert.equal((result.value as any).path, 'result.txt');
    const sink = new RuntimeActivitySink(() => {});
    sink.onEvent({kind: 'tool_call_finished', result});
    const store = createConversationStore({baseDir: origin});
    const saved = store.appendTurn({
      newConversation: true,
      question: 'Write a result',
      answer: 'Saved',
      trajectory: sink.trajectory,
    });
    store.flush();
    const turn = createConversationStore({baseDir: origin}).get(saved.id)
      .turns[0];
    const local = fixture(origin);
    await clickDelivered(local.ctx, turn, 'result.txt');
    local.nodes.set(
      'project-file-tree',
      local.ctx.document.createElement('div'),
    );
    local.ctx.projectTreeCache.set('', [
      {path: 'result.txt', name: 'result.txt', kind: 'file'},
    ]);
    local.ctx.renderProjectFileTree();
    assert.equal(
      local.nodes
        .get('project-file-tree')
        .children[0].classList.contains('is-on'),
      true,
    );
    const states = [];
    for (const selectedRoot of ['', other, origin]) {
      const {ctx, nodes, knownRoots} = fixture(selectedRoot);
      await clickDelivered(ctx, turn, 'result.txt');
      assert.equal(ctx.activeProjectRoot, selectedRoot);
      if (selectedRoot === origin) {
        knownRoots.add(other);
        ctx.activeProjectRoot = other;
        const select = ctx.selectProjectFile;
        let pending: Promise<void> | undefined;
        ctx.selectProjectFile = (...args: any[]) => (pending = select(...args));
        ctx.activateWorkspaceResource(ctx.workspaceResourceTabs[0].id);
        await pending;
      }
      states.push({
        picker: ctx.pickerCalls,
        content: nodes.get('project-file-content').textContent,
      });
    }
    assert.deepEqual(
      states,
      Array.from({length: 3}, () => ({
        picker: 0,
        content: 'actual execution file\n',
      })),
    );
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('a deleted relative target retains its original snapshot after another project is selected', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-origin-snapshot-'));
  try {
    const origin = path.join(base, 'origin');
    const other = path.join(base, 'other');
    fs.mkdirSync(origin);
    fs.mkdirSync(other);
    fs.writeFileSync(
      path.join(origin, 'gone.txt'),
      'original deleted content\n',
    );
    fs.writeFileSync(
      path.join(other, 'gone.txt'),
      'unrelated present content\n',
    );
    const session = await EventSession.open(origin, 'agent-origin-snapshot');
    const registry = new ToolRegistry();
    registerCodingTools(registry, origin, session);
    const result = await registry.execute({
      id: 'origin-delete',
      name: 'Patch',
      arguments: {
        patch: '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch',
      },
    });
    assert.equal(result.is_error, false, result.error_message);
    for (const selectedRoot of ['', other]) {
      const {ctx, nodes} = fixture(selectedRoot);
      await clickDelivered(
        ctx,
        {
          answer: 'Deleted',
          trajectory: [
            {kind: 'tool', name: 'Patch', result: JSON.stringify(result.value)},
          ],
        },
        'gone.txt',
      );
      assert.equal(ctx.pickerCalls, 0);
      assert.equal(ctx.selectedProjectFileText, 'original deleted content\n');
      assert.equal(ctx.selectedProjectFileSnapshot, true);
      assert.equal(nodes.get('project-file-open').disabled, true);
    }
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('older relative file and snapshot receipts use the saved turn execution directory', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-legacy-origin-'));
  try {
    const origin = path.join(base, 'worktree');
    const other = path.join(base, 'project');
    fs.mkdirSync(origin);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(origin, 'result.txt'), 'saved worktree file\n');
    fs.writeFileSync(
      path.join(other, 'result.txt'),
      'wrong base-project file\n',
    );
    const snapshot = path
      .join('.mp', 'checkpoints', 'old.bin.txt')
      .replace(/\\/g, '/');
    fs.mkdirSync(path.join(origin, '.mp', 'checkpoints'), {recursive: true});
    fs.writeFileSync(path.join(origin, snapshot), 'saved deleted content\n');
    const trajectory = [
      {
        kind: 'tool',
        name: 'Write',
        result: JSON.stringify({path: 'result.txt', created: true}),
      },
      {
        kind: 'tool',
        name: 'Patch',
        result: JSON.stringify({
          fileChanges: [
            {path: 'gone.txt', exists: false, previewPath: snapshot},
          ],
        }),
      },
    ];
    const store = createConversationStore({baseDir: base});
    const saved = store.appendTurn({
      newConversation: true,
      question: 'Older change',
      answer: 'Saved',
      workspaceRoot: other,
      request: {executionWorkspaceRoot: origin},
      trajectory,
    });
    store.flush();
    const turn = createConversationStore({baseDir: base}).get(saved.id)
      .turns[0];
    const {ctx, nodes} = fixture(other);
    await clickDelivered(ctx, turn, 'result.txt');
    assert.equal(
      nodes.get('project-file-content').textContent,
      'saved worktree file\n',
    );
    await clickDelivered(ctx, turn, 'gone.txt');
    assert.equal(ctx.selectedProjectFileText, 'saved deleted content\n');
    assert.equal(ctx.selectedProjectFileSnapshot, true);
    assert.equal(ctx.activeProjectRoot, other);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('an older relative receipt without an execution directory explains the missing origin instead of reading another project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-unknown-origin-'));
  try {
    fs.writeFileSync(
      path.join(root, 'result.txt'),
      'wrong current-project file\n',
    );
    const {ctx, nodes} = fixture(root);
    await clickDelivered(
      ctx,
      {
        answer: 'Saved',
        trajectory: [
          {
            kind: 'tool',
            name: 'Write',
            result: JSON.stringify({path: 'result.txt'}),
          },
        ],
      },
      'result.txt',
    );
    assert.equal(nodes.get('project-file-content').textContent, '');
    const notice = ctx.document.body.children.find(
      (node: any) => node.getAttribute('role') === 'alert',
    );
    assert.ok(notice);
    assert.match(notice.textContent, /result.txt.*files.origin_unknown/);
    assert.equal(ctx.pickerCalls, 0);
    notice.children[0].click();
    assert.equal(ctx.document.body.children.length, 0);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a delivered file in an additional folder opens the actual absolute target without confusing a shared directory prefix', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-external-delivered-'));
  try {
    const root = path.join(base, 'project');
    const extra = path.join(base, 'project-extra');
    fs.mkdirSync(root);
    fs.mkdirSync(extra);
    const target = path.join(extra, 'delivered.txt');
    const session = await EventSession.open(root, 'agent-external-delivered');
    const registry = new ToolRegistry();
    registerCodingTools(registry, root, session, [extra]);
    const result = await registry.execute({
      id: 'write-extra',
      name: 'Write',
      arguments: {path: target, content: 'actual additional-folder result\n'},
    });
    assert.equal(result.is_error, false, result.error_message);
    const deliveredPath = (result.value as any).path;
    const {ctx, nodes, openedPaths} = fixture(root);
    await ctx.openDelivered({detail: {path: deliveredPath}});
    assert.equal(
      nodes.get('project-file-content').textContent,
      'actual additional-folder result\n',
    );
    assert.equal(ctx.activeProjectRoot, root);
    const opened = await ctx.Data.openProjectPath(
      root,
      ctx.selectedProjectFile,
    );
    assert.equal(opened.ok, true, opened.error);
    assert.equal(openedPaths[0], target);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

test('a delivered absolute file opens with no selected project and returns from its resource tab', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-no-project-file-'));
  try {
    const target = path.join(root, 'delivered.txt');
    fs.writeFileSync(target, 'actual no-project file\n');
    const {ctx, nodes} = fixture('');
    await ctx.openDelivered({detail: {path: target}});
    assert.equal(ctx.pickerCalls, 0);
    assert.equal(ctx.activeProjectRoot, '');
    assert.equal(
      nodes.get('project-file-content').textContent,
      'actual no-project file\n',
    );
    const tab = ctx.workspaceResourceTabs[0];
    assert.ok(tab);
    const read = ctx.selectProjectFile;
    let pending: Promise<void> | undefined;
    ctx.selectProjectFile = (...args: any[]) => (pending = read(...args));
    ctx.activateWorkspaceResource(tab.id);
    await pending;
    assert.equal(
      nodes.get('project-file-content').textContent,
      'actual no-project file\n',
    );
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('an absolute image uses the existing media preview without opening a browser or selecting a project', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-external-image-'));
  try {
    const target = path.join(folder, 'image.png');
    const png = await require('sharp')({
      create: {width: 1, height: 1, channels: 4, background: '#315a89'},
    })
      .png()
      .toBuffer();
    fs.writeFileSync(target, png);
    const {ctx, nodes} = fixture('');
    await ctx.openDelivered({detail: {path: target}});
    assert.equal(ctx.pickerCalls, 0);
    assert.equal(ctx.workspaceResourceTabs[0].kind, 'file');
    const viewer = descendants(nodes.get('project-file-content')).find(
      n => n.tagName === 'IMG',
    );
    assert.ok(viewer);
    assert.equal(require('node:url').fileURLToPath(viewer.src), target);
    assert.equal(nodes.get('project-file-copy').hidden, true);
  } finally {
    fs.rmSync(folder, {recursive: true, force: true});
  }
});

test('a project-local absolute path with normalized slashes retains its exact relative target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-normalized-project-'));
  try {
    const target = path.join(root, 'inside.txt');
    fs.writeFileSync(target, 'inside file\n');
    const {ctx, nodes} = fixture(root);
    await ctx.openDelivered({detail: {path: target.replace(/\\/g, '/')}});
    assert.equal(ctx.selectedProjectFile, 'inside.txt');
    assert.equal(
      nodes.get('project-file-content').textContent,
      'inside file\n',
    );
    const invalid = await ctx.Data.readProjectFile(root, '../outside.txt');
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /invalid_project_path/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

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
    assert.equal(
      path.resolve(root, ctx.selectedProjectFile),
      path.resolve(root, change.previewPath),
    );
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

function descendants(node: any): any[] {
  return [node, ...(node.children || []).flatMap(descendants)];
}

test('a deleted PNG and PDF retain their formats and reach the existing media viewer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-deleted-media-'));
  try {
    const png = await require('sharp')({
      create: {width: 1, height: 1, channels: 4, background: '#315a89'},
    })
      .png()
      .toBuffer();
    const {PDFDocument} = require('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    fs.writeFileSync(path.join(root, 'old.png'), png);
    fs.writeFileSync(path.join(root, 'old.pdf'), await pdf.save());
    const session = await EventSession.open(root, 'agent-media-preview');
    const registry = new ToolRegistry();
    registerCodingTools(registry, root, session);
    const result = await registry.execute({
      id: 'delete-media',
      name: 'Patch',
      arguments: {
        patch:
          '*** Begin Patch\n*** Delete File: old.png\n*** Delete File: old.pdf\n*** End Patch',
      },
    });
    assert.equal(result.is_error, false, result.error_message);
    const {ctx, nodes} = fixture(root);
    for (const change of (result.value as any).fileChanges) {
      const expected = change.path.endsWith('.png') ? 'image' : 'pdf';
      const preview = await readProjectPreview(root, change.previewPath);
      assert.equal(preview.kind, expected);
      await ctx.openDelivered({
        detail: {path: change.path, previewPath: change.previewPath},
      });
      const viewer = descendants(nodes.get('project-file-content')).find(
        n => n.tagName === (expected === 'image' ? 'IMG' : 'IFRAME'),
      );
      assert.ok(viewer, expected + ' viewer mounted');
      assert.equal(viewer.src, preview.url);
      assert.equal(nodes.get('project-file-copy').hidden, true);
      if (expected === 'image') {
        const data = fs.readFileSync(
          require('node:url').fileURLToPath(viewer.src),
        );
        assert.deepEqual(data, png);
        const decoded = await require('sharp')(data)
          .raw()
          .toBuffer({resolveWithObject: true});
        assert.equal(decoded.info.width, 1);
        assert.equal(decoded.info.height, 1);
        const controls = descendants(nodes.get('project-file-content'));
        controls
          .find(n => n.tagName === 'BUTTON' && n.textContent === '100%')
          .click();
        assert.equal(
          controls
            .find(n => n.className?.includes('mp-preview-image-viewport'))
            .classList.contains('is-actual-size'),
          true,
        );
      } else
        assert.equal(
          (
            await PDFDocument.load(
              fs.readFileSync(require('node:url').fileURLToPath(viewer.src)),
            )
          ).getPageCount(),
          1,
        );
    }
    fs.writeFileSync(path.join(root, 'normal.txt'), 'ordinary text');
    await ctx.selectProjectFile('normal.txt');
    assert.equal(nodes.get('project-file-copy').hidden, false);
    assert.equal(
      nodes.get('project-file-content').classList.contains('is-office-preview'),
      false,
    );
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('deleted Office files use retained document and sheet previews instead of raw binary text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-deleted-office-'));
  try {
    const AdmZip = require('adm-zip');
    const word = new AdmZip();
    word.addFile(
      'word/document.xml',
      Buffer.from(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Retained Word paragraph</w:t></w:r></w:p></w:body></w:document>',
      ),
    );
    word.writeZip(path.join(root, 'old.docx'));
    const ppt = new AdmZip();
    ppt.addFile(
      'ppt/slides/slide1.xml',
      Buffer.from(
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Retained slide paragraph</a:t></a:r></a:p></p:sld>',
      ),
    );
    ppt.writeZip(path.join(root, 'old.pptx'));
    const ExcelJS = require('exceljs');
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Retained').addRow(['Retained sheet cell', 7]);
    await book.xlsx.writeFile(path.join(root, 'old.xlsx'));
    const session = await EventSession.open(root, 'agent-office-preview');
    const registry = new ToolRegistry();
    registerCodingTools(registry, root, session);
    const result = await registry.execute({
      id: 'delete-office',
      name: 'Patch',
      arguments: {
        patch:
          '*** Begin Patch\n*** Delete File: old.docx\n*** Delete File: old.pptx\n*** Delete File: old.xlsx\n*** End Patch',
      },
    });
    assert.equal(result.is_error, false, result.error_message);
    const {ctx, nodes} = fixture(root);
    for (const change of (result.value as any).fileChanges) {
      const preview = await readProjectPreview(root, change.previewPath);
      assert.equal(
        preview.kind,
        change.path.endsWith('xlsx') ? 'spreadsheet' : 'document',
      );
      await ctx.openDelivered({
        detail: {path: change.path, previewPath: change.previewPath},
      });
      const text = nodes.get('project-file-content').textContent;
      assert.match(text, /Retained/);
      assert.doesNotMatch(text, /- Retained/);
      assert.match(
        nodes.get('project-file-name').textContent,
        /old\.(?:docx|pptx|xlsx).*Deleted/,
      );
    }
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
