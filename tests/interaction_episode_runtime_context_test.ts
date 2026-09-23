import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTaskContext } from '../electron/runtime/context_prepare';
import { authorizeAccess, resolveSource, scopeFromEvents, taskReferences } from '../electron/runtime/context';
import { EventSession } from '../electron/runtime/session';
import { ToolRegistry } from '../electron/runtime/tools';

const { InteractionEpisodeStore } = require('../electron/interaction_episode');

test('A then B remains two readable, sourced objects when comparing the latest selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-episode-context-'));
  const session = await EventSession.open(root, 'agent-studio-new-episode-comparison');
  const store = new InteractionEpisodeStore();
  const a = {
    snapshotId: 'snap-a', content: 'Alpha is 12', app: 'browser', windowTitle: 'Research A',
    capturedAt: '2026-09-23T10:00:00.000Z', frameLeaseId: 'frame-a',
    source: { app: 'browser', title: 'Research A', url: 'https://example.test/a', hwnd: 41, processId: 4 },
  };
  const b = {
    snapshotId: 'snap-b', content: 'Beta is 19', app: 'notepad', windowTitle: 'Notes B',
    capturedAt: '2026-09-23T10:01:00.000Z', frameLeaseId: 'frame-b',
    source: { app: 'notepad', title: 'Notes B', hwnd: 42, processId: 5 },
  };
  store.bindPointedObject(a);
  store.labelCurrent('A');
  store.bindCommandTarget(a, '记住 A', { taskId: 'agent-earlier', role: 'target' });
  store.bindPointedObject(b);
  store.labelCurrent('B');
  store.bindCommandTarget(b, '比较 A 和 B', { taskId: session.id, role: 'target' });
  const registry = new ToolRegistry();
  await prepareTaskContext(session, {
    command: '比较 A 和 B', windows: [{ title: 'Unrelated' }],
    interactionEpisode: store.contextPayload(),
    selectionSnapshot: {
      snapshot_id: 'snap-b', captured_at: b.capturedAt,
      context: { app: 'notepad', content: b.content, label: 'Notes B', window: { hwnd: 42, pid: 5, title: 'Notes B', process_name: 'notepad' } },
      source_window: { hwnd: 42, pid: 5, title: 'Notes B', process_name: 'notepad' },
    },
  }, { root, userDataDir: root, registry });

  const sourceA = resolveSource(session.events, 'A');
  const sourceB = resolveSource(session.events, 'B');
  assert.equal(sourceA.identity.content, 'Alpha is 12');
  assert.equal(sourceA.identity.url, 'https://example.test/a');
  assert.equal(sourceA.identity.windowTitle, 'Research A');
  assert.equal(sourceA.revision.authority, 'historical');
  assert.equal(sourceB.identity.content, 'Beta is 19');
  assert.equal(sourceB.sourceId, 'source:selection:snap-b');
  assert.equal(taskReferences(session.events).find(ref => ref.label === 'A')?.role, 'source');
  assert.equal(taskReferences(session.events).find(ref => ref.label === 'B')?.role, 'target');
  const read = await registry.execute({ id: 'read-a', name: 'Context.read', arguments: { source_id: 'A' } });
  assert.equal(read.is_error, false, read.error_message);
  assert.equal((read.value as { fragments: { text: string }[] }).fragments[0]?.text, 'Alpha is 12');
  const scope = scopeFromEvents(session.events, session.id);
  assert.equal(authorizeAccess(scope, { action: 'patch', windowIds: ['w-41'] }).allowed, false);
  assert.equal(authorizeAccess(scope, { action: 'patch', windowIds: ['w-42'] }).allowed, true);
});
