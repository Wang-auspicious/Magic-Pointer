'use strict';

const assert = require('assert');
const { agentSessionId, studioConversationSessionId } = require('../electron/agent_session_id');

assert.strictEqual(agentSessionId('abc-123'), 'agent-abc-123');

const weird = `token with spaces/${'x'.repeat(200)}`;
const first = agentSessionId(weird);
const second = agentSessionId(weird);
assert.strictEqual(first, second);
assert.ok(first.startsWith('agent-'));
assert.ok(!first.includes(' '));
assert.ok(first.length < 80);

assert.strictEqual(
  studioConversationSessionId({ existing: 'agent-studio-new-kept', conversationId: 'c1' }),
  'agent-studio-new-kept',
  'a conversation must keep the durable session already recorded on the thread',
);
assert.match(
  studioConversationSessionId({ existing: '', conversationId: 'c-existing' }),
  /^agent-studio-conv-[a-f0-9]{32}$/,
);
assert.strictEqual(
  studioConversationSessionId({ existing: '', conversationId: '', idFactory: () => 'abc-def' }),
  'agent-studio-new-abcdef',
  'the first Studio turn needs a session identity before Python receives TaskInput',
);

console.log('agent session id test ok');
