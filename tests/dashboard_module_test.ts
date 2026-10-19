import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {saveDashboard} from '../electron/runtime/dashboard';
import {updateContext} from '../electron/runtime/context';
import {handleFabric} from '../electron/runtime/fabric_api';
import {bootPlugins} from '../electron/runtime/agent_plugins';
import {dashboardModulePlugin} from '../electron/runtime/dashboard_module';
import {ToolRegistry} from '../electron/runtime/tools';
import {createDashboardTools} from '../electron/runtime/dashboard_tools';

test('the Dashboard module queries a real CSV, preserves the shown snapshot and revalidates source access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-dashboard-module-'));
  try {
    const session = await EventSession.open(
      root,
      'agent-studio-new-dashboard-module',
    );
    const file = path.join(root, 'sales.csv');
    await writeFile(file, 'region,revenue\nNorth,12\nSouth,18\n');
    const saved = await saveDashboard(root, {
      schemaVersion: 1,
      dashboardId: '',
      title: 'Sales',
      updatedAt: '',
      sources: [{sourceId: 'sales', kind: 'csv', path: file}],
      charts: [
        {
          chartId: 'revenue',
          title: 'Revenue',
          type: 'kpi',
          queryText: '',
          select: {source: 'sales', value: 'revenue', agg: 'sum'},
        },
      ],
    });
    const request = {
      sessionId: session.id,
      moduleId: 'dashboards',
      panelId: 'dashboards',
    };
    const read = () =>
      handleFabric(
        {operation: 'modules.list', sessionId: session.id},
        {root, userDataDir: root},
      );
    const invoke = (actionId: string) =>
      handleFabric(
        {operation: 'modules.invoke', ...request, actionId},
        {root, userDataDir: root},
      );
    const listed = await read();
    const module = listed.modules.find(
      (row: {id: string}) => row.id === 'dashboards',
    );
    assert.ok(
      module,
      'the existing dashboard feature must be a real loaded module',
    );
    assert.ok(
      module.panels[0].sections.some(
        (section: {rows: Array<{label: string}>}) =>
          section.rows.some(row => row.label === 'Sales'),
      ),
    );
    const denied = await invoke(`open-${saved.dashboardId}`);
    assert.equal(denied.ok, false);
    assert.equal(denied.agentRequest?.toolName, 'Dashboard.open');
    await updateContext(session, {
      scopeGrants: [
        {
          grantId: 'sales',
          taskId: session.id,
          sourceIds: [],
          folderRoots: [root],
          windowIds: [],
          recipients: [],
          actions: ['read'],
          expiresAtMs: null,
        },
      ],
    });
    const opened = await invoke(`open-${saved.dashboardId}`);
    assert.equal(opened.ok, true, opened.error);
    const panelText = (value: typeof opened) =>
      JSON.stringify(
        value.modules.find((row: {id: string}) => row.id === 'dashboards')
          .panels,
      );
    assert.match(panelText(opened), /Revenue/);
    assert.match(panelText(opened), /30/);
    assert.match(panelText(opened), /SUM|sum/);
    await writeFile(file, 'region,revenue\nNorth,112\nSouth,18\n');
    const unchanged = await read();
    assert.match(panelText(unchanged), /30/);
    assert.doesNotMatch(panelText(unchanged), /130/);
    const previewBeforeRefresh = await invoke('inspect-0');
    assert.equal(previewBeforeRefresh.ok, true, previewBeforeRefresh.error);
    assert.match(panelText(previewBeforeRefresh), /112/);
    assert.match(
      panelText(previewBeforeRefresh),
      /Source preview read at/,
      'a fresh file preview must not pose as rows from the earlier chart snapshot',
    );
    const refreshed = await invoke('refresh-values');
    assert.equal(refreshed.ok, true, refreshed.error);
    assert.match(panelText(refreshed), /130/);
    const source = await invoke('inspect-0');
    assert.equal(source.ok, true, source.error);
    assert.match(panelText(source), /112/);
    assert.match(panelText(source), /Row 2/);
    const tools = createDashboardTools({
      userDataDir: root,
      sources: () => [],
      authorizeAccess: () => ({allowed: true}),
    });
    await writeFile(file, 'region,revenue\nNorth,212\nSouth,18\n');
    const args = {dashboard_id: saved.dashboardId};
    const value = await tools.find(tool => tool.name === 'Dashboard.open')!
      .execute(args, {tool_call_id: 'agent-query'});
    await session.append('operation/prepared', {
      operationId: 'agent-query', callId: 'agent-query',
      name: 'Dashboard.open', arguments: args, effect: 'read',
    });
    await session.append('operation/settled', {
      operationId: 'agent-query', outcome: 'succeeded',
      message: {role: 'tool', name: 'Dashboard.open', tool_call_id: 'agent-query',
        content: `${JSON.stringify(value)}\nHook context`, is_error: false},
    });
    assert.match(panelText(await read()), /230/,
      'the panel must show the latest Agent query, including results with hook context');
    await updateContext(session, {scopeRevocations: ['sales']});
    const revoked = await invoke('refresh-values');
    assert.equal(revoked.ok, false);
    assert.match(revoked.error, /granted|authorize/i);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('the first-party Dashboard module owns all six unchanged tools and follows its existing plugin switch', async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'mp-dashboard-module-owner-'),
  );
  try {
    const session = await EventSession.open(
      root,
      'agent-studio-new-dashboard-owner',
    );
    const registry = new ToolRegistry();
    const dashboard = dashboardModulePlugin({
      userDataDir: root,
      session,
      sources: () => [],
      authorizeAccess: () => ({allowed: false}),
    });
    const plugins = await bootPlugins({
      directory: '',
      core: {session, tools: registry},
      builtins: [dashboard],
      rows: [{id: dashboard.name, plugin: dashboard.name}],
    });
    const names = [
      'Dashboard.create',
      'Dashboard.inspect_source',
      'Dashboard.list',
      'Dashboard.open',
      'Dashboard.trace',
      'Dashboard.update',
    ];
    assert.deepEqual(
      registry
        .list()
        .filter(tool => tool.name.startsWith('Dashboard.'))
        .map(tool => tool.name)
        .sort(),
      names,
    );
    await plugins.unmount('dashboard-tools');
    assert.equal(
      registry.list().filter(tool => tool.name.startsWith('Dashboard.')).length,
      0,
    );
    assert.ok(
      !(await plugins.modules.snapshot()).modules.some(
        module => module.id === 'dashboards',
      ),
    );
    assert.ok(registry.get('Modules.task_context.inspect'));
    await plugins.close();
    const disabled = await bootPlugins({
      directory: '',
      core: {session, tools: new ToolRegistry()},
      builtins: [dashboard],
      rows: [{id: dashboard.name, plugin: dashboard.name}],
      patch: {'dashboard-tools': {disabled: true}},
    });
    assert.ok(
      !(await disabled.modules.snapshot()).modules.some(
        module => module.id === 'dashboards',
      ),
    );
    assert.equal(
      disabled.dumpConfig().find(row => row.id === 'dashboard-tools')?.status,
      'disabled',
    );
    await disabled.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
