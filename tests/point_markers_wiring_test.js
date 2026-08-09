'use strict';

// [POINT] 接线：标记必须离开正文，箭头必须画出来，坐标必须信得过。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { stageEventFromBridge } = require('../electron/stage_contract');

// 坐标随结果送到舞台。
{
  const event = stageEventFromBridge({
    ok: true,
    answer: '先点这个齿轮，再选导出。',
    screenPoints: [{ x: 1840, y: 220, order: 1 }, { x: 1690, y: 540, order: 2 }],
  });
  assert.strictEqual(event.type, 'RESULT');
  assert.deepStrictEqual(event.screenPoints.map((p) => p.order), [1, 2]);
  assert.strictEqual(event.screenPoints[0].x, 1840);
}

// 没有坐标时不塞空字段——空数组会让渲染端以为"这次指了零个地方"。
{
  const event = stageEventFromBridge({ ok: true, answer: '好的。' });
  assert.ok(!('screenPoints' in event), '无坐标时仍然带了 screenPoints');
}

// 畸形坐标在契约层就被丢掉，不进渲染端。
{
  const event = stageEventFromBridge({
    ok: true,
    answer: 'x',
    screenPoints: [null, { x: 'a', y: 1 }, { x: 10, y: 20 }],
  });
  assert.strictEqual(event.screenPoints.length, 1);
}

// 有上限：满屏箭头不是指引，是没人要的示意图。
{
  const many = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i * 10, order: i + 1 }));
  const event = stageEventFromBridge({ ok: true, answer: 'x', screenPoints: many });
  assert.ok(event.screenPoints.length <= 6);
}

// --- 渲染层 -----------------------------------------------------------------

{
  const stageJs = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');
  const stageHtml = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.html'), 'utf8');
  const stageCss = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');

  assert(stageHtml.includes('id="screen-points"'), '舞台上没有放箭头的容器');
  assert(stageJs.includes('function renderScreenPoints('), '箭头从未被渲染');
  assert(stageJs.includes('clearScreenPoints()'), '新会话不会清掉上一次的箭头');
  // 落在舞台窗口之外的点不画——那是模型编的坐标。
  assert(stageJs.includes('x > window.innerWidth'), '越界坐标没有被丢弃');
  assert(stageCss.includes('.screen-point-order'), '箭头没有编号，无法表达先后');
  assert(stageCss.includes('prefers-reduced-motion'), '没有为减少动效的用户降级');
}

// --- Python 侧：标记不能留在正文里 -------------------------------------------

{
  const bridge = fs.readFileSync(path.join(root, 'scripts', 'selection_bridge.py'), 'utf8');
  assert(bridge.includes('parse_points('), '回答链路没有解析 [POINT] 标记');
  assert(bridge.includes('"screenPoints"'), '坐标没有随响应送出');
  // 解析必须发生在输出之前，否则复制/填入会带着坐标进用户的文档。
  const parseAt = bridge.indexOf('answer, screen_points = parse_points(');
  const printAt = bridge.indexOf('"screenPoints": [point.to_dict()');
  assert(parseAt > 0 && parseAt < printAt, '[POINT] 解析没有发生在输出之前');
}

// Guide lifecycle: the overlay exists only for an explicit [POINT] request.
{
  const main = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
  const overlay = fs.readFileSync(path.join(root, 'electron', 'renderer', 'overlay.ts'), 'utf8');

  assert(preload.includes('overlay:guide-finished'), 'preload must expose guide completion');
  assert(main.includes("ipcMain.on('overlay:guide-finished'"),
    'main must retire only the temporary guide overlay after guidance');
  assert(overlay.includes('window.magicPointer?.guideFinished()'),
    'renderer must report when the requested guide has disappeared');
  assert(!overlay.includes('guideFollow'),
    'waking the selection overlay must not start Clicky guidance');
}

console.log('point_markers_wiring_test: all assertions passed');
