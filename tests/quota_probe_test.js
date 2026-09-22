'use strict';


const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const built = path.resolve('build/electron/quota_probe.js');
const builtCheck = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', built], { encoding: 'utf8' });
assert.strictEqual(builtCheck.status, 0,
  `run \`npm run build:electron\` first: ${builtCheck.stderr}`);

const { QUOTA_ADAPTERS, hostOf, originOf, probeQuota, quotaAdapterFor } = require(built);

const adapter = (id) => QUOTA_ADAPTERS.find((entry) => entry.id === id);
assert(adapter('deepseek'), 'deepseek adapter must exist');
assert(adapter('openrouter'), 'openrouter adapter must exist');
assert(adapter('moonshot'), 'moonshot adapter must exist');
assert(adapter('opencode-go'), 'opencode-go adapter must exist');


assert.strictEqual(quotaAdapterFor({ provider: 'api.deepseek.com', baseUrl: 'https://api.deepseek.com/v1' })?.id,
  'deepseek', 'a deepseek base URL must resolve without the provider field saying so');
assert.strictEqual(quotaAdapterFor({ provider: 'opencode.ai', baseUrl: 'https://opencode.ai/zen/go/v1' })?.id,
  'opencode-go');
assert.strictEqual(quotaAdapterFor({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }), null,
  'no adapter means no rows; a guessed quota is worse than an absent one');
assert.strictEqual(quotaAdapterFor({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiMode: 'local' }), null,
  'a local runtime has no account behind it');
assert.strictEqual(quotaAdapterFor(null), null);


assert.strictEqual(adapter('deepseek').url('https://api.deepseek.com', 'api.deepseek.com'),
  'https://api.deepseek.com/user/balance');
assert.strictEqual(adapter('openrouter').url('https://openrouter.ai', 'openrouter.ai'),
  'https://openrouter.ai/api/v1/key');
assert.strictEqual(adapter('moonshot').url('https://api.moonshot.cn', 'api.moonshot.cn'),
  'https://api.moonshot.cn/v1/users/me/balance');
assert.strictEqual(adapter('opencode-go').url('https://opencode.ai', 'opencode.ai'),
  'https://opencode.ai/zen/go/v1/usage');

assert.strictEqual(hostOf('https://api.deepseek.com/v1'), 'api.deepseek.com');
assert.strictEqual(hostOf('not a url'), '');
assert.strictEqual(originOf('https://api.deepseek.com/v1'), 'https://api.deepseek.com');


const deepseekRows = adapter('deepseek').parse({
  is_available: true,
  balance_infos: [{
    currency: 'CNY',
    total_balance: '110.00',
    granted_balance: '10.00',
    topped_up_balance: '100.00',
  }],
}, 'api.deepseek.com');
assert.strictEqual(deepseekRows.length, 1);
assert.strictEqual(deepseekRows[0].label, '余额 (CNY)');
assert.strictEqual(deepseekRows[0].value, '¥110.00',
  'the amount is already a string in the documented shape; reformatting it through a float would round it');
assert.strictEqual(deepseekRows[0].percent, null, 'a balance is not a percentage');
assert.match(deepseekRows[0].detail, /充值 ¥100\.00/);
assert.match(deepseekRows[0].detail, /赠送 ¥10\.00/);

assert.deepStrictEqual(adapter('deepseek').parse({ is_available: false, balance_infos: [] }, 'api.deepseek.com'), []);
assert.deepStrictEqual(adapter('deepseek').parse({ nope: 1 }, 'api.deepseek.com'), []);
assert.deepStrictEqual(adapter('deepseek').parse(null, 'api.deepseek.com'), []);


const capped = adapter('openrouter').parse({
  data: { limit: 100, limit_remaining: 62.5, usage: 37.5, usage_weekly: 4.25, usage_monthly: 18.75 },
}, 'openrouter.ai');
assert.strictEqual(capped[0].value, '$62.50 / $100.00');
assert.strictEqual(capped[0].percent, 38, '37.5 of 100 rounds to 38');
assert.deepStrictEqual(capped.map((row) => row.label), ['额度', '本周', '本月']);

const uncapped = adapter('openrouter').parse({
  data: { limit: null, usage: 12.5, is_free_tier: true },
}, 'openrouter.ai');
assert.strictEqual(uncapped[0].label, '已用');
assert.strictEqual(uncapped[0].value, '$12.50');
assert.strictEqual(uncapped[0].percent, null,
  'no cap means no denominator; drawing a bar would invent one');
assert.strictEqual(uncapped[0].detail, '免费额度');

assert.deepStrictEqual(adapter('openrouter').parse({ data: { usage: 'abc' } }, 'openrouter.ai'), []);


const moonshotCn = adapter('moonshot').parse({
  code: 0,
  data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
  status: true,
}, 'api.moonshot.cn');
assert.strictEqual(moonshotCn[0].value, '¥49.59');
assert.match(moonshotCn[0].detail, /现金 ¥3\.00/);
assert.match(moonshotCn[0].detail, /代金券 ¥46\.59/);

const moonshotIntl = adapter('moonshot').parse(
  { code: 0, data: { available_balance: 12, voucher_balance: 0, cash_balance: 12 } },
  'api.moonshot.ai',
);
assert.strictEqual(moonshotIntl[0].value, '$12.00', 'the international host bills in USD');

assert.deepStrictEqual(adapter('moonshot').parse({ code: 0, data: {} }, 'api.moonshot.cn'), []);


const opencode = adapter('opencode-go').parse({
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-09-17T12:30:00Z' },
    weekly: { status: 'ok', percent: 37, resetsAt: '2026-09-20T00:00:00Z' },
    monthly: { status: 'ok', percent: 61, resetsAt: '2026-10-01T00:00:00Z' },
  },
}, 'opencode.ai');
assert.deepStrictEqual(opencode.map((row) => row.label), ['5 小时', '本周', '本月'],
  'the plan is described as 5-hour / week / month windows');
assert.deepStrictEqual(opencode.map((row) => row.value), ['4%', '37%', '61%']);
assert.deepStrictEqual(opencode.map((row) => row.percent), [4, 37, 61]);
assert.ok(opencode.every((row) => row.detail.includes('重置')),
  'a window without a reset time is not actionable');

const clamped = adapter('opencode-go').parse({ usage: { rolling: { percent: 140 } } }, 'opencode.ai');
assert.strictEqual(clamped[0].percent, 100);
const negative = adapter('opencode-go').parse({ usage: { rolling: { percent: -3 } } }, 'opencode.ai');
assert.strictEqual(negative[0].percent, 0);

assert.deepStrictEqual(adapter('opencode-go').parse({ usage: {} }, 'opencode.ai'), []);
assert.deepStrictEqual(adapter('opencode-go').parse({}, 'opencode.ai'), []);


const fakeResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

(async () => {
  const ok = await probeQuota({
    provider: 'api.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    credential: 'sk-test',
    fetchImpl: async () => fakeResponse(200, {
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '7.00', granted_balance: '', topped_up_balance: '' }],
    }),
  });
  assert.strictEqual(ok.error, '');
  assert.strictEqual(ok.rows[0].value, '¥7.00');
  assert.strictEqual(ok.label, 'DeepSeek');
  assert.strictEqual(ok.source, 'https://api.deepseek.com/user/balance');

  const unauthorized = await probeQuota({
    provider: 'api.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    credential: 'sk-test',
    fetchImpl: async () => fakeResponse(401, { error: 'bad key' }),
  });
  assert.deepStrictEqual(unauthorized.rows, []);
  assert.match(unauthorized.error, /401/,
    'a rejected key must say so; silence would look like "no quota configured"');

  const offline = await probeQuota({
    provider: 'api.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    credential: 'sk-test',
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  assert.deepStrictEqual(offline.rows, []);
  assert.match(offline.error, /ENOTFOUND/);

  const noCredential = await probeQuota({
    provider: 'api.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    credential: '',
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.deepStrictEqual(noCredential.rows, []);
  assert.match(noCredential.error, /密钥/);

  const unknown = await probeQuota({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    credential: 'sk-test',
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.strictEqual(unknown.adapter, null);
  assert.deepStrictEqual(unknown.rows, []);
  assert.strictEqual(unknown.error, '',
    'an unknown provider is not an error state; it is simply a card with no quota section');

  console.log('quota probe test ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
