import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {
  listDashboards,
  runDashboard,
  saveDashboard,
  type DashboardSpec,
} from '../electron/runtime/dashboard';
import {bootPlugins} from '../electron/runtime/agent_plugins';
import {
  createProjectCoordinatorPlugin,
  runRuntime,
} from '../electron/runtime/index';
import {ToolRegistry} from '../electron/runtime/tools';
import type {ProjectRecord} from '../electron/project_store';

const requireFromHere = createRequire(__filename);
const {parseProgressLine} = requireFromHere(
  '../electron/bridge_progress_lines',
) as {
  parseProgressLine(line: unknown): {
    phase: string;
    ms: number | null;
    fields: Record<string, string>;
  } | null;
};

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

describe('Wave 3 projects runtime & dashboard sample wiring', () => {
  it('registers project-coordinator-tools with dispatch and channel update progress callbacks', async () => {
    const userDataDir = makeTempDir('mp-wave3-runtime-');
    const workspaceDir = makeTempDir('mp-wave3-ws-');
    const channelRoot = join(userDataDir, 'projects', 'proj-w3');
    const project: ProjectRecord = {
      id: 'proj-w3',
      name: 'Wave 3 Project',
      root: workspaceDir,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      documents: [],
      resourceInbox: [],
    };

    const progressEvents: Array<{
      phase: string;
      fields: Record<string, unknown>;
    }> = [];
    const registry = new ToolRegistry();
    const plugin = createProjectCoordinatorPlugin(
      {
        workMode: 'project_coordinator',
        projectId: project.id,
        projectContext: project,
        projectChannelRoot: channelRoot,
      },
      workspaceDir,
      workspaceDir,
      userDataDir,
      (phase, fields) => {
        progressEvents.push({phase, fields});
      },
    );

    await bootPlugins({
      directory: join(userDataDir, 'plugins'),
      scope: 'agent',
      builtins: [plugin],
      rows: [{id: plugin.name, plugin: plugin.name}],
      core: {tools: registry},
    });

    const ctx = {
      signal: new AbortController().signal,
      tool_call_id: 'call-w3',
    };

    const startRes = (await registry.get('Project.start_thread')!.execute(
      {
        title: 'Auth worker',
        prompt: 'Implement JWT session middleware',
        useWorktree: false,
      },
      ctx,
    )) as {thread: {id: string}};
    assert.ok(startRes.thread.id);

    await registry.get('Project.message_thread')!.execute(
      {
        threadId: startRes.thread.id,
        message: 'Also add unit tests for expired tokens',
      },
      ctx,
    );

    await registry.get('Project.ask_decision')!.execute(
      {
        question: 'Token signing algorithm?',
        options: [
          {label: 'EdDSA', consequence: 'Fast compact signatures'},
          {label: 'RS256', consequence: 'Broad legacy compatibility'},
        ],
      },
      ctx,
    );

    await registry.get('Project.update_memory')!.execute(
      {
        content: '# Memory\nUse EdDSA for new services.\n',
        mode: 'create',
      },
      ctx,
    );

    await registry.get('Project.write_file')!.execute(
      {
        path: 'notes/plan.md',
        content: '# Plan\n1. Middleware\n',
        overwrite: true,
      },
      ctx,
    );

    await registry.get('Project.publish_artifact')!.execute(
      {
        title: 'Auth spec',
        kind: 'file',
        pathOrUrl: 'notes/plan.md',
      },
      ctx,
    );

    await registry.get('Project.refresh_status_page')!.execute(
      {
        html: '<section><h1>Auth Rollout</h1></section>',
        recapText: 'Started auth worker thread.',
      },
      ctx,
    );

    await registry.get('Project.set_thread_resolved')!.execute(
      {
        threadId: startRes.thread.id,
        resolved: true,
      },
      ctx,
    );

    const beforeReadCount = progressEvents.length;
    await registry.get('Project.list_threads')!.execute({}, ctx);
    assert.equal(
      progressEvents.length,
      beforeReadCount,
      'Read-only Project.list_threads should not emit project_channel_updated',
    );

    const dispatches = progressEvents.filter(
      e => e.phase === 'project_worker_dispatch',
    );
    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[0].fields.action, 'start_thread');
    assert.equal(dispatches[0].fields.projectId, 'proj-w3');
    assert.equal(dispatches[0].fields.threadId, startRes.thread.id);
    assert.equal(
      dispatches[0].fields.prompt,
      'Implement JWT session middleware',
    );
    assert.equal(dispatches[1].fields.action, 'message_thread');
    assert.equal(
      dispatches[1].fields.prompt,
      'Also add unit tests for expired tokens',
    );

    // Verify worker.ts @@mp line encoding preserves spaced prompts via b64.
    const serializedLine =
      '@@mp ' +
      Object.entries({
        phase: 'project_worker_dispatch',
        ms: 42,
        ...dispatches[0].fields,
      })
        .map(([k, v]) => `${k}=${String(v).replace(/\s/g, '_')}`)
        .join(' ');
    const parsedLine = parseProgressLine(serializedLine);
    assert.ok(parsedLine);
    assert.equal(parsedLine.phase, 'project_worker_dispatch');
    assert.ok(parsedLine.fields.b64);
    const decoded = JSON.parse(
      Buffer.from(parsedLine.fields.b64, 'base64').toString('utf8'),
    ) as {prompt: string; threadId: string};
    assert.equal(decoded.prompt, 'Implement JWT session middleware');
    assert.equal(decoded.threadId, startRes.thread.id);

    const channelUpdates = progressEvents.filter(
      e => e.phase === 'project_channel_updated',
    );
    const updatedTools = channelUpdates.map(e => e.fields.tool);
    for (const expectedTool of [
      'Project.start_thread',
      'Project.message_thread',
      'Project.ask_decision',
      'Project.update_memory',
      'Project.write_file',
      'Project.publish_artifact',
      'Project.refresh_status_page',
      'Project.set_thread_resolved',
    ]) {
      assert.ok(
        updatedTools.includes(expectedTool),
        `Expected project_channel_updated for ${expectedTool}`,
      );
    }

    const helpRes = await runRuntime(
      {
        question: '/help',
        workMode: 'project_coordinator',
        projectId: project.id,
        projectContext: project,
        projectChannelRoot: channelRoot,
      },
      {
        root: workspaceDir,
        userDataDir,
      },
    );
    assert.equal(helpRes.ok, true);
    const helpJson = JSON.parse(String(helpRes.answer)) as {
      plugins?: Array<{plugin?: string}>;
    };
    assert.ok(
      helpJson.plugins?.some(item => item.plugin === 'project-coordinator-tools'),
    );
  });

  it('wires worker dispatch, concurrency cap, error timeline, IPC options, and dashboard:create-sample in main.ts and preload.ts', async () => {
    const mainSource = await readFile(
      join(process.cwd(), 'electron', 'main.ts'),
      'utf8',
    );
    const preloadSource = await readFile(
      join(process.cwd(), 'electron', 'preload.ts'),
      'utf8',
    );

    assert.match(mainSource, /activeProjectWorkerRuns\s*=\s*new Map/);
    assert.match(mainSource, /<\s*6|MAX_ACTIVE_PROJECT_WORKER_RUNS\s*=\s*6/);
    assert.match(mainSource, /project_worker_dispatch/);
    assert.match(mainSource, /project_channel_updated/);
    assert.match(mainSource, /type:\s*'worker_dispatched'/);
    assert.match(mainSource, /type:\s*'channel_updated'/);
    assert.match(mainSource, /Coordinator error:/);
    assert.match(mainSource, /author:\s*'system'/);

    assert.match(
      mainSource,
      /'projects:ma:start-thread'[\s\S]*?payload\?\.projectRoot[\s\S]*?useWorktree\s*=\s*payload\?\.useWorktree\s*!==\s*false/,
    );
    assert.match(
      mainSource,
      /'projects:ma:write-file'[\s\S]*?keepBoth:\s*Boolean\(payload\?\.keepBoth\)/,
    );
    assert.match(
      mainSource,
      /'projects:ma:update-sections'[\s\S]*?typeof\s+payload\?\.expectedVersion\s*===\s*'number'[\s\S]*?typeof\s+payload\?\.version\s*===\s*'number'/,
    );

    assert.match(mainSource, /ipcMain\.handle\(\s*'dashboard:create-sample'/);
    assert.match(mainSource, /sample-q4-revenue\.csv/);
    assert.match(mainSource, /saveDashboard/);
    assert.match(
      preloadSource,
      /createSample:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('dashboard:create-sample'\)/,
    );
  });

  it('evaluates sample-q4-revenue CSV and SQL charts cleanly via saveDashboard and runDashboard', async () => {
    const root = makeTempDir('mp-wave3-dash-');
    const csvPath = join(root, 'sample-q4-revenue.csv');
    await writeFile(
      csvPath,
      [
        'month,tier,region,account,arr,expansion_pct,seats,pipeline',
        '2026-10,Enterprise,NA,Acme Corp,180000,122,420,95000',
        '2026-10,Growth,EMEA,Northwind,64000,114,140,42000',
        '2026-11,Enterprise,EMEA,Globex,210000,126,510,120000',
        '2026-11,Starter,APAC,Kestrel AI,24000,105,45,18000',
        '2026-12,Enterprise,NA,Initech,245000,130,600,145000',
        '2026-12,Growth,APAC,Vanguard,78000,118,185,54000',
      ].join('\n'),
      'utf8',
    );

    const spec: DashboardSpec = {
      schemaVersion: 1,
      dashboardId: 'sample-q4-revenue',
      title: 'Q4 Revenue & Telemetry',
      updatedAt: new Date().toISOString(),
      sources: [{sourceId: 'q4', kind: 'csv', path: csvPath}],
      charts: [
        {
          chartId: 'total-arr',
          title: 'Total ARR',
          type: 'kpi',
          queryText: 'SELECT SUM(arr) AS total_arr FROM q4 WHERE $filters',
          querySql: 'SELECT SUM(arr) AS total_arr FROM q4 WHERE $filters',
          yField: 'total_arr',
          format: 'money',
          currency: 'USD',
        },
        {
          chartId: 'net-retention',
          title: 'Net Retention',
          type: 'kpi',
          queryText:
            'SELECT AVG(expansion_pct) AS net_retention FROM q4 WHERE $filters',
          querySql:
            'SELECT AVG(expansion_pct) AS net_retention FROM q4 WHERE $filters',
          yField: 'net_retention',
          format: 'percent',
        },
        {
          chartId: 'monthly-revenue-by-tier',
          title: 'Monthly Revenue by Tier',
          type: 'line',
          queryText:
            'SELECT month, tier, SUM(arr) AS revenue FROM q4 WHERE $filters GROUP BY month, tier ORDER BY month ASC, tier ASC',
          querySql:
            'SELECT month, tier, SUM(arr) AS revenue FROM q4 WHERE $filters GROUP BY month, tier ORDER BY month ASC, tier ASC',
          xField: 'month',
          seriesField: 'tier',
          yField: 'revenue',
          format: 'money',
          currency: 'USD',
        },
        {
          chartId: 'pipeline-by-region',
          title: 'Pipeline by Region',
          type: 'bar',
          queryText:
            'SELECT region, SUM(pipeline) AS pipeline_total FROM q4 WHERE $filters GROUP BY region ORDER BY pipeline_total DESC',
          querySql:
            'SELECT region, SUM(pipeline) AS pipeline_total FROM q4 WHERE $filters GROUP BY region ORDER BY pipeline_total DESC',
          xField: 'region',
          yField: 'pipeline_total',
          format: 'money',
          currency: 'USD',
        },
        {
          chartId: 'top-accounts',
          title: 'Top Accounts',
          type: 'table',
          queryText:
            'SELECT account, SUM(arr) AS arr, AVG(expansion_pct) AS expansion_pct, SUM(seats) AS seats, SUM(pipeline) AS pipeline FROM q4 WHERE $filters GROUP BY account ORDER BY arr DESC',
          querySql:
            'SELECT account, SUM(arr) AS arr, AVG(expansion_pct) AS expansion_pct, SUM(seats) AS seats, SUM(pipeline) AS pipeline FROM q4 WHERE $filters GROUP BY account ORDER BY arr DESC',
          xField: 'account',
        },
      ],
    };

    await saveDashboard(root, spec);
    const list = await listDashboards(root);
    assert.equal(list.length, 1);
    assert.equal(list[0].dashboardId, 'sample-q4-revenue');

    const run = await runDashboard(root, 'sample-q4-revenue');
    assert.equal(run.snapshot.charts.length, 5);
    for (const chart of run.snapshot.charts) {
      assert.equal(
        chart.error,
        undefined,
        `Chart ${chart.chartId} errored: ${chart.error}`,
      );
    }
    assert.equal(run.snapshot.charts[0].current?.value, 801000);
    assert.ok(
      Math.abs((run.snapshot.charts[1].current?.value ?? 0) - 119.1666) < 0.01,
    );
    assert.equal(run.snapshot.charts[2].groups.length, 6);
    assert.equal(run.snapshot.charts[3].groups.length, 3);
    assert.equal(run.snapshot.charts[4].table?.rows.length, 6);
    assert.equal(run.snapshot.charts[4].table?.rows[0].key, 'Initech');
  });
});
