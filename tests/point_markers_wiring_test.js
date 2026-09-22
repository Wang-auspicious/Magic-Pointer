'use strict';


const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { stageEventFromBridge } = require('../electron/stage_contract');

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

{
  const event = stageEventFromBridge({ ok: true, answer: '好的。' });
  assert.ok(!('screenPoints' in event), '无坐标时仍然带了 screenPoints');
}

{
  const event = stageEventFromBridge({
    ok: true,
    answer: 'x',
    screenPoints: [null, { x: 'a', y: 1 }, { x: 10, y: 20 }],
  });
  assert.strictEqual(event.screenPoints.length, 1);
}

{
  const many = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: i * 10, order: i + 1 }));
  const event = stageEventFromBridge({ ok: true, answer: 'x', screenPoints: many });
  assert.ok(event.screenPoints.length <= 6);
}


{
  const stageJs = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');
  const stageHtml = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.html'), 'utf8');
  const stageCss = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');

  assert(stageHtml.includes('id="screen-points"'), '舞台上没有放箭头的容器');
  assert(stageJs.includes('function renderScreenPoints('), '箭头从未被渲染');
  assert(stageJs.includes('clearScreenPoints()'), '新会话不会清掉上一次的箭头');
  assert(stageJs.includes('x > window.innerWidth'), '越界坐标没有被丢弃');
  assert(stageCss.includes('.screen-point-order'), '箭头没有编号，无法表达先后');
  assert(stageCss.includes('prefers-reduced-motion'), '没有为减少动效的用户降级');
}


{
  const { parseScreenPoints } = require('../electron/runtime/desktop_perception');
  const parsed = parseScreenPoints('先点这里 [POINT 100,200]，忽略界外 [POINT 900,900]', [0, 0, 500, 500]);
  assert.deepStrictEqual(parsed.points, [{ x: 100, y: 200, order: 1 }]);
  assert(!parsed.text.includes('[POINT'));
}

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
