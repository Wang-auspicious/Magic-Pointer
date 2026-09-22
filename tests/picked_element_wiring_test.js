'use strict';


const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
const stageSource = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');

const ts = require('typescript');
const body = mainSource.slice(
  mainSource.indexOf('function withPickedElement('),
  mainSource.indexOf('function deliverStageError('),
);
const compiledBody = ts.transpileModule(body, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const withPickedElement = new Function(`${compiledBody}; return withPickedElement;`)();

const SNAPSHOT = Object.freeze({
  snapshot_id: 'snap-1',
  selection_bbox: [10, 10, 100, 20],
  selection_gesture: { strokes: [{ points: [] }] },
  selection_segments: [[0]],
});

{
  const next = withPickedElement(SNAPSHOT, { rect: { x: 800, y: 400, width: 300, height: 60 }, source: 'pixel' });
  assert.deepStrictEqual(next.selection_bbox, [800, 400, 300, 60]);
  assert.strictEqual(next.picked_element_source, 'pixel');
}

{
  const next = withPickedElement(SNAPSHOT, { rect: { x: 800, y: 400, width: 300, height: 60 } });
  assert.strictEqual(next.selection_gesture, null);
  assert.strictEqual(next.selection_segments, null);
}

{
  assert.strictEqual(withPickedElement(SNAPSHOT, null), SNAPSHOT);
  assert.strictEqual(withPickedElement(SNAPSHOT, {}), SNAPSHOT);
  assert.strictEqual(withPickedElement(SNAPSHOT, { rect: { x: 1, y: 1, width: 0, height: 10 } }), SNAPSHOT);
  assert.strictEqual(withPickedElement(null, { rect: { x: 1, y: 1, width: 5, height: 5 } }), null);
}

{
  withPickedElement(SNAPSHOT, { rect: { x: 800, y: 400, width: 300, height: 60 } });
  assert.deepStrictEqual(SNAPSHOT.selection_bbox, [10, 10, 100, 20]);
}


{
  assert(stageSource.includes('pickedElement = {'), '点选结果没有被记住，无法追问');
  assert(stageSource.includes("chip.className = 'capsule-ref is-picked'"), '点选的那一块没有出现在气泡里');
  assert(stageSource.includes('pickedElement: pickedElement ?'), '点选没有随命令一起发出');
  assert(stageSource.includes('pickedElement = null;'), '点选无法取消');

  assert(preloadSource.includes('pickedElement:'), 'preload 没有透传点选');
  const picked = preloadSource.slice(preloadSource.indexOf('pickedElement:'), preloadSource.indexOf('executeAction:'));
  assert(!/hwnd|title|app\b/i.test(picked), '渲染进程可以指定读取目标了');

  assert(mainSource.includes('withPickedElement('), 'main 没有把点选应用到快照上');
}

console.log('picked_element_wiring_test: all assertions passed');
