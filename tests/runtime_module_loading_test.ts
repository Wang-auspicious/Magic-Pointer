import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';

const execute = promisify(execFile);

test('listing real session module panels does not load Agent or Fabric execution', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mp-module-loading-'));
  try {
    const session = await EventSession.open(folder, 'agent-module-loading');
    await session.append('plan/updated', {
      plan: [{content: 'Read the saved task', status: 'pending'}],
    });
    const script = `
      const start = performance.now();
      const {dispatchRuntime} = require('./electron/runtime/worker.ts');
      dispatchRuntime('fabric', {operation:'modules.list',sessionId:'agent-module-loading'},
        {root:process.cwd(),userDataDir:process.env.MP_TEST_USER_DATA}).then(result=>{
          console.log(JSON.stringify({result,totalMs:performance.now()-start,
            loaded:Object.keys(require.cache).map(file=>file.replaceAll('\\\\','/'))}));
        }).catch(error=>{console.error(error);process.exitCode=1});
    `;
    const {stdout} = await execute(
      process.execPath,
      ['--require', 'tsx/cjs', '-e', script],
      {
        windowsHide: true,
        timeout: 20000,
        env: {
          ...process.env,
          MP_TEST_USER_DATA: folder,
          MAGIC_POINTER_PLUGIN_DIR: path.join(folder, 'plugins'),
        },
      },
    );
    const report = JSON.parse(stdout.trim());
    assert.equal(report.result.ok, true, report.result.error);
    assert.ok(
      report.result.modules.some(
        (module: {id: string}) => module.id === 'task-context',
      ),
    );
    assert.ok(JSON.stringify(report.result).includes('Read the saved task'));
    assert.equal(
      report.loaded.some((file: string) =>
        file.includes('/node_modules/exceljs/'),
      ),
      false,
      `listing saved panels loaded the XLSX parser (${Math.round(report.totalMs)}ms, ${report.loaded.length} modules)`,
    );
    const excluded = [
      'agent',
      'index',
      'fabric',
      'workflow',
      'actions_delivery',
      'learning',
      'artifacts',
    ];
    assert.deepEqual(
      report.loaded.filter((file: string) =>
        excluded.some(name => file.endsWith(`/runtime/${name}.ts`)),
      ),
      [],
      `module panel listing loaded execution code (${Math.round(report.totalMs)}ms, ${report.loaded.length} modules)`,
    );
    console.log(
      JSON.stringify({
        totalMs: report.totalMs,
        loadedModules: report.loaded.length,
      }),
    );
  } finally {
    await rm(folder, {recursive: true, force: true});
  }
});
