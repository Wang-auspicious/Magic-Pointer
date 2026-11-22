import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {
  normalizePermissionPreset,
  PERMISSION_MODES,
} from '../electron/permission_mode';
import type {ProjectRecord} from '../electron/project_store';
import {resolveSessionId, runRuntime} from '../electron/runtime/index';

const requireFromHere = createRequire(__filename);
const {appendTranscript} = requireFromHere('../electron/conversation_control') as {
  appendTranscript(
    transcript: {
      answer: string;
      thinking: string;
      trajectory: Array<Record<string, unknown>>;
    },
    record: unknown,
  ): boolean;
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

function extractFunctionSlice(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Expected to find ${marker}`);
  const nextHandler = source.indexOf('\nipcMain.handle(', start + marker.length);
  return nextHandler === -1 ? source.slice(start) : source.slice(start, nextHandler);
}

describe('Wave 4 projects execution engine, streaming, and stop IPC', () => {
  it('rejects permissionPreset "default" and executes project_coordinator cleanly with "auto"', async () => {
    assert.throws(
      () => normalizePermissionPreset('default'),
      /Unknown permission preset: default/,
    );
    assert.equal(normalizePermissionPreset('auto'), 'auto');
    assert.equal(PERMISSION_MODES.auto, 'accept_reversible');

    const userDataDir = makeTempDir('mp-wave4-runtime-');
    const workspaceDir = makeTempDir('mp-wave4-ws-');
    const channelRoot = join(userDataDir, 'projects', 'proj-w4');
    const project: ProjectRecord = {
      id: 'proj-w4',
      name: 'Wave 4 Project',
      root: workspaceDir,
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
      documents: [],
      resourceInbox: [],
    };

    await assert.rejects(
      () =>
        runRuntime(
          {
            question: '/help',
            workMode: 'project_coordinator',
            projectId: project.id,
            projectContext: project,
            projectChannelRoot: channelRoot,
            permissionPreset: 'default',
          },
          {root: workspaceDir, userDataDir},
        ),
      /Unknown permission preset: default/,
    );

    const coordinatorSessionKey = `proj-${project.id}-coordinator`;
    const firstRes = await runRuntime(
      {
        question: '/help',
        workMode: 'project_coordinator',
        projectId: project.id,
        projectContext: project,
        projectChannelRoot: channelRoot,
        agentSessionId: coordinatorSessionKey,
        conversationId: coordinatorSessionKey,
        permissionPreset: 'auto',
      },
      {root: workspaceDir, userDataDir},
    );
    const secondRes = await runRuntime(
      {
        question: '/help',
        workMode: 'project_coordinator',
        projectId: project.id,
        projectContext: project,
        projectChannelRoot: channelRoot,
        agentSessionId: coordinatorSessionKey,
        conversationId: coordinatorSessionKey,
        permissionPreset: 'auto',
      },
      {root: workspaceDir, userDataDir},
    );

    const permRes = await runRuntime(
      {
        question: '/permission',
        workMode: 'project_coordinator',
        projectId: project.id,
        projectContext: project,
        projectChannelRoot: channelRoot,
        agentSessionId: coordinatorSessionKey,
        conversationId: coordinatorSessionKey,
        permissionPreset: 'auto',
      },
      {root: workspaceDir, userDataDir},
    );

    assert.equal(firstRes.ok, true);
    assert.equal(permRes.ok, true);
    assert.equal(permRes.permissionPreset, 'auto');
    assert.equal(firstRes.agentSessionId, secondRes.agentSessionId);
    assert.equal(
      resolveSessionId({
        agentSessionId: coordinatorSessionKey,
        conversationId: coordinatorSessionKey,
      }),
      firstRes.agentSessionId,
    );

    const helpJson = JSON.parse(String(firstRes.answer)) as {
      plugins?: Array<{plugin?: string}>;
    };
    assert.ok(
      helpJson.plugins?.some(
        item => item.plugin === 'project-coordinator-tools',
      ),
    );
  });

  it('accumulates streaming answer, reasoning, and tool trajectory via appendTranscript', () => {
    const progress = {
      answer: '',
      thinking: '',
      trajectory: [] as Array<Record<string, unknown>>,
      agentSessionId: 'proj-w4-coordinator',
    };

    assert.equal(
      appendTranscript(progress, {
        phase: 'model_request',
        ms: 10,
        fields: {turn: '1', atMs: '100'},
      }),
      true,
    );
    assert.equal(
      appendTranscript(progress, {
        phase: 'reasoning_chunk',
        ms: 20,
        fields: {
          b64: Buffer.from('Inspecting workspace layout.', 'utf8').toString(
            'base64',
          ),
          atMs: '110',
        },
      }),
      true,
    );
    assert.equal(
      appendTranscript(progress, {
        phase: 'tool_call',
        ms: 30,
        fields: {
          b64: Buffer.from(
            JSON.stringify({
              id: 'call_1',
              name: 'Project.list_threads',
              args: '{}',
            }),
            'utf8',
          ).toString('base64'),
          atMs: '120',
        },
      }),
      true,
    );
    assert.equal(
      appendTranscript(progress, {
        phase: 'tool_result',
        ms: 40,
        fields: {
          b64: Buffer.from(
            JSON.stringify({
              id: 'call_1',
              name: 'Project.list_threads',
              state: 'done',
              result: '[]',
            }),
            'utf8',
          ).toString('base64'),
          atMs: '130',
        },
      }),
      true,
    );
    assert.equal(
      appendTranscript(progress, {
        phase: 'answer_chunk',
        ms: 50,
        fields: {
          b64: Buffer.from('No active worker threads yet.', 'utf8').toString(
            'base64',
          ),
          atMs: '140',
        },
      }),
      true,
    );

    assert.equal(progress.thinking, 'Inspecting workspace layout.');
    assert.equal(progress.answer, 'No active worker threads yet.');
    const toolItem = progress.trajectory.find(item => item.kind === 'tool');
    assert.ok(toolItem);
    assert.equal(toolItem.name, 'Project.list_threads');
    assert.equal(toolItem.state, 'done');
  });

  it('wires spawnProjectAgentRun with auto preset, deterministic session, model override, streaming, activeRun overview, and stop-run IPC', async () => {
    const mainSource = await readFile(
      join(process.cwd(), 'electron', 'main.ts'),
      'utf8',
    );
    const preloadSource = await readFile(
      join(process.cwd(), 'electron', 'preload.ts'),
      'utf8',
    );
    const dataSource = await readFile(
      join(process.cwd(), 'electron', 'renderer', 'data.ts'),
      'utf8',
    );

    const spawnBlock = extractFunctionSlice(
      mainSource,
      'function spawnProjectAgentRun(',
    );

    assert.doesNotMatch(
      spawnBlock,
      /permissionPreset:\s*'default'/,
      'spawnProjectAgentRun must never pass permissionPreset: "default"',
    );
    assert.match(spawnBlock, /permissionPreset:\s*'auto'/);
    assert.match(
      spawnBlock,
      /agentSessionId\s*=\s*input\.threadId[\s\S]*?proj-\$\{input\.project\.id\}-thr-\$\{input\.threadId\}[\s\S]*?proj-\$\{input\.project\.id\}-coordinator/,
    );
    assert.match(spawnBlock, /agentSessionId,/);
    assert.match(
      spawnBlock,
      /coordinatorModel[\s\S]*?workerModel[\s\S]*?resolveModelConfig/,
    );

    assert.match(mainSource, /activeProjectRuns\s*=\s*new Map/);
    assert.match(spawnBlock, /type:\s*'run_started'/);
    assert.match(spawnBlock, /appendTranscript\(progress,\s*record\)/);
    assert.match(spawnBlock, /type:\s*'stream_progress'/);
    assert.match(spawnBlock, /120/);
    assert.match(spawnBlock, /trajectory:\s*progress\.trajectory\.slice\(-24\)/);
    assert.match(spawnBlock, /type:\s*'coordinator_post'/);
    assert.match(spawnBlock, /failedPrompt:\s*input\.question/);
    assert.match(spawnBlock, /type:\s*'run_completed'/);

    const overviewBlock = extractFunctionSlice(
      mainSource,
      "'projects:ma:overview'",
    );
    assert.match(overviewBlock, /activeProjectRuns\.get/);
    assert.match(overviewBlock, /activeRun/);
    assert.match(overviewBlock, /slice\(-24\)/);

    const stopRunBlock = extractFunctionSlice(
      mainSource,
      "'projects:ma:stop-run'",
    );
    assert.match(stopRunBlock, /isDashboardSender\(event\)/);
    assert.match(stopRunBlock, /activeProjectRuns\.get/);
    assert.match(stopRunBlock, /\.kill\?\.\(\)/);
    assert.match(stopRunBlock, /activeProjectRuns\.delete/);
    assert.match(stopRunBlock, /stopped:\s*true/);
    assert.match(stopRunBlock, /type:\s*'run_completed'/);

    assert.match(
      preloadSource,
      /stopRun:\s*\(payload:\s*unknown\)\s*=>\s*ipcRenderer\.invoke\('projects:ma:stop-run',\s*payload\)/,
    );
    assert.match(dataSource, /stopRun\?\(/);
    assert.match(dataSource, /projectsMaStopRun\(/);
    assert.match(dataSource, /bridge\(\)\?\.projectsMa\?\.stopRun/);
  });
});
