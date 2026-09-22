'use strict';


const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stageJs = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');
const stageHtml = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.html'), 'utf8');
const stageCss = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');
const { stretchCommand, stretchIntent } = require('../electron/stage_stretch_policy');

{
  const intent = stretchIntent({ dragPx: 60, currentLines: 3 });
  const lines = /到 (\d+) 行/;
  assert.strictEqual(
    lines.exec(stretchCommand(intent, 'answer'))[1],
    lines.exec(stretchCommand(intent, 'selection'))[1],
    '同样的拖拽在答案侧和选区侧得到了不同的目标行数',
  );
}

{
  assert(stageJs.includes("selectionStretchDrag.edge === 'top' ? -raw : raw"), '上把手方向没有取反');
}


assert(stageHtml.includes('id="selection-stretch"'), '选区上没有把手');
assert(stageHtml.includes("data-edge=\"top\""), '缺少上把手');
assert(stageHtml.includes("data-edge=\"bottom\""), '缺少下把手');
assert(stageCss.includes('.selection-stretch-handle'), '把手没有样式');
assert(stageCss.includes('ns-resize'), '把手没有可拖拽的指示');
assert(stageCss.includes('prefers-reduced-motion'), '没有为减少动效的用户降级');


assert(stageJs.includes('function renderSelectionStretch('), '把手从未被放置');
assert(stageJs.includes('function beginSelectionStretch('), '把手无法开始拖拽');
assert(stageJs.includes('function endSelectionStretch('), '松手后什么都不会发生');
assert(stageJs.includes("stretchPolicy.stretchCommand(drag.intent, 'selection')"), '选区侧用了答案侧的措辞');

assert(stageJs.includes('if (command) submitCommand(command);'), '拉伸结果没有走普通提交通道');

assert(
  stageJs.includes("session.targetGeometryKind !== 'resolved'"),
  '没有解析出区域时仍然显示了把手',
);

assert(stageJs.includes('selectionStretchHint.textContent = selectionStretchDrag.intent.hint'), '拖拽时没有实时提示');

console.log('selection_stretch_wiring_test: all assertions passed');
