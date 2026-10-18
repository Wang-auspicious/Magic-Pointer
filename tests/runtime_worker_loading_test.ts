import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const execute = promisify(execFile);

for (const frame of [false, true]) {
  test(`snapshot dispatch excludes Agent execution modules (${frame ? 'invalid frozen artifact' : 'no frame'})`, async () => {
    const script = `
      const started = performance.now();
      const {dispatchRuntime} = require('./electron/runtime/worker.ts');
      const imported = performance.now();
      dispatchRuntime('selection_snapshot', ${frame ? "{frameLease:{frameLeaseId:'loading-test',localArtifact:{path:'missing-frozen-loading-test.png'},targetWindow:{}}}" : '{}'}, {
        root:process.cwd(), userDataDir:process.cwd(),
      }).then(result => {
        console.log(JSON.stringify({result, importMs:imported-started, totalMs:performance.now()-started,
          loaded:Object.keys(require.cache).map(file=>file.replaceAll('\\\\','/'))}));
      }).catch(error=>{console.error(error);process.exitCode=1;});
    `;
    const {stdout} = await execute(
      process.execPath,
      ['--require', 'tsx/cjs', '-e', script],
      {
        cwd: process.cwd(),
        timeout: 20000,
        windowsHide: true,
        env: {
          ...process.env,
          MAGIC_POINTER_PLUGIN_DIR: path.join(
            process.cwd(),
            'data',
            'no-loading-test-plugins',
          ),
        },
      },
    );
    const report = JSON.parse(stdout.trim());
    assert.equal(report.result.ok, false);
    assert.equal(
      report.loaded.some((file: string) =>
        file.endsWith('/runtime/desktop_perception.ts'),
      ),
      true,
    );
    const executionModules = [
      'index',
      'fabric_api',
      'fabric',
      'actions_delivery',
      'learning',
      'artifacts',
      'agent',
    ];
    assert.deepEqual(
      report.loaded.filter((file: string) =>
        executionModules.some(name => file.endsWith(`/runtime/${name}.ts`)),
      ),
      [],
      `snapshot loaded unrelated execution code (${Math.round(report.totalMs)}ms, ${report.loaded.length} modules)`,
    );
    console.log(
      JSON.stringify({
        frame,
        importMs: report.importMs,
        totalMs: report.totalMs,
        loadedModules: report.loaded.length,
      }),
    );
  });
}
