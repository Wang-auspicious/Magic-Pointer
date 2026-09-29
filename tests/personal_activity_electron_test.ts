import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPackage } from '@electron/asar';

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'mp-activity-electron-'));
  try {
    const source = join(root, 'archive-source'), observed = join(root, 'observed');
    await mkdir(source); await mkdir(observed);
    await writeFile(join(source, 'inside.txt'), 'archive content must not become a physical child path');
    await createPackage(source, join(observed, 'valid.asar'));
    await writeFile(join(observed, 'invalid.asar'), 'an ordinary user file, not an archive');
    await writeFile(join(observed, 'notes.txt'), 'before');
    const child = spawnSync(require('electron') as string, [
      resolve('tests/fixtures/personal_activity_asar_fixture.cjs'),
      resolve('build/electron/personal_activity.js'), root,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /physical ASAR files and sibling changes passed/);
    console.log(child.stdout.trim());
  } finally { await rm(root, { recursive: true, force: true }); }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
