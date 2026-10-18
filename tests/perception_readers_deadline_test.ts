import assert from 'node:assert/strict';
import test from 'node:test';
import {closeDesktop} from '../electron/runtime/desktop';
import {captureSnapshot} from '../electron/runtime/desktop_perception';
import {resolveSelection, type AdapterContext} from '../electron/runtime/desktop_adapters';
test.afterEach(() => closeDesktop());

test('a cancelled capture does not report a broken historical frame', async () => {
  const controller = new AbortController();
  controller.abort(new Error('user_cancelled_capture'));
  await assert.rejects(captureSnapshot({}, controller.signal), /user_cancelled_capture/);
});

test('production selection fusion keeps the completed reader and names the timed out reader', async () => {
  const window = {hwnd: 42, pid: 7, title: 'Fixture', process_name: 'fixture', bbox: [0, 0, 100, 100]};
  const progress: string[] = [];
  const good: AdapterContext = {adapter: 'uia', app: 'fixture', window, content: '120', method: 'fixture.uia', artifacts: {}};
  const result = await resolveSelection(window, {}, undefined, {
    onProgress: event => progress.push(`${event.provider}:${event.state}`),
    providers: [
      {id: 'uia', softDeadlineMs: 10, hardDeadlineMs: 40, read: async () => good},
      {id: 'office', softDeadlineMs: 10, hardDeadlineMs: 40, read: () => new Promise<AdapterContext>(() => {})},
    ],
  });
  assert.equal(result[0].content, '120');
  assert.equal(result[0].adapter, 'uia');
  assert.equal(result[1].adapter, 'office');
  assert.equal(result[1].evidenceStatus, 'timeout');
  assert.match(result[1].error!, /perception_provider_timeout:office/);
  assert.ok(result.every(context => typeof context.latencyMs === 'number'));
  assert.ok(progress.includes('office:slow'));
  assert.ok(progress.includes('office:timeout'));
});
