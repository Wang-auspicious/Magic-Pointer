'use strict';

const assert = require('node:assert');
const { conversationFailureMessage } = require('../electron/conversation_error');

assert.equal(
  conversationFailureMessage({ ok: false, error: 'bridge_no_output', code: 0 }),
  'Agent 桥接进程已退出，但没有写出结果（bridge_no_output，exit 0）。',
);
assert.equal(
  conversationFailureMessage({ ok: false, error: 'provider_unavailable' }),
  '模型服务当前不可用（provider_unavailable）。',
);
assert.equal(
  conversationFailureMessage({ ok: true, answer: '' }),
  '模型回合完成，但 answer 字段为空（empty_answer）。',
);
assert.equal(
  conversationFailureMessage({ ok: false, error: '上游返回 429' }),
  '上游返回 429',
);

console.log('conversation error test ok');
