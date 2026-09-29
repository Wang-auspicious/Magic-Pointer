'use strict';
const assert = require('node:assert/strict');
const { join, sep } = require('node:path');
const physical = require('original-fs').promises;
const { PersonalActivityStore } = require(process.argv[2]);
const root = process.argv[3], observed = join(root, 'observed');

async function run() {
  const store = new PersonalActivityStore(join(root, 'activity'), { enabled: true });
  async function waitFor(predicate) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const rows = (await store.getDay())?.files ?? [];
      if (predicate(rows)) return rows;
      await new Promise(accept => setTimeout(accept, 25));
    }
    assert.fail(`Missing physical filesystem change: ${JSON.stringify(await store.getDay())}`);
  }
  try {
    await store.startFileWatching([observed]);
    const status = await store.getStatus();
    assert.deepEqual(status.watchedRoots, [observed], JSON.stringify(status.errors));
    assert.deepEqual(status.errors, [], 'invalid ASAR bytes must not turn a readable directory into a failed archive');
    const invalid = join(observed, 'invalid.asar');
    await physical.appendFile(invalid, '\nchanged');
    await waitFor(rows => rows.some(row => row.path === invalid && row.kind === 'modified'));
    const validCopy = join(observed, 'copied.asar');
    await physical.copyFile(join(observed, 'valid.asar'), validCopy);
    await waitFor(rows => rows.some(row => row.path === validCopy && row.kind === 'created'));
    const sibling = join(observed, 'notes.txt');
    await physical.appendFile(sibling, '\nafter');
    const rows = await waitFor(rows => rows.some(row => row.path === sibling && row.kind === 'modified'));
    assert.equal(rows.some(row => row.path.includes(`.asar${sep}`)), false, 'archive entries are not physical user files');
    console.log('personal activity: real Electron physical ASAR files and sibling changes passed');
  } finally { await store.close(); }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
