import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {
  buildSystemPrompt,
  isLearnWorkMode,
  permissionFor,
} from '../electron/runtime/agent';
import {initialToolNames} from '../electron/runtime/agent_services';
import {registerArtifactTools} from '../electron/runtime/artifacts';
import {executeDashboardSql} from '../electron/runtime/dashboard_sql';
import type {DashboardSourceData} from '../electron/runtime/dashboard';
import {createDesignTools} from '../electron/runtime/design_tools';
import {runRuntime} from '../electron/runtime/index';
import {evaluateAutoModeRule} from '../electron/runtime/project_coordinator_tools';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';
import {ProjectChannelStore} from '../electron/project_channel_store';
import {ProjectWorktreeManager} from '../electron/project_worktree_manager';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, {recursive: true, force: true});
    }
  }
});

describe('Wave 2 backend & runtime integration', () => {
  it('routes buildSystemPrompt, isLearnWorkMode, and initialToolNames by workMode', async () => {
    const userDataDir = makeTempDir('mp-wave2-prompt-');

    assert.equal(isLearnWorkMode('learn'), true);
    assert.equal(isLearnWorkMode('work'), true);
    assert.equal(isLearnWorkMode('design'), false);
    assert.equal(isLearnWorkMode('project_coordinator'), false);
    assert.equal(isLearnWorkMode('code'), false);

    const learnPrompt = await buildSystemPrompt({
      workMode: 'learn',
      userDataDir,
      workspace: '',
      instruction: 'Explain transformers',
    });
    assert.ok(learnPrompt.length > 50);

    const designPrompt = await buildSystemPrompt({
      workMode: 'design',
      userDataDir,
      workspace: '',
      metadata: {
        designCanvasSlug: 'hero-landing',
        designViewContextXml:
          '<design_view_context canvas="hero-landing" zoom="1" />',
        designAnnotationsXml:
          '<design_annotations><pin file="Main.dc.html">Tighten spacing</pin></design_annotations>',
      },
    });
    assert.match(designPrompt, /Magic Pointer Design Studio/);
    assert.match(designPrompt, /hero-landing/);
    assert.match(designPrompt, /<design_view_context/);
    assert.match(designPrompt, /<design_annotations/);

    const coordPrompt = await buildSystemPrompt({
      workMode: 'project_coordinator',
      userDataDir,
      workspace: userDataDir,
    });
    assert.match(coordPrompt, /Project Coordinator/);

    const learnTools = initialToolNames({workMode: 'learn'});
    assert.ok(learnTools.includes('Knowledge.search'));
    assert.ok(!learnTools.includes('Design.upsert_board'));

    const designTools = initialToolNames({workMode: 'design'});
    assert.ok(designTools.includes('Design.init_canvas'));
    assert.ok(designTools.includes('Design.upsert_board'));
    assert.ok(designTools.includes('Dashboard.open'));
    assert.ok(designTools.includes('Artifact.create'));
    assert.ok(designTools.includes('Search'));
    assert.ok(designTools.includes('Fetch'));

    const coordTools = initialToolNames({workMode: 'project_coordinator'});
    assert.ok(coordTools.includes('Project.start_thread'));
    assert.ok(coordTools.includes('Project.ask_decision'));
    assert.ok(coordTools.includes('Read'));
    assert.ok(coordTools.includes('Grep'));
    assert.ok(coordTools.includes('Glob'));
  });

  it('accepts design-canvas and dashboard kinds in Artifact.create', async () => {
    const dir = makeTempDir('mp-wave2-artifacts-');
    const session = await EventSession.open(dir, 'wave2-artifacts-session');
    const registry = new ToolRegistry();
    registerArtifactTools(registry, session);

    const createTool = registry.get('Artifact.create');
    assert.ok(createTool);
    assert.ok(
      createTool.input_schema.properties &&
        typeof createTool.input_schema.properties === 'object',
    );
    const kindProp = (
      createTool.input_schema.properties as Record<string, {enum?: string[]}>
    ).kind;
    assert.ok(kindProp?.enum?.includes('design-canvas'));
    assert.ok(kindProp?.enum?.includes('dashboard'));

    const createdDesign = await createTool.execute({
      title: 'Landing Canvas',
      kind: 'design-canvas',
      content: '{"slug":"landing"}',
    });
    assert.equal((createdDesign as {kind: string}).kind, 'design-canvas');

    const createdDashboard = await createTool.execute({
      title: 'Sales Dashboard',
      kind: 'dashboard',
      content: '{"dashboardId":"sales"}',
    });
    assert.equal((createdDashboard as {kind: string}).kind, 'dashboard');
  });

  it('registers builtin design-tools in runRuntime and persists under designs/', async () => {
    const rootDir = makeTempDir('mp-wave2-runtime-');
    const tools = createDesignTools({rootDir});
    const initTool = tools.find(t => t.name === 'Design.init_canvas');
    const upsertTool = tools.find(t => t.name === 'Design.upsert_board');
    assert.ok(initTool);
    assert.ok(upsertTool);

    await initTool.execute({slug: 'smoke-canvas', title: 'Smoke Canvas'});
    await upsertTool.execute({
      slug: 'smoke-canvas',
      file: 'Main.dc.html',
      html: '<x-dc><h1>Hello</h1></x-dc>',
      board: {x: 0, y: 0, w: 1200, h: 800, title: 'Main'},
    });

    const saved = await readFile(
      join(rootDir, 'designs', 'smoke-canvas', 'Main.dc.html'),
      'utf8',
    );
    assert.match(saved, /Hello/);

    const progressEvents: Array<{phase: string; fields: Record<string, unknown>}> =
      [];
    const result = await runRuntime(
      {
        question: '/help',
        workMode: 'design',
        designCanvasSlug: 'smoke-canvas',
      },
      {
        root: rootDir,
        userDataDir: rootDir,
        onProgress: (phase, fields) => {
          progressEvents.push({phase, fields});
        },
      },
    );
    assert.equal(result.ok, true);
    const parsedHelp = JSON.parse(String(result.answer)) as {
      plugins?: Array<{plugin?: string}>;
    };
    assert.ok(
      parsedHelp.plugins?.some(item => item.plugin === 'design-tools'),
      'design-tools builtin plugin should be registered in runRuntime',
    );
  });

  it('executes read-only dashboard_sql and rejects mutating queries', () => {
    const sources = new Map<string, DashboardSourceData>([
      [
        'sales',
        {
          source: {sourceId: 'sales', kind: 'static'},
          columns: [
            {name: 'region', type: 'string'},
            {name: 'revenue', type: 'number'},
          ],
          rows: [
            {region: 'West', revenue: 120},
            {region: 'West', revenue: 80},
            {region: 'East', revenue: 150},
          ],
          rowNumbers: [1, 2, 3],
          warnings: [],
        },
      ],
    ]);

    const res = executeDashboardSql(
      'SELECT region, SUM(revenue) AS total FROM sales GROUP BY region ORDER BY total DESC',
      sources,
    );
    assert.equal(res.rows.length, 2);
    assert.equal(res.rows[0].region, 'West');
    assert.equal(res.rows[0].total, 200);

    assert.throws(() => {
      executeDashboardSql('DROP TABLE sales', sources);
    });
  });

  it('integrates ProjectChannelStore, ProjectWorktreeManager, and evaluateAutoModeRule with permissionFor', async () => {
    const projectDataDir = makeTempDir('mp-wave2-project-');
    const workspaceDir = makeTempDir('mp-wave2-workspace-');

    const store = new ProjectChannelStore({
      projectId: 'proj-alpha',
      projectDataDir,
    });
    const manager = new ProjectWorktreeManager();
    const ws = await manager.createThreadWorkspace({
      projectRoot: workspaceDir,
      projectDataDir,
      threadId: 'thr-1',
    });
    assert.ok(ws.worktreePath.length > 0);

    const thread = store.createThread({
      id: 'thr-1',
      title: 'Implement auth middleware',
      body: 'Add JWT verification',
      worktreePath: ws.worktreePath,
    });
    assert.equal(thread.id, 'thr-1');

    const evalAllowed = evaluateAutoModeRule(['tool:Design.*', 'bash:npm test*'], {
      toolName: 'Bash',
      command: 'npm test -- --watch=false',
    });
    assert.equal(evalAllowed.allowed, true);

    const session = await EventSession.open(
      projectDataDir,
      'wave2-project-session',
    );
    const registry = new ToolRegistry();
    registry.register({
      name: 'Bash',
      description: 'Run command',
      effect: 'local_irreversible',
      input_schema: {
        type: 'object',
        properties: {command: {type: 'string'}},
        required: ['command'],
      },
      execute: async () => ({ok: true}),
    });
    const decision = permissionFor(
      {
        registry,
        session,
        permissionMode: 'default',
        metadata: {projectAutoModeRules: ['bash:npm test*']},
      },
      {id: 'call-1', name: 'Bash', arguments: {command: 'npm test'}},
      new Set(),
    );
    assert.equal(decision, 'allow');
  });

  it('keeps projects:ma:overview IPC payload structured-cloneable without readTimeline().entries', async () => {
    const projectDataDir = makeTempDir('mp-wave2-overview-');
    const store = new ProjectChannelStore({
      projectId: 'proj-overview',
      projectDataDir,
    });
    store.appendTimeline({
      type: 'goal',
      author: 'user',
      text: 'Ship overview parity',
    });
    const timeline = store.readTimeline({limit: 200});
    assert.ok(Array.isArray(timeline));
    assert.equal(timeline.length, 1);
    assert.doesNotThrow(() =>
      structuredClone({
        timeline,
        memory: {
          ...store.readMemory('/MEMORY.md'),
          topicPaths: store.listMemoryFiles(),
        },
      }),
    );

    const mainSource = await readFile(
      join(process.cwd(), 'electron', 'main.ts'),
      'utf8',
    );
    assert.equal(
      /readTimeline\([^)]*\)\.entries/.test(mainSource),
      false,
      'electron/main.ts must not access .entries on ProjectChannelStore.readTimeline() array return value',
    );
  });
});
