'use strict';

// §4.3 选区拉伸把手（用户点名的功能）：
// 选中 8 句里的第 3–4 句 → 上下两个把手 → 往下拖三行 → 松手按目标长度改写。
//
// 这里钉的核心是：**答案卡和选区共用同一套策略**。同一个拖拽距离在两处必须
// 得到同一个行数，否则用户的手会在两个地方学到两套不同的含义。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stageJs = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');
const stageHtml = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.html'), 'utf8');
const stageCss = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');
const { stretchCommand, stretchIntent } = require('../electron/stage_stretch_policy');

// 两侧共用策略，行数必须一致。
{
  const intent = stretchIntent({ dragPx: 60, currentLines: 3 });
  const lines = /到 (\d+) 行/;
  assert.strictEqual(
    lines.exec(stretchCommand(intent, 'answer'))[1],
    lines.exec(stretchCommand(intent, 'selection'))[1],
    '同样的拖拽在答案侧和选区侧得到了不同的目标行数',
  );
}

// 上把手方向相反：向上拖是"更多"，和向下拖下把手一致。
{
  assert(stageJs.includes("selectionStretchDrag.edge === 'top' ? -raw : raw"), '上把手方向没有取反');
}

// --- DOM 与样式 -------------------------------------------------------------

assert(stageHtml.includes('id="selection-stretch"'), '选区上没有把手');
assert(stageHtml.includes("data-edge=\"top\""), '缺少上把手');
assert(stageHtml.includes("data-edge=\"bottom\""), '缺少下把手');
assert(stageCss.includes('.selection-stretch-handle'), '把手没有样式');
assert(stageCss.includes('ns-resize'), '把手没有可拖拽的指示');
assert(stageCss.includes('prefers-reduced-motion'), '没有为减少动效的用户降级');

// --- 行为接线 ---------------------------------------------------------------

assert(stageJs.includes('function renderSelectionStretch('), '把手从未被放置');
assert(stageJs.includes('function beginSelectionStretch('), '把手无法开始拖拽');
assert(stageJs.includes('function endSelectionStretch('), '松手后什么都不会发生');
assert(stageJs.includes("stretchPolicy.stretchCommand(drag.intent, 'selection')"), '选区侧用了答案侧的措辞');

// 提交必须走普通命令通道：这样这次拉伸会像其他提问一样出现在会话里，可被再次提问撤销。
assert(stageJs.includes('if (command) submitCommand(command);'), '拉伸结果没有走普通提交通道');

// 没有可拉伸的区域时不能显示把手——悬空的把手在邀请一个无法兑现的手势。
assert(
  stageJs.includes("session.targetGeometryKind !== 'resolved'"),
  '没有解析出区域时仍然显示了把手',
);

// 拖拽过程中必须实时显示目标行数：手势承诺的数字就是命令要的数字。
assert(stageJs.includes('selectionStretchHint.textContent = selectionStretchDrag.intent.hint'), '拖拽时没有实时提示');

console.log('selection_stretch_wiring_test: all assertions passed');
