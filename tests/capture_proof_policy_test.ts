'use strict';

// 高亮带钉住的是一件事：**别让"我确切知道"和"我认出来了"长得一样**。
//
// 用户 2026-08-05 点名要的功能：「在他外部搞个那种跑一圈的亮色带，证明拿到了」。
// 它同时是我们最好的调试面——亮错了地方，一眼就能看见。

const assert = require('assert');
const {
  MAX_PROOF_RECTS,
  MIN_PROOF_EDGE_PX,
  captureProof,
  proofSummary,
  toStageRects,
} = require('../electron/capture_proof_policy');

interface TestBand {
  rect: { height: number; width: number; x: number; y: number };
  source: string;
}

// 三种来源都画，而且各自保留自己的来源标记。
{
  const bands = captureProof({
    structured: [[100, 100, 200, 30]],
    textRange: [[100, 200, 200, 30]],
    pixel: [[100, 300, 200, 30]],
  });
  assert.strictEqual(bands.length, 3);
  assert.deepStrictEqual(bands.map((b: TestBand) => b.source), ['structured', 'text_range', 'pixel']);
}

// 同一块被两层同时报告时只画一次，并保留更可信的那个来源。
{
  const bands = captureProof({
    structured: [[100, 100, 200, 30]],
    pixel: [[102, 101, 199, 31]],
  });
  assert.strictEqual(bands.length, 1);
  assert.strictEqual(bands[0].source, 'structured', '像素来源覆盖了结构层来源');
}

// 反过来也一样：先看到像素、后看到结构层，结论不变。
{
  const bands = captureProof({ pixel: [[100, 100, 200, 30]] });
  assert.strictEqual(bands[0].source, 'pixel');
}

// 阅读顺序：先上下，再左右。带子应该顺着眼睛走的方向亮起来。
{
  const bands = captureProof({
    pixel: [[300, 400, 100, 20], [100, 400, 100, 20], [100, 100, 100, 20]],
  });
  assert.deepStrictEqual(
    bands.map((b: TestBand) => [b.rect.x, b.rect.y]),
    [[100, 100], [100, 400], [300, 400]],
  );
}

// 同一行内基线差一两个像素不该被当成两行。
{
  const bands = captureProof({ pixel: [[300, 401, 100, 20], [100, 400, 100, 20]] });
  assert.deepStrictEqual(bands.map((b: TestBand) => b.rect.x), [100, 300]);
}

// 碎片不画：OCR 会为标点吐出 3px 的小条，框出来像渲染 bug。
{
  const bands = captureProof({ pixel: [[100, 100, 3, 3], [100, 200, 200, 30]] });
  assert.strictEqual(bands.length, 1);
  assert.ok(MIN_PROOF_EDGE_PX > 3);
}

// 有上限：画满屏幕的带子不再是证据，是噪音。
{
  const many = Array.from({ length: 40 }, (_, index) => [100, index * 40, 200, 30]);
  assert.strictEqual(captureProof({ pixel: many }).length, MAX_PROOF_RECTS);
}

// 畸形输入不产生假带子。
{
  assert.deepStrictEqual(captureProof({}), []);
  assert.deepStrictEqual(captureProof(null), []);
  assert.deepStrictEqual(captureProof({ pixel: [null, 'x', [1, 2], {}, [NaN, 1, 2, 3]] }), []);
}

// 对象形式和数组形式都收。
{
  const bands = captureProof({ structured: [{ x: 10, y: 20, width: 300, height: 40 }] });
  assert.deepStrictEqual(bands[0].rect, { x: 10, y: 20, width: 300, height: 40 });
}

// --- 说给人听的一句话 -------------------------------------------------------

{
  assert.strictEqual(proofSummary([]), '');
  assert.strictEqual(proofSummary([{ source: 'structured', rect: {} }]), '读到 1 处');
  assert.strictEqual(proofSummary([{ source: 'pixel', rect: {} }]), '从画面上认出 1 处');
  const mixed = proofSummary([
    { source: 'structured', rect: {} },
    { source: 'pixel', rect: {} },
    { source: 'pixel', rect: {} },
  ]);
  assert.ok(mixed.includes('读到 1 处'));
  assert.ok(mixed.includes('2 处'));
  // 不能出现内部术语。
  for (const term of ['uia', 'ocr', 'region_elements', 'pixel']) {
    assert.ok(!mixed.toLowerCase().includes(term), `诊断术语泄漏到用户可见文案：${term}`);
  }
}

// --- 坐标换算 ---------------------------------------------------------------

// 物理屏幕像素 → 舞台窗口自己的 DIP。200% 缩放下这一步错了，带子就会画在别处。
{
  const bands = captureProof({ pixel: [[500, 400, 200, 40]] });
  const [mapped] = toStageRects(bands, { origin: { x: 100, y: 100 }, scaleFactor: 2 });
  assert.deepStrictEqual(mapped.rect, { x: 200, y: 150, width: 100, height: 20 });
  assert.strictEqual(mapped.source, 'pixel');
}

// 缺省和非法缩放不该把带子缩成零。
{
  const bands = captureProof({ pixel: [[10, 10, 100, 20]] });
  assert.deepStrictEqual(toStageRects(bands)[0].rect, { x: 10, y: 10, width: 100, height: 20 });
  assert.deepStrictEqual(toStageRects(bands, { scaleFactor: 0 })[0].rect, { x: 10, y: 10, width: 100, height: 20 });
}

console.log('capture_proof_policy_test: all assertions passed');
