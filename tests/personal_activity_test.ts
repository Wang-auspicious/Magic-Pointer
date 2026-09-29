import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalActivityStore } from '../electron/personal_activity';

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'mp-personal-activity-'));
  let now = new Date(2026, 8, 29, 23, 59, 40).getTime();
  let store = new PersonalActivityStore(root, { enabled: true, now: () => now });
  try {
    await store.open();
    const from = new Date(now).toISOString();
    now += 10_000;
    await store.recordBatch({
      at: from, from, to: new Date(now).toISOString(),
      keyboard: { Enter: 3, KeyA: 8 },
      applications: [{ appId: 'word', label: 'Word', activeMs: 8_000, activations: 1 }],
      coverage: { activeMs: 8_000, idleMs: 2_000, lockedMs: 0, unavailableMs: 0 },
      usedBackend: 'windows.raw-input',
    });
    assert.equal((await store.getDay('2026-09-29'))?.keyboard.Enter, 3);
    assert.equal((await store.getDay('2026-09-29'))?.applications[0].activeMs, 8_000);
    const initialStart = (await store.getStatus()).startedAt;
    await store.close();
    now = new Date(2026, 8, 30, 0, 1, 0).getTime();
    store = new PersonalActivityStore(root, { enabled: true, now: () => now });
    await store.recordKeyboardBatch({ at: new Date(now).toISOString(), counts: { Enter: 2 } });
    assert.deepEqual(await store.listDays(), ['2026-09-30', '2026-09-29']);
    assert.equal((await store.getDay('2026-09-29'))?.keyboard.Enter, 3);
    assert.equal((await store.getDay('2026-09-30'))?.keyboard.Enter, 2);
    assert.equal((await store.getStatus()).startedAt, initialStart);
    assert.equal((await store.getStatus()).gaps[0].reason, 'not_running');
    const report = await store.getReport('2026-09-29');
    assert.match(report.markdown, /Enter.*3/);
    assert.match(report.markdown, /记录范围/);
    assert.match(report.markdown, /应用未运行/);
    assert.equal(report.day?.keyboard.KeyA, 8);
    const facts = await store.getFacts();
    assert.equal(facts.keyboard.Enter, 5);
    assert.equal(facts.observedDays, 2);
    assert.equal(facts.applications[0].activeMs, 8_000);
    const persisted = await readFile(join(root, 'days', '2026-09-29.json'), 'utf8');
    assert.equal(persisted.includes('sequence'), false);
    assert.equal(persisted.includes('keyEvents'), false);
    assert.equal((await readdir(join(root, 'days'))).length, 2);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
  await pauseScreensAndReadonly();
  console.log('personal activity daily persistence, facts, pause, screenshots and readonly passed');
}

async function pauseScreensAndReadonly() {
  const root = await mkdtemp(join(tmpdir(), 'mp-personal-control-'));
  let now = new Date(2026, 8, 29, 12, 0).getTime();
  const store = new PersonalActivityStore(root, { enabled: true, now: () => now });
  try {
    await store.updateSettings({ screenEnabled: true, reportTime: '21:30', retentionDays: 1 });
    await store.recordKeyboardBatch({ at: new Date(now).toISOString(), counts: { Enter: 4 } });
    await mkdir(join(root, 'screens'), { recursive: true });
    const imagePath = join(root, 'screens', 'sample.png');
    await writeFile(imagePath, 'retained image');
    const fullText = 'A decision about the budget\n' + '保留的正文。'.repeat(700) + '\nLater agreement 7392';
    await store.recordScreen({ at: new Date(now).toISOString(), appId: 'word', title: 'Meeting', path: imagePath, text: fullText, usedBackend: 'gdi-window' });
    assert.equal((await store.searchScreens('budget')).length, 1);
    assert.equal((await store.searchScreens('Later agreement 7392')).length, 1, 'the retained OCR must remain searchable beyond an initial excerpt');
    const summary = await store.getDaySummary('2026-09-29');
    assert.equal(summary?.screenCount, 1);
    assert.equal(summary?.keyboard.Enter, 4);
    assert.equal(summary && 'screens' in summary, false, 'summary consumers must not receive the screen archive');
    await store.recordKeyboardBatch({ at: new Date(now).toISOString(), counts: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`Key${index}`, index + 1])) });
    const brief = await store.getReport('2026-09-29');
    assert.ok(brief.markdown.length < 1000, 'a daily brief must stay readable instead of listing every key and event');
    assert.match(brief.markdown, /budget/, 'screen evidence should give the brief concrete work context');
    await store.setPaused(true);
    now += 60_000;
    assert.equal(await store.recordKeyboardBatch({ at: new Date(now).toISOString(), counts: { Enter: 99 } }), false);
    assert.equal((await store.getStatus()).recording, false);
    await store.setPaused(false);
    assert.equal((await store.getStatus()).gaps[0].to, new Date(now).toISOString());
    const stateBefore = await readFile(join(root, 'state.json'), 'utf8');
    const reader = new PersonalActivityStore(root, { readonly: true, now: () => now + 60_000 });
    assert.equal((await reader.getFacts()).keyboard.Enter, 4);
    assert.equal((await reader.getDay('2026-09-29'))?.screens[0].text, fullText);
    await reader.close();
    assert.equal(await readFile(join(root, 'state.json'), 'utf8'), stateBefore, 'reading evidence must not manufacture a lifecycle gap');
    now = new Date(2026, 9, 1, 12, 0).getTime();
    await store.pruneDetails();
    assert.equal((await store.getDay('2026-09-29'))?.screens.length, 0);
    assert.equal((await store.getDay('2026-09-29'))?.screenCount, 1);
    assert.equal((await store.getFacts()).keyboard.Enter, 4, 'objective day totals survive detailed evidence retention');
    await assert.rejects(readFile(imagePath), { code: 'ENOENT' });
    await store.clearHistory();
    assert.deepEqual(await store.listDays(), []);
    assert.equal((await store.getFacts()).keyboard.Enter, undefined);
    assert.equal((await store.getStatus()).reportTime, '21:30');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
void run().catch((error) => { console.error(error); process.exitCode = 1; });
