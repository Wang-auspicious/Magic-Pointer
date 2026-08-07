'use strict';

// 标题栏按钮符号颜色的对比算法（纯函数，无 Electron 依赖）。
//
// 主屏背景是用户自定义的视频/图片，明暗不定，按钮符号必须跟它底下的
// 真实像素相反：底亮 → 深符号，底暗 → 浅符号。不猜主题，不涂底纹。

// BGRA 位图（nativeImage.toBitmap() 的格式）→ 平均亮度 0-255。
function averageBrightness(bgraBitmap) {
  let total = 0;
  const count = Math.floor(bgraBitmap.length / 4);
  for (let i = 0; i + 3 < bgraBitmap.length; i += 4) {
    const b = bgraBitmap[i];
    const g = bgraBitmap[i + 1];
    const r = bgraBitmap[i + 2];
    total += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return count > 0 ? total / count : 128;
}

// 亮度 → 符号颜色。140 是亮度中点偏下：宁可在中间地带把符号调深
// （深符号在中等亮度底上比浅符号可读），也不要让按钮隐形。
function symbolColorForBrightness(avgBrightness) {
  return avgBrightness < 140 ? '#F2F1ED' : '#17170F';
}

module.exports = { averageBrightness, symbolColorForBrightness };
