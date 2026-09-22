'use strict';


type RuleEvent = {
  t?: number;
  kind?: string;
  app?: string;
  fingerprint?: string;
  foregroundChanged?: boolean;
  sourceId?: string;
  title?: string;
};
type RuleState = {
  currentBurst?: { app: string; count: number; lastAt: number };
  fingerprint?: string;
  stickyCount?: number;
  foregroundStable?: number;
  app?: string;
  flips?: number;
};
type RuleVerdict = {
  trigger: boolean;
  ruleId?: string;
  previewText?: string;
  objects?: Array<Record<string, string>>;
  resetState?: null;
  state?: RuleState;
};

function evaluateRule(
  ruleId: string,
  event: RuleEvent = {},
  state?: RuleState | null,
): RuleVerdict {
  switch (ruleId) {
    case 'burst_screenshots': {
      const burst = state && state.currentBurst;
      const now = event.t || Date.now();
      const app = String(event.app || '');
      const gap = (burst && now - burst.lastAt) || 0;
      if (event.kind === 'shot') {
        const sameApp = burst && app === burst.app;
        if (sameApp && gap <= 10 * 60 * 1000) {
          burst.count += 1;
          burst.lastAt = now;
          if (burst.count >= 2) {
            return {
              trigger: true,
              ruleId,
              previewText: '刚才连续截了两张图，要直接把里面的文字取出来吗？',
              objects: [{ app, kind: 'screenshots' }],
              resetState: null,
            };
          }
          return { trigger: false, state: { currentBurst: burst } };
        }
        return {
          trigger: false,
          state: { currentBurst: { app, count: 1, lastAt: now } },
        };
      }
      return {
        trigger: false,
        state: { currentBurst: burst || { app: '', count: 0, lastAt: now } },
      };
    }

    case 'clipboard_stale': {
      const fpr = String(event.fingerprint || '');
      if (event.foregroundChanged) {
        return {
          trigger: false,
          state: { fingerprint: fpr, stickyCount: 1, foregroundStable: 0 },
        };
      }
      const same = state && state.fingerprint === fpr;
      const sticky = same ? (state?.stickyCount || 0) + 1 : 1;
      const foregroundStable = same ? (state?.foregroundStable || 0) + 1 : 1;
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
      const app = String(event.app || '');
      const sameApp = state && state.app === app;
      const flips = state && !sameApp ? (state.flips || 0) + 1 : 0;
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

    case 'context_material_follow': {
      if (event.kind !== 'material_selected') return { trigger: false };
      const sourceId = String(event.sourceId || '').trim();
      if (!sourceId) return { trigger: false };
      const title = String(event.title || '').trim();
      return {
        trigger: true,
        ruleId,
        previewText: `${title || '这份材料'}已加入当前任务。要“关注此材料”，在它变化后自动生成更新草稿吗？`,
        objects: [{ kind: 'material', sourceId, title }],
        resetState: null,
      };
    }

    default:
      return { trigger: false };
  }
}

module.exports = { evaluateRule };
