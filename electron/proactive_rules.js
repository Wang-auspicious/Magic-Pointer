'use strict';

// 主动提议规则引擎（Vida 式"提前干活"的触发判断层）。
//
// 三条确定性规则，全部零模型调用（判定靠事件流 + 计数 + 指纹）：
//   - 连续两次截图 → 提议"取文字"
//   - 剪贴板滞留（2 秒内同一文本指纹无粘贴动作）→ 提议"存收藏箱"
//   - 两窗口来回切换 3 次 → 提议"合成给 agent"
//
// 铁律（ROADMAP P2）：同一提示一生只出现一次（once_store 管）、
// 可永久关闭、绝不打断输入焦点。提议不是通知，是可预览可拒绝的提案卡。
//
// 纯函数：事件进、verdict 出。IO 在 proactive_runtime.js（另建）。

// 一条规则收到一次事件，返回是否触发 + 提案内容。
// `state` 是规则自己的滚动状态（由调用方持久化/清零）。
function evaluateRule(ruleId, event, state) {
  switch (ruleId) {
    case 'burst_screenshots': {
      // 连续两次截图（同来源簇）且距上次提议 > 10 分钟
      const burst = state && state.currentBurst;
      const now = event.t || Date.now();
      const gap = (burst && now - burst.lastAt) || 0;
      if (event.kind === 'shot') {
        const sameApp = burst && event.app === burst.app;
        if (sameApp && gap <= 10 * 60 * 1000) {
          burst.count += 1;
          burst.lastAt = now;
          if (burst.count >= 2) {
            return {
              trigger: true,
              ruleId,
              previewText: '刚才连续截了两张图，要直接把里面的文字取出来吗？',
              objects: [{ app: event.app, kind: 'screenshots' }],
              resetState: null,
            };
          }
          return { trigger: false, state: { currentBurst: burst } };
        }
        return {
          trigger: false,
          state: { currentBurst: { app: event.app, count: 1, lastAt: now } },
        };
      }
      // 非截图事件：保留 burst 但刷新窗口
      return {
        trigger: false,
        state: { currentBurst: burst || { app: '', count: 0, lastAt: now } },
      };
    }

    case 'clipboard_stale': {
      // 同一文本指纹滞留（连续 3 次 tick ≈ 2.1s）且无前台切换。
      // 前台切换意味着用户可能已粘贴/正在用，计数全部重置。
      const fpr = String(event.fingerprint || '');
      if (event.foregroundChanged) {
        return {
          trigger: false,
          state: { fingerprint: fpr, stickyCount: 1, foregroundStable: 0 },
        };
      }
      const same = state && state.fingerprint === fpr;
      const sticky = same ? (state.stickyCount + 1) : 1;
      const foregroundStable = same ? (state.foregroundStable + 1) : 1;
      if (sticky >= 3 && foregroundStable >= 3 && fpr) {
        return {
          trigger: true,
          ruleId,
          previewText: '这段文字还在剪贴板里，要存进收藏箱吗？',
          objects: [{ kind: 'clipboard', fingerprint: fpr }],
          resetState: null,
        };
      }
      return {
        trigger: false,
        state: { fingerprint: fpr, stickyCount: sticky, foregroundStable },
      };
    }

    case 'window_flip': {
      // 两窗口来回切换 3 次。切换 = app 变化；首次出现不算切换，
      // 同一 app 连续出现清零。
      const app = String(event.app || '');
      const sameApp = state && state.app === app;
      const flips = state && !sameApp ? state.flips + 1 : 0;
      const state2 = { app, flips };
      if (flips >= 3) {
        return {
          trigger: true,
          ruleId,
          previewText: '刚在这两个窗口间来回切了好几次，要把两边内容合成一条给 agent 吗？',
          objects: [{ kind: 'window_flip', app }],
          resetState: null,
        };
      }
      return { trigger: false, state: state2 };
    }

    default:
      return { trigger: false };
  }
}

module.exports = { evaluateRule };
