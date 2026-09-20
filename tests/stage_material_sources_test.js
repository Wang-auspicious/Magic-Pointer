'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { InteractionEpisodeStore } = require('../electron/interaction_episode');

const source = fs.readFileSync('electron/main.ts', 'utf8');
const section = source.slice(source.indexOf('function stageAppLabel('), source.indexOf('function bindEpisodeForCommand('));
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(section, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText, context);
const points = [[700, 600], [900, 300], [100, 700]];
const snapshot = {
  snapshot_id: 'three-materials', source_kind: 'screen_region',
  source_window: { title: '微信', hwnd: 10 },
  context: { app: 'application' },
  selection_gesture: { strokes: points.map(([x, y]) => ({ points: [{ x, y }, { x: x + 80, y: y + 50 }] })) },
  selection_materials: [
    { source_window: { title: '微信', hwnd: 10 }, context: { app: 'wechat' } },
    { source_window: { title: '微信', hwnd: 10 }, context: { app: 'wechat' } },
    { source_window: { title: 'Desktop', hwnd: 20 }, context: { app: 'explorer', artifacts: { local_file: { path: 'D:/Desktop/selected.pdf' } } } },
  ],
};
assert.equal(context.stageAppLabel(snapshot), '微信 + Desktop');
const object = JSON.parse(JSON.stringify(context.episodeObjectForSession({ snapshot, token: 'session-three' })));
assert.deepEqual(object.regions.map(region => region.object.windowTitle), ['微信', '微信', 'Desktop']);
assert.equal(object.regions[2].object.source.path, 'D:/Desktop/selected.pdf');
const store = new InteractionEpisodeStore();
store.bindCommandTarget(object, '总结这些材料', { taskId: 'task-three' });
const payload = store.contextPayload();
assert.deepEqual(payload.sources.map(item => item.title), ['微信', '微信', 'Desktop']);
assert.equal(payload.sources[2].kind, 'document');
assert.equal(payload.sources[2].identity.absolutePath, 'D:/Desktop/selected.pdf');
assert.deepEqual(payload.references.map(ref => ref.sourceId), payload.sources.map(item => item.sourceId));
console.log('stage material labels and per-stroke document bindings passed');
