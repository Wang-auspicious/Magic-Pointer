'use strict';

// PromptRescue 逐帧复刻契约（参考/Vida/PromptRescue.mp4，1920×1080 @60fps，
// 与 docs/design/VIDA_UI_SPEC.md §5/§6.3/§7.4.2 对账）。
// 这份测试钉的是舞台任务卡的「展开过程」：
//   1. 面板 233ms 从右滑入（15.750-15.983s 实测），不是原地淡入；
//   2. 运行中底部没有百分比进度条，进度由逐行展开的证据流表达；
//   3. 完成信号在底部绿色完成行（19.4-19.6s 淡入），成功时顶部眉毛行退位，
//      同一个事实不写两遍。

const assert = require('node:assert');
const fs = require('node:fs');

const stageCss = fs.readFileSync('electron/renderer/stage.css', 'utf8');
const stageHtml = fs.readFileSync('electron/renderer/stage.html', 'utf8');
const stageTs = fs.readFileSync('electron/renderer/stage.ts', 'utf8');

// ---- 1. 入场：233ms 右滑，实测减速曲线 ------------------------------------
assert.ok(
  /animation: stage-thread-in 233ms cubic-bezier\(0\.32, 0\.72, 0, 1\)/.test(stageCss),
  '面板入场必须是 233ms + cubic-bezier(0.32, 0.72, 0, 1)（§7.4.2 卡1入场实测）',
);
assert.ok(
  /@keyframes stage-thread-in \{[^}]*translateX\(/.test(stageCss),
  '入场是真实的水平滑入，不是换皮淡入',
);
assert.ok(
  /@keyframes stage-thread-in \{[^}]*blur\(/.test(stageCss),
  '入场带雾化淡入（视频 15.9-16.1s 逐帧可见 blur→clear）',
);

// ---- 2. 完成行：底部绿行，完成态才出现 ------------------------------------
assert.ok(stageHtml.includes('thread-done-line'),
  'stage.html 必须有底部绿色完成行元素（§5.2 完成行）');
const doneHtml = stageHtml.slice(
  stageHtml.indexOf('thread-done-line') - 200,
  stageHtml.indexOf('thread-done-line') + 400,
);
assert.ok(doneHtml.includes('ic-check'), '完成行带圆勾图标（视频 19.6s 帧）');
assert.ok(doneHtml.includes('已完成'), '完成行文案说明任务完成');
assert.ok(stageHtml.indexOf('thread-done-line') < stageHtml.indexOf('thread-bar'),
  '完成行在追问条上方，位置对齐 §5.2 结构');

const doneCss = stageCss.slice(
  stageCss.indexOf('.thread-done-line'),
  stageCss.indexOf('.thread-done-line') + 700,
);
assert.ok(doneCss.includes('var(--green)'), '完成行是绿色（§2.1 success 语义色）');
assert.ok(stageCss.includes('.stage-thread[data-phase=\'finished\'] .thread-done-line'),
  '完成行只在 finished 态出现，运行中不许剧透结果');
assert.ok(/thread-done-line[^{]*\{[^}]*display: none/.test(stageCss)
  || stageHtml.includes('id="thread-done-line"[^>]*hidden'),
  '完成行默认不可见，完成后才淡入');

// ---- 3. 眉毛行退位：成功时同一事实不写两遍 --------------------------------
assert.ok(stageTs.includes('threadEyebrow.hidden'),
  '成功态顶部眉毛行必须退位，完成信号交给底部绿行');
assert.ok(stageTs.includes("eyebrowState === 'done'"),
  '退位条件就是完成态本身，不引入第二套判定');

// ---- 4. 退出仍旧要快（§7.2：进入慢退出快，相差十倍） ----------------------
assert.ok(/stage-thread-out \d+ms/.test(stageCss), '退场动画保留且毫秒级');

console.log('stage vida card test ok');
