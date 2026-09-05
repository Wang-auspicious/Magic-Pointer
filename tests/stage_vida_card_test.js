'use strict';

// 舞台面板的运动与状态契约。
//
// 运动仍然照 PromptRescue 实测（参考/Vida/PromptRescue.mp4，1920×1080 @60fps）：
// 233ms 右滑入场、退场快十倍、进度是逐行展开的证据流而不是百分比条。
//
// 状态表达不再照抄参考。参考把 `TASK FINISHED` 写在卡头、又在底部贴一条绿色
// 完成行；两者都是给一件正文已经说清楚的事再发一次奖状，在一块浮在别人窗口
// 上的小面板里只是噪音。这份测试因此钉的是「不写第二遍」：
//   1. 卡头没有状态词；
//   2. 没有绿色完成行；
//   3. 你问的那句话是对话流里靠右的一条消息，不是面板标题。

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

// ---- 2. 没有绿色完成行 ----------------------------------------------------
assert.ok(!stageHtml.includes('thread-done-line'),
  '绿色完成行整块撤掉：答案出现、追问框回来，本身就是完成信号');
assert.ok(!stageCss.includes('thread-done-line'),
  '完成行的样式一并清掉，不留一个没有消费者的选择器');

// ---- 3. 卡头不写状态词 ----------------------------------------------------
assert.ok(stageTs.includes('threadEyebrow.hidden = true'),
  '卡头的 WORKING / TASK FINISHED 撤走，节点只留给屏幕阅读器');
assert.ok(!stageTs.includes("'TASK FINISHED'") && !stageTs.includes("'NEEDS ATTENTION'"),
  '等宽全大写的机器状态词不再出现在这块面板上');
assert.ok(stageTs.includes('threadTitle.textContent = surfaceTitle'),
  '标题说的是「我正看着哪个窗口」，不是你问了什么');

// ---- 3b. 你的问题是一条靠右的消息 ------------------------------------------
const askCss = stageCss.slice(stageCss.indexOf('.turn-ask {'),
  stageCss.indexOf('.turn-ask {') + 400);
assert.ok(askCss.includes('align-self: flex-end'),
  '用户消息靠右，和 Claude 桌面版同一套对话语法');
assert.ok(askCss.includes('border-radius'),
  '用户消息是一枚气泡，不是一行灰色标签');
assert.ok(!stageTs.includes('firstAskRow.hidden = Boolean(firstAsk)'),
  '第一轮的问题不再因为「标题已经写过」而被藏起来');

// ---- 4. 退出仍旧要快（§7.2：进入慢退出快，相差十倍） ----------------------
assert.ok(/stage-thread-out \d+ms/.test(stageCss), '退场动画保留且毫秒级');

console.log('stage vida card test ok');
