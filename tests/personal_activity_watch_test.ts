import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { PersonalActivityStore, type FileActivityChange } from '../electron/personal_activity';

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'mp-activity-watch-'));
  const observed = join(root, 'documents');
  const data = join(observed, 'personal-data');
  await mkdir(observed);
  const existing = join(observed, 'existing.txt');
  await writeFile(existing, 'before');
  const store = new PersonalActivityStore(data, { enabled: true });
  let continuousWrites: NodeJS.Timeout | undefined;
  const events = async (): Promise<FileActivityChange[]> => (await store.getDay())?.files ?? [];
  async function waitFor(predicate: (rows: FileActivityChange[]) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await events();
      if (predicate(rows)) return rows;
      await new Promise((accept) => setTimeout(accept, 30));
    }
    assert.fail(`File watcher did not observe expected filesystem result: ${JSON.stringify(await events())}`);
  }
  try {
    await store.startFileWatching([observed, join(observed, 'missing-root')]);
    assert.deepEqual((await store.getStatus()).watchedRoots, [observed]);
    assert.equal((await store.getStatus()).errors.length, 1);
    assert.deepEqual(await events(), [], 'baseline files are not today\'s new files');
    await appendFile(existing, '\nafter');
    await waitFor((rows) => rows.some((row) => row.kind === 'modified' && row.path === existing));
    const added = join(observed, 'new.txt');
    await writeFile(added, 'new data');
    await waitFor((rows) => rows.some((row) => row.kind === 'created' && row.path === added));
    const renamed = join(observed, 'renamed.txt');
    await rename(added, renamed);
    await waitFor((rows) => rows.some((row) => row.kind === 'renamed' && row.path === renamed && row.previousPath === added));
    await rm(renamed);
    await waitFor((rows) => rows.some((row) => row.kind === 'deleted' && row.path === renamed));
    const nested = join(observed, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'nested.txt'), 'nested');
    await waitFor((rows) => rows.some((row) => row.kind === 'created' && row.path === join(nested, 'nested.txt')));
    await store.recordKeyboardBatch({ at: new Date().toISOString(), counts: { Enter: 1 } });
    const beforePause = await events();
    assert.equal(beforePause.some((row) => row.path.startsWith(data)), false, 'own data writes must not feed back into file activity');
    await store.setPaused(true);
    await appendFile(existing, '\nwhile paused');
    await store.setPaused(false);
    assert.deepEqual(await events(), beforePause, 'resume must baseline again rather than invent events during a recording gap');
    await appendFile(existing, '\nresumed');
    await waitFor((rows) => rows.filter((row) => row.path === existing && row.kind === 'modified').length === 2);
    const facts = await store.getFacts();
    assert.equal(facts.fileCounts.renamed, 1);
    assert.equal(facts.fileCounts.created, 2);
    assert.match((await store.getReport()).markdown, /existing\.txt/);
    const beforeContinuous = (await events()).filter(row => row.path === existing).length;
    continuousWrites = setInterval(() => { void appendFile(existing, '\nstill saving'); }, 35);
    await waitFor(rows => rows.filter(row => row.path === existing).length > beforeContinuous);
    clearInterval(continuousWrites); continuousWrites = undefined;
  } finally {
    if (continuousWrites) clearInterval(continuousWrites);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
  await inaccessibleChildDoesNotDisableRoot();
  await baselineDoesNotSerializeOrRepeat();
  console.log(`personal file activity real ${process.platform} filesystem watch passed`);
}

async function baselineDoesNotSerializeOrRepeat() {
  const root = await mkdtemp(join(tmpdir(), 'mp-activity-baseline-'));
  const observed = join(root, 'documents');
  await mkdir(observed);
  await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(join(observed, `note-${index}.txt`), 'existing')));
  const fileIO = require('node:fs/promises') as typeof import('node:fs/promises');
  const originalStat = fileIO.lstat, originalRead = fileIO.readdir;
  let rootReads = 0;
  const reads = mock.method(fileIO, 'readdir', (directory: unknown, ...args: unknown[]) => {
    if (String(directory) === observed) rootReads++;
    return Reflect.apply(originalRead, fileIO, [directory, ...args]);
  });
  const stats = mock.method(fileIO, 'lstat', async (path: unknown, ...args: unknown[]) => {
    if (String(path).startsWith(observed) && String(path).endsWith('.txt')) await new Promise(accept => setTimeout(accept, 10));
    return Reflect.apply(originalStat, fileIO, [path, ...args]);
  });
  const store = new PersonalActivityStore(join(root, 'activity'), { enabled: true });
  try {
    const start = performance.now();
    await store.startFileWatching([observed]);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 350, `baseline serialized eighty independent 10 ms file reads (${Math.round(elapsed)} ms)`);
    assert.equal(rootReads, 1);
    await store.startFileWatching([observed]);
    assert.equal(rootReads, 1, 'a service synchronization with unchanged roots must not repeat the directory baseline');
    console.log(`personal baseline: eighty delayed file metadata reads in ${Math.round(elapsed)} ms; unchanged roots did not rescan`);
  } finally {
    stats.mock.restore(); reads.mock.restore(); await store.close(); await rm(root, { recursive: true, force: true });
  }
}

async function inaccessibleChildDoesNotDisableRoot() {
  const root = await mkdtemp(join(tmpdir(), 'mp-activity-partial-'));
  const observed = join(root, 'documents'), blocked = join(observed, 'restricted'), readable = join(observed, 'notes.txt');
  await mkdir(blocked, { recursive: true });
  await writeFile(readable, 'before');
  const fileIO = require('node:fs/promises') as typeof import('node:fs/promises');
  const original = fileIO.readdir;
  const read = mock.method(fileIO, 'readdir', (directory: unknown, ...args: unknown[]) => {
    if (String(directory) === blocked) throw Object.assign(new Error(`EPERM: scandir '${blocked}'`), { code: 'EPERM' });
    return Reflect.apply(original, fileIO, [directory, ...args]);
  });
  const store = new PersonalActivityStore(join(root, 'activity'), { enabled: true });
  try {
    await store.startFileWatching([observed]);
    const status = await store.getStatus();
    assert.deepEqual(status.watchedRoots, [observed], 'one inaccessible child must not disable all readable files in the selected root');
    assert.ok(status.errors.some(error => error.path === blocked && error.message.includes('EPERM')), 'the skipped child must remain an explicit coverage gap');
    await appendFile(readable, '\nafter');
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !(await store.getDay())?.files.some(file => file.path === readable && file.kind === 'modified')) {
      await new Promise(accept => setTimeout(accept, 30));
    }
    assert.ok((await store.getDay())?.files.some(file => file.path === readable && file.kind === 'modified'), 'readable sibling changes must still be observed');
  } finally {
    read.mock.restore(); await store.close(); await rm(root, { recursive: true, force: true });
  }
}
void run().catch((error) => { console.error(error); process.exitCode = 1; });
