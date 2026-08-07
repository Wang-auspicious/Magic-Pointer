'use strict';

// 主动提议规则引擎与一生一次存储的测试。

const assert = require('node:assert');
const { evaluateRule } = require('../electron/proactive_rules');
const { createProactiveOnceStore } = require('../electron/proactive_once_store');

// --- burst_screenshots：连续两次同源截图触发 -------------------------
let s = null;
let r = evaluateRule('burst_screenshots', { kind: 'shot', app: 'chrome', t: 1000 }, s);
assert.strictEqual(r.trigger, false, '第一张截图不触发');
r = evaluateRule('burst_screenshots', { kind: 'shot', app: 'chrome', t: 2000 }, r.state);
assert.strictEqual(r.trigger, true, '第二张同源截图触发');
r = evaluateRule('burst_screenshots', { kind: 'shot', app: 'chrome', t: 3000 }, r.state);
assert.strictEqual(r.trigger, false, '触发后状态重置');

// 不同来源不触发
r = evaluateRule('burst_screenshots', { kind: 'shot', app: 'a', t: 4000 }, null);
r = evaluateRule('burst_screenshots', { kind: 'shot', app: 'b', t: 5000 }, r.state);
assert.strictEqual(r.trigger, false, '不同来源不成簇');

// 超 10 分钟不成簇
r = evaluateRule('burst_screenshots', { kind: 'shot', app: 'a', t: 100000 }, null);
r = evaluateRule('burst_screenshots', { kind: 'shot', app: 'a', t: 100000 + 11 * 60 * 1000 }, r.state);
assert.strictEqual(r.trigger, false, '超过 10 分钟不成簇');

// --- clipboard_stale：同一指纹滞留 3 tick 且前台稳定触发 --------------
r = evaluateRule('clipboard_stale', { fingerprint: 'f1', foregroundChanged: false, t: 1 }, null);
r = evaluateRule('clipboard_stale', { fingerprint: 'f1', foregroundChanged: false, t: 2 }, r.state);
assert.strictEqual(r.trigger, false, '第 2 tick 不触发');
r = evaluateRule('clipboard_stale', { fingerprint: 'f1', foregroundChanged: false, t: 3 }, r.state);
assert.strictEqual(r.trigger, true, '第 3 tick 同指纹且前台稳定触发');

// 前台切换会重置稳定计数
r = evaluateRule('clipboard_stale', { fingerprint: 'f2', foregroundChanged: false, t: 10 }, null);
r = evaluateRule('clipboard_stale', { fingerprint: 'f2', foregroundChanged: true, t: 11 }, r.state);
r = evaluateRule('clipboard_stale', { fingerprint: 'f2', foregroundChanged: false, t: 12 }, r.state);
r = evaluateRule('clipboard_stale', { fingerprint: 'f2', foregroundChanged: false, t: 13 }, r.state);
assert.strictEqual(r.trigger, false, '前台切换重置稳定计数');

// 空指纹永不触发
r = evaluateRule('clipboard_stale', { fingerprint: '', foregroundChanged: false, t: 1 }, null);
r = evaluateRule('clipboard_stale', { fingerprint: '', foregroundChanged: false, t: 2 }, r.state);
r = evaluateRule('clipboard_stale', { fingerprint: '', foregroundChanged: false, t: 3 }, r.state);
assert.strictEqual(r.trigger, false, '空指纹不触发');

// --- window_flip：来回切换 3 次触发 -----------------------------------
r = evaluateRule('window_flip', { app: 'a' }, null);
r = evaluateRule('window_flip', { app: 'b' }, r.state);
r = evaluateRule('window_flip', { app: 'a' }, r.state);
assert.strictEqual(r.trigger, false, '第 3 次切换还未到 3 flips');
r = evaluateRule('window_flip', { app: 'b' }, r.state);
assert.strictEqual(r.trigger, true, '第 4 次切换达到 3 flips');

// --- once_store：一生一次 + 永久关闭 -----------------------------------
let saved = {};
const store = createProactiveOnceStore({
  load: () => saved,
  persist: () => { /* saved 已引用，无操作 */ },
});
assert.strictEqual(store.shouldShow('burst_screenshots'), true, '首次可显示');
store.markShown('burst_screenshots');
assert.strictEqual(store.shouldShow('burst_screenshots'), false, 'shown 后不再显示');
store.blockForever('clipboard_stale');
assert.strictEqual(store.shouldShow('clipboard_stale'), false, '永久关闭');

// 参数指纹区分：不同指纹各自计
assert.strictEqual(store.shouldShow('burst_screenshots:chrome'), true);

console.log('proactive rules test ok');
