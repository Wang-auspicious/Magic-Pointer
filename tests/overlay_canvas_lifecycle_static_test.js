'use strict';

// 全屏画布不能在窗口建出来时就分配。
//
// index.html 同时被两扇窗口加载（手势 overlay 与双子光标表面），而两扇窗口都
// 常驻。以前 overlay.ts 在模块末尾无条件 resize()，于是每扇窗口一生下来就按
// innerWidth×innerHeight×dpr 分配一份 2D 画布加一份 WebGL2 画布。同机实测：
// 三扇隐藏的全屏透明窗 GPU 进程 106MB，应用启动后 267MB，差额 161MB 与这些预
// 分配的后备存储吻合。这些字节在用户第一次手势之前一个像素都不用。
const assert = require('assert');
const fs = require('fs');

// 这两个文件在 Windows 检出上是 CRLF，下面的断言都跨行，先归一化。
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const source = read('electron/renderer/overlay.ts');
const main = read('electron/main.ts');

// 分配与释放必须成对存在。
assert.match(source, /let canvasAllocated = false;/,
  '画布分配状态必须是一个显式标志，而不是靠窗口是否存在来推断');
assert.match(source, /function allocateCanvas\(\)[\s\S]*?canvasAllocated = true;[\s\S]*?resize\(\);/,
  'allocateCanvas 必须先置位再 resize，否则 resize 内部的 clear() 会被自己拦掉');
assert.match(source, /function releaseCanvas\(\)[\s\S]*?canvas\.width = 0;[\s\S]*?canvas\.height = 0;/,
  'releaseCanvas 必须把画布缩到 0，仅改样式不会释放后备存储');
assert.match(source, /function releaseCanvas\(\)[\s\S]*?sweepRenderer\.resize\(0, 0, 1\);/,
  'WebGL 的 drawing buffer 跟着画布尺寸走，释放时必须一并缩掉');

// 模块加载时不得分配。
const moduleTail = source.slice(source.lastIndexOf('window.magicPointer?.onHide('));
assert.doesNotMatch(moduleTail, /^\s*resize\(\);/m,
  '模块末尾不得再无条件 resize()：窗口建出来不等于要画东西，光标的表面窗口一个像素都不画');

// 所有会画画的入口都必须先分配。
assert.match(source, /onShow\(\(payload\) => \{[\s\S]{0,200}?allocateCanvas\(\);/,
  'overlay:show 是手势与 [POINT] 指点共同的画布分配点');
assert.match(source, /function onAgentCursorCommand[\s\S]*?allocateCanvas\(\);[\s\S]*?scheduleRender\(\);/,
  '双子光标画在 canvas 上，agent-cursor 指令路径同样要分配');
assert.match(source, /kind === 'clear'[\s\S]{0,300}?releaseCanvas\(\);/,
  'clear 之后 main.ts 只调 hide()，不走 overlay:hide，所以必须在这里释放');

// 未分配时任何绘制路径都不得动手。
assert.match(source, /function render\(\) \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(!canvasAllocated\) return;/,
  'render 必须自己拦一道：agentCursorLoop 直接调 render，不经过 scheduleRender');
assert.match(source, /function scheduleRender\(\) \{\s*\n\s*if \(!canvasAllocated \|\| renderRaf\) return;/,
  'scheduleRender 未分配时不得排帧');
assert.match(source, /function clear\(\) \{\s*\n\s*if \(!canvasAllocated\) return;/,
  'clear 未分配时不得清屏');
assert.match(source, /function pulseAllowed\(\) \{\s*\n\s*return canvasAllocated &&/,
  '无人看时不该起 30fps 脉冲');
assert.match(source, /addEventListener\('resize', \(\) => \{ if \(canvasAllocated\) resize\(\); \}\)/,
  '窗口尺寸变化只在已分配时跟着重算');

// 启动时不得预建那两扇窗口：armSelectionGesture 与 queueActivationUntilSurfacesReady
// 都会按需建，且在 whenReady 里建出来的第一份会被 ensureFreshGestureOverlay 丢掉。
const whenReady = main.slice(main.indexOf('if (gotLock) app.whenReady().then('));
assert.doesNotMatch(whenReady.slice(0, whenReady.indexOf('createTray();')),
  /^\s*createOverlayWindow\(\);/m,
  'whenReady 不得预建 overlay：它的第一份会被 ensureFreshGestureOverlay 销毁重建');
assert.doesNotMatch(whenReady.slice(0, whenReady.indexOf('createTray();')),
  /^\s*createStageWindow\(\);/m,
  'whenReady 不得预建 stage：armSelectionGesture 在宽限期里自己预热');
// 但按需建立的那两条路径必须还在。
assert.match(main, /function queueActivationUntilSurfacesReady\(reason: string\) \{\s*\n\s*createOverlayWindow\(\);\s*\n\s*createStageWindow\(\);/,
  '冷启动唤醒必须自己把两扇窗口建起来，否则 readiness 永远等不到');

console.log('overlay canvas lifecycle static test ok');
