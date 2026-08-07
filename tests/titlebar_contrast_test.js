'use strict';

// 标题栏符号颜色对比算法：符号颜色必须与按钮底下像素亮度相反。
// 底亮（白底/浅色卡片）→ 深符号；底暗（黑底/深色视频）→ 浅符号。

const assert = require('node:assert');
const { averageBrightness, symbolColorForBrightness } = require('../electron/titlebar_contrast');

// ---- 平均亮度 ----
function solid(bgra) {
  // BGRA 单像素：R=bgra[2], G=bgra[1], B=bgra[0]
  return Buffer.from([bgra[0], bgra[1], bgra[2], 255]);
}
const WHITE = solid([255, 255, 255]);
const BLACK = solid([0, 0, 0]);

assert.ok(averageBrightness(Buffer.concat([WHITE, WHITE, WHITE, WHITE])) > 200, '纯白应高亮度');
assert.ok(averageBrightness(Buffer.concat([BLACK, BLACK, BLACK, BLACK])) < 60, '纯黑应低亮度');
assert.strictEqual(averageBrightness(Buffer.alloc(0)), 128, '空位图回退中亮度');
assert.ok(
  averageBrightness(Buffer.concat([WHITE, BLACK, WHITE, BLACK])) > 100,
  '半白半黑应落在中间',
);

// ---- 颜色取反 ----
assert.strictEqual(symbolColorForBrightness(250), '#17170F', '白底用深符号');
assert.strictEqual(symbolColorForBrightness(10), '#F2F1ED', '黑底用浅符号');
assert.strictEqual(symbolColorForBrightness(100), '#F2F1ED', '暗底用浅符号');
assert.strictEqual(symbolColorForBrightness(200), '#17170F', '亮底用深符号');
assert.strictEqual(symbolColorForBrightness(139), '#F2F1ED', '临界值以下取浅');
assert.strictEqual(symbolColorForBrightness(140), '#17170F', '临界值取深');

// 同一张图的两个通道必须相反（除了中灰边界）
const darkSymbol = symbolColorForBrightness(averageBrightness(Buffer.concat([BLACK, BLACK])));
const lightSymbol = symbolColorForBrightness(averageBrightness(Buffer.concat([WHITE, WHITE])));
assert.notStrictEqual(darkSymbol, lightSymbol, '黑白两底必须给出相反颜色');

console.log('titlebar contrast test ok');
