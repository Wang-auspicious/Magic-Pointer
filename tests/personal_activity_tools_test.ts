import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalActivityStore } from '../electron/personal_activity';
import { registerMemoryTools } from '../electron/runtime/agent_services';
import { EventSession } from '../electron/runtime/session';
import { ToolRegistry } from '../electron/runtime/tools';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'mp-personal-tools-'));
  const activity = join(directory, 'personal-activity');
  const store = new PersonalActivityStore(activity, { enabled: true });
  try {
    await store.open();
    await store.recordKeyboardBatch({ at: '2026-09-29T08:00:00Z', counts: { Enter: 27 } });
    const before = await readFile(join(activity, 'state.json'), 'utf8');
    const registry = new ToolRegistry();
    registerMemoryTools(registry, directory, { id: 'test-session', events: [] } as unknown as EventSession);
    const result = await registry.execute({ id: 'personal-read', name: 'Activity.read', arguments: { date: '2026-09-29' } });
    assert.equal(result.is_error, false, 'the MP runtime can answer personal activity questions through its own tool');
    assert.match(JSON.stringify(result.value), /Enter.*27/);
    assert.equal(await readFile(join(activity, 'state.json'), 'utf8'), before, 'reading personal context must not fabricate a recorder restart gap');
    await store.updateSettings({ screenEnabled: true });
    await mkdir(join(activity, 'screens'), { recursive: true });
    const screenshot = join(activity, 'screens', 'privacy.jpg');
    await writeFile(screenshot, 'local retained image');
    await store.recordScreen({ at: '2026-09-29T08:00:00Z', appId: 'editor', title: 'Local', path: screenshot, text: 'retained text', usedBackend: 'test' });
    const imageRead = await registry.execute({ id: 'image-read', name: 'Activity.read', arguments: { date: '2026-09-29', section: 'screens', screen_index: 0 } });
    assert.equal(imageRead.is_error, false);
    assert.equal((imageRead.value as any).image, undefined, 'personal memory must honor the existing disabled screenshot upload setting');
    await store.updateSettings({ enabled: false });
    const denied = await registry.execute({ id: 'disabled-read', name: 'Activity.read', arguments: { date: '2026-09-29' } });
    assert.equal(denied.is_error, true, 'turning off personal context must stop future model access');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  console.log('personal context runtime reads real local facts and honors disabled state');
}
void main();
