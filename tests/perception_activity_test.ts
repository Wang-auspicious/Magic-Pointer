import assert from 'node:assert/strict';
import test from 'node:test';
import {updatePerceptionActivity, type PerceptionActivity} from '../electron/perception_activity';

test('live perception retires prior gestures and keeps independent reader outcomes', () => {
  const initial: PerceptionActivity = {token: 'current', state: 'reading', providers: []};
  const good = updatePerceptionActivity(initial, 'current', {provider: 'uia', state: 'fulfilled', latencyMs: 120});
  const partial = updatePerceptionActivity(good, 'current', {provider: 'office', state: 'timeout', latencyMs: 8000, error: 'com_timeout'});
  assert.equal(partial.providers.length, 2);
  assert.equal(partial.providers[0].state, 'fulfilled');
  assert.equal(updatePerceptionActivity(partial, 'previous', {provider: 'uia', state: 'reading', latencyMs: 0}), partial);
  const finished: PerceptionActivity = {...partial, state: 'ready'};
  assert.equal(updatePerceptionActivity(finished, 'current', {provider: 'office', state: 'fulfilled', latencyMs: 9000}), finished);
});
