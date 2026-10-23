import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {
  synchronizeProjectSettings,
  withProjectSettings,
} from '../electron/runtime/project_settings';

test('new project task receives collected handoffs as data, and removing them removes their context', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mp-resource-handoff-'));
  const session = await EventSession.open(folder, 'handoff-task');
  await session.startTurn();
  try {
    const settings = await synchronizeProjectSettings(session, {
      id: 'paper',
      root: folder,
      name: 'Paper',
      resourceInbox: [
        {
          id: 'r1',
          title: 'Study',
          summary: 'Useful baseline',
          path: join(folder, 'handoff.md'),
        },
      ],
    } as Parameters<typeof synchronizeProjectSettings>[1]);
    const messages = withProjectSettings(
      [{role: 'user', content: 'Continue working', origin: 'instruction'}],
      settings,
    );
    assert.ok(
      messages.some(
        message =>
          message.origin === 'data' &&
          message.content?.includes('Useful baseline'),
      ),
    );
    const cleared = await synchronizeProjectSettings(session, {
      id: 'paper',
      root: folder,
      name: 'Paper',
    });
    assert.ok(
      !withProjectSettings([], cleared).some(message =>
        message.content?.includes('Useful baseline'),
      ),
    );
  } finally {
    await session.endTurn('completed');
  }
});
