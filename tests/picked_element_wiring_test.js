'use strict';

// 点选之后要能追问：亮起来的那一块，就是问题作用的那一块。
//
// 没有这条接线时，元件会高亮，命令却仍然作用在之前划的选区上——高亮变成一句
// 请求并不兑现的承诺，而这是最难被发现的一类错。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
const stageSource = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');

// --- withPickedElement 的行为 -----------------------------------------------
// main.ts 不能直接 require（它会拉起 electron），所以把纯函数抽出来求值。
// 源码现在带类型注解，不能直接交给 new Function，先经 TypeScript 转译成 JS。
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

// 点选的矩形成为这次请求的作用范围。
{
  const next = withPickedElement(SNAPSHOT, { rect: { x: 800, y: 400, width: 300, height: 60 }, source: 'pixel' });
  assert.deepStrictEqual(next.selection_bbox, [800, 400, 300, 60]);
  assert.strictEqual(next.picked_element_source, 'pixel');
}

// 笔画要一起让位：它们描述的是另一块区域，留着等于让感知层去调解两种互相矛盾的"这个"。
{
  const next = withPickedElement(SNAPSHOT, { rect: { x: 800, y: 400, width: 300, height: 60 } });
  assert.strictEqual(next.selection_gesture, null);
  assert.strictEqual(next.selection_segments, null);
}

// 没有点选时快照原样通过。
{
  assert.strictEqual(withPickedElement(SNAPSHOT, null), SNAPSHOT);
  assert.strictEqual(withPickedElement(SNAPSHOT, {}), SNAPSHOT);
  assert.strictEqual(withPickedElement(SNAPSHOT, { rect: { x: 1, y: 1, width: 0, height: 10 } }), SNAPSHOT);
  assert.strictEqual(withPickedElement(null, { rect: { x: 1, y: 1, width: 5, height: 5 } }), null);
}

// 原快照不被就地修改——同一个会话可能要重发。
{
  withPickedElement(SNAPSHOT, { rect: { x: 800, y: 400, width: 300, height: 60 } });
  assert.deepStrictEqual(SNAPSHOT.selection_bbox, [10, 10, 100, 20]);
}

// --- 接线 -------------------------------------------------------------------

{
  assert(stageSource.includes('pickedElement = {'), '点选结果没有被记住，无法追问');
  assert(stageSource.includes("chip.className = 'capsule-ref is-picked'"), '点选的那一块没有出现在气泡里');
  assert(stageSource.includes('pickedElement: pickedElement ?'), '点选没有随命令一起发出');
  // 取消这一块必须真的取消，否则 chip 又成了骗人的装饰。
  assert(stageSource.includes('pickedElement = null;'), '点选无法取消');

  assert(preloadSource.includes('pickedElement:'), 'preload 没有透传点选');
  // 渲染进程只能给几何，不能指定窗口或应用——否则它就能把读取瞄准任意目标。
  const picked = preloadSource.slice(preloadSource.indexOf('pickedElement:'), preloadSource.indexOf('executeAction:'));
  assert(!/hwnd|title|app\b/i.test(picked), '渲染进程可以指定读取目标了');

  assert(mainSource.includes('withPickedElement('), 'main 没有把点选应用到快照上');
}

console.log('picked_element_wiring_test: all assertions passed');
