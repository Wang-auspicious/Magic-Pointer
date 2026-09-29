'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contextBridge } = require('electron');

const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate(new Date());
const priorDate = new Date(); priorDate.setDate(priorDate.getDate() - 1);
const yesterday = localDate(priorDate);
const at = (date, hour, minute = 0) => new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).toISOString();
const calls = [];
const status = {
  enabled: false, paused: false, screenEnabled: false, reportTime: '21:00', retentionDays: 30,
  roots: ['D:/Documents', 'D:/Desktop/Shared work'],
  watchedRoots: ['D:/Documents', 'D:/Desktop/Shared work'],
  startedAt: at(today, 9), lastObservedAt: at(today, 16, 40), stoppedAt: null, recording: false,
  gaps: [{ from: at(today, 12), to: at(today, 13), reason: 'paused' }], errors: [],
  excludedDirectoryNames: ['node_modules', '.git'], fileScopes: [],
};
const reports = {};
let failure = '';
let cleared = false;
const clone = (value) => JSON.parse(JSON.stringify(value));

function day(date) {
  if (cleared || ![today, yesterday].includes(date)) return null;
  const isToday = date === today;
  return {
    version: 1, date, firstObservedAt: at(date, 9), lastObservedAt: at(date, 16, 40),
    keyboard: { Enter: isToday ? 42 : 7, Backspace: 16, Space: 135, KeyA: 61, ControlLeft: 24 },
    applications: [
      { appId: 'winword', label: 'Microsoft Word', activeMs: 92 * 60000, activations: 12 },
      { appId: 'msedge', label: 'Microsoft Edge', activeMs: 48 * 60000, activations: 9 },
      { appId: 'excel', label: 'Microsoft Excel', activeMs: 27 * 60000, activations: 4 },
    ],
    coverage: { activeMs: 167 * 60000, idleMs: 31 * 60000, lockedMs: 60 * 60000, unavailableMs: 0 },
    files: isToday ? [
      { at: at(date, 10, 22), kind: 'created', path: 'D:/Documents/<报价> 四季度方案.xlsx' },
      { at: at(date, 13, 41), kind: 'modified', path: 'D:/Documents/会议纪要.docx' },
      { at: at(date, 16, 12), kind: 'renamed', path: 'D:/Documents/客户交付/最终方案.docx', previousPath: 'D:/Documents/讨论稿.docx' },
    ] : [{ at: at(date, 11, 20), kind: 'created', path: 'D:/Documents/昨日的工作总结.md' }],
    fileCounts: { created: 1, modified: isToday ? 1 : 0, renamed: isToday ? 1 : 0, deleted: 0 },
    screens: [{ at: at(date, 10, 25), appId: 'winword', title: isToday ? '<报价> 方案核对 — Word' : '昨日工作回顾 — Word', path: `C:/fixture/screens/${date}.png`, text: '核对交付日期、税率与本次报价，保留所有改动的依据。', usedBackend: 'fixture.only' }],
    screenCount: 1, roots: [...status.roots], usedBackends: ['fixture.only'],
  };
}
function result(action, payload, success) {
  calls.push({ action, payload: clone(payload ?? {}) });
  if (failure === action) { failure = ''; return { ok: false, error: '暂时无法保存设置，请重试。' }; }
  return success();
}
const personalActivity = {
  read: async (date = today) => result('read', { date }, () => ({
    ok: true, status: clone(status), day: day(date), days: cleared ? [] : [today, yesterday],
    facts: { observedDays: cleared ? 0 : 12, applications: day(today)?.applications ?? [], keyboard: { Enter: 308 }, coverage: { activeMs: 1500 * 60000 }, fileCounts: { created: 26, modified: 41, deleted: 0, renamed: 8 } },
    report: { date, markdown: reports[date] || (date === today ? '上午核对了四季度报价，下午整理会议纪要并保存最终方案。\n\n电脑活跃 2 小时 47 分钟，中午暂停记录 1 小时。\n\n这份隔离验收数据只用于检查界面；未读取或采集个人活动。' : '昨天完成了工作总结。'), generatedAt: at(date, 17) },
    nativeError: null, screenError: null,
  })),
  configure: async (patch) => result('configure', patch, () => {
    Object.assign(status, patch); status.recording = status.enabled && !status.paused;
    return { ok: true };
  }),
  generate: async (date) => result('generate', { date }, () => {
    reports[date] = `${date} 最新小结已生成。\n\n今天核对报价、更新会议纪要。所有事实都有对应记录。`;
    return { ok: true };
  }),
  openSource: async (payload) => result('openSource', payload, () => ({ ok: true })),
  pickRoot: async () => result('pickRoot', {}, () => { status.roots.push('E:/Project files'); return { ok: true }; }),
  clear: async () => result('clear', {}, () => { cleared = true; return { ok: true }; }),
};

const source = fs.readFileSync(path.join(__dirname, 'probe_studio_layout_preload.js'), 'utf8');
const fixtureRequire = (name) => name === 'electron' ? { contextBridge: {
    exposeInMainWorld: (key, api) => contextBridge.exposeInMainWorld(key, {
      ...api, personalActivity,
      updates: { status: async () => ({ state: 'idle' }), check: async () => ({ ok: true }), onStatus: () => {} },
    }),
  } } : require(name);
new Function('require', 'process', 'globalThis', 'console', source)(fixtureRequire, process, globalThis, console);
contextBridge.exposeInMainWorld('__personalProbe', {
  inspect: () => ({ today, yesterday, calls: clone(calls), status: clone(status) }),
  failNext: (action) => { failure = action; },
});
