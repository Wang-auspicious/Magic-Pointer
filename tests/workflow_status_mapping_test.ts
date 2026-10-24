import test from 'node:test';
import assert from 'node:assert/strict';
import {stepChildSucceeded} from '../electron/runtime/workflow_engine';

test('step success mapping settles completed and needs_verification children', () => {
  assert.equal(stepChildSucceeded('completed'), true);
  assert.equal(stepChildSucceeded('needs_verification'), true);
  assert.equal(stepChildSucceeded('failed'), false);
  assert.equal(stepChildSucceeded('partial'), false);
  assert.equal(stepChildSucceeded('user_interrupt'), false);
  assert.equal(stepChildSucceeded('stalled'), false);
  assert.equal(stepChildSucceeded(''), false);
});
