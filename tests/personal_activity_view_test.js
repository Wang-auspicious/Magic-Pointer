'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('electron/renderer/personal_activity_view.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText, sandbox);
const view = sandbox.module.exports;
const snapshot = {
  status: { enabled: true, paused: false, recording: true, screenEnabled: true, reportTime: '21:00', retentionDays: 30, watchedRoots: ['D:/Documents'], errors: [], gaps: [] },
  day: { date: '2026-09-29', firstObservedAt: '2026-09-29T08:00:00Z', lastObservedAt: '2026-09-29T08:01:00Z', keyboard: { Enter: 13, Space: 8 }, applications: [{appId:'editor',label:'Editor',activeMs:60000}], coverage: {activeMs:60000},
    files: [{at:'2026-09-29T08:00:00Z',kind:'created',path:'D:/Documents/<报价>.pdf'}], screens: [], screenCount:0, fileCounts:{created:1,modified:0,deleted:0,renamed:0} },
  facts: { observedDays: 1, applications: [] }, report: {markdown:'# 小结\nEnter：13 次'}, nativeStatus:'running', nativeError:null,
};
const html = view.markup(snapshot, '2026-09-29', '');
assert.match(html, /Enter/);
assert.match(html, /13/);
assert.match(html, /&lt;报价&gt;\.pdf/);
assert.doesNotMatch(html, /<报价>/);
assert.match(html, /暂停/);
assert.match(html, /21:00/);
assert.match(view.markup({...snapshot,day:null}, '2026-09-28', ''), /没有记录/);
assert.match(view.markup({...snapshot,nativeError:'native stopped'}, '2026-09-29', ''), /native stopped/);
assert.doesNotMatch(view.markup(snapshot, '2026-09-29', '不存在'), /&lt;报价&gt;\.pdf/);
console.log('personal activity view data and filtering passed');
