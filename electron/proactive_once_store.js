'use strict';

// 主动提议的"一生一次"存储（纯逻辑）。
//
// 铁律落点：同一提示一生只出现一次（shown）、可永久关闭（blockedForever）。
// IO 分离：本文件纯逻辑，读写由 proactive_runtime.js 负责。

function createProactiveOnceStore({ load = () => ({}), persist = () => {} } = {}) {
  let items = load();

  // triggerId = ruleId + 参数指纹（如窗口名），同名规则带不同参数各自计一次。
  function shouldShow(triggerId) {
    const entry = items[triggerId];
    if (!entry) return true;
    if (entry.blockedForever) return false;
    return !entry.shown;
  }

  function markShown(triggerId, now = Date.now()) {
    items[triggerId] = { ...(items[triggerId] || {}), shown: true, shownAt: now };
    persist();
  }

  // 永久关闭：用户拒绝时调用，这辈子不再提。
  function blockForever(triggerId, now = Date.now()) {
    items[triggerId] = { ...(items[triggerId] || {}), blockedForever: true, blockedAt: now };
    persist();
  }

  function clear() {
    items = {};
    persist();
  }

  return { shouldShow, markShown, blockForever, clear };
}

module.exports = { createProactiveOnceStore };
