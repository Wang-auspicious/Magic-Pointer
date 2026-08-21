'use strict';

const assert = require('assert');
const { agentSessionId } = require('../electron/agent_session_id');

assert.strictEqual(agentSessionId('abc-123'), 'agent-abc-123');

const weird = `token with spaces/${'x'.repeat(200)}`;
const first = agentSessionId(weird);
const second = agentSessionId(weird);
assert.strictEqual(first, second);
assert.ok(first.startsWith('agent-'));
assert.ok(!first.includes(' '));
assert.ok(first.length < 80);

console.log('agent session id test ok');
