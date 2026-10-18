import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

for (const hanging of [false, true]) {
  test(
    `snapshot worker ${hanging ? 'bounds an uncooperative plugin' : 'finishes cooperative cleanup'} after flushing its result`,
    {timeout: 30000},
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'mp-snapshot-cleanup-'),
      );
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const folder = path.join(root, 'data', 'plugins', 'cleanup');
        const marker = path.join(root, 'disposed.txt');
        const ticks = path.join(root, 'ticks.txt');
        await mkdir(folder, {recursive: true});
        await writeFile(
          path.join(folder, 'plugin.json'),
          JSON.stringify({main: 'plugin.cjs'}),
        );
        await writeFile(
          path.join(folder, 'plugin.cjs'),
          `module.exports={name:'cleanup',scopes:['surface'],apply(ctx){ctx.effect(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'disposed'));${hanging ? `void ctx.run(async()=>{setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(ticks)},'.'),20);await new Promise(()=>{});});` : ''}}};`,
        );
        child = spawn(
          process.execPath,
          [
            '--require',
            'tsx/cjs',
            path.join(process.cwd(), 'electron/runtime/worker.ts'),
            'selection_snapshot',
          ],
          {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              MAGIC_POINTER_USER_DATA_DIR: root,
              MAGIC_POINTER_PLUGIN_DIR: path.dirname(folder),
            },
          },
        );
        let stdout = '';
        let stderr = '';
        let deadlineFired = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        child.stdout!.on('data', chunk => {
          stdout += String(chunk);
        });
        child.stderr!.on('data', chunk => {
          stderr += String(chunk);
          if (!deadline && stderr.includes('phase=runtime_ready'))
            deadline = setTimeout(() => {
              deadlineFired = true;
              child!.kill('SIGKILL');
            }, 2500);
        });
        child.stdin!.end(
          JSON.stringify({
            root: process.cwd(),
            frameLease: {
              frameLeaseId: 'cleanup-test',
              localArtifact: {path: path.join(root, 'missing.png')},
              targetWindow: {},
            },
          }),
        );
        const exit = await new Promise<number | null>((resolve, reject) => {
          child!.once('error', reject);
          child!.once('exit', resolve);
        });
        if (deadline) clearTimeout(deadline);
        assert.equal(
          deadlineFired,
          false,
          `snapshot completion was held by plugin cleanup: ${stderr}`,
        );
        assert.equal(exit, 0);
        const result = JSON.parse(stdout.trim());
        assert.equal(
          result.ok,
          false,
          'invalid source must remain an honest capture failure',
        );
        assert.match(stderr, /phase=snapshot_cleanup/);
        if (hanging) {
          assert.match(stderr, /state=timeout/);
          await assert.rejects(readFile(marker));
          const after = await readFile(ticks, 'utf8');
          await new Promise(resolve => setTimeout(resolve, 80));
          assert.equal(
            await readFile(ticks, 'utf8'),
            after,
            'plugin activity must stop with its isolated worker',
          );
        } else {
          assert.match(stderr, /state=completed/);
          assert.equal(await readFile(marker, 'utf8'), 'disposed');
        }
      } finally {
        child?.kill('SIGKILL');
        await rm(root, {recursive: true, force: true});
      }
    },
  );
}
