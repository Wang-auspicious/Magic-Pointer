import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {runAgent} from '../electron/runtime/agent';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';

test('a final answer ends the turn without a synthetic verification task or footer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-completion-'));
  const session = await EventSession.open(root, 'image-response');
  const registry = new ToolRegistry();
  registry.register({
    name: 'Bash',
    description: 'Shell process',
    input_schema: {type: 'object', properties: {}, required: []},
    effect: 'local_irreversible',
    execute: () => ({exit: 0, stdout: '2400x2400', stderr: ''}),
  });
  let requests = 0;
  const answer = '![Earthrise](https://example.test/earthrise.jpg)';
  const result = await runAgent({
    userDataDir: root,
    session,
    registry,
    permissionMode: 'bypass',
    model: async () =>
      ++requests === 1
        ? {
            text: '',
            tool_calls: [{id: 'probe-image', name: 'Bash', arguments: {}}],
          }
        : {text: answer, tool_calls: []},
  });
  assert.equal(
    requests,
    2,
    'a final response must not trigger another model request',
  );
  assert.equal(
    result.message,
    answer,
    'the harness must preserve the actual answer',
  );
  assert.equal(
    result.receipt.status,
    'unverified',
    'retain evidence limits in the receipt',
  );
  assert.equal(
    session.events.some(
      event =>
        event.type === 'user/message' &&
        String((event.data.message as {content?: string})?.content).includes(
          '未核对的交付',
        ),
    ),
    false,
  );
});
