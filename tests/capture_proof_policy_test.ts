'use strict';


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

{
  const bands = captureProof({
    structured: [[100, 100, 200, 30]],
    textRange: [[100, 200, 200, 30]],
    pixel: [[100, 300, 200, 30]],
  });
  assert.strictEqual(bands.length, 3);
  assert.deepStrictEqual(bands.map((b: TestBand) => b.source), ['structured', 'text_range', 'pixel']);
}

{
  const bands = captureProof({
    structured: [[100, 100, 200, 30]],
    pixel: [[102, 101, 199, 31]],
  });
  assert.strictEqual(bands.length, 1);
  assert.strictEqual(bands[0].source, 'structured', '像素来源覆盖了结构层来源');
}

{
  const bands = captureProof({ pixel: [[100, 100, 200, 30]] });
  assert.strictEqual(bands[0].source, 'pixel');
}

{
  const bands = captureProof({
    pixel: [[300, 400, 100, 20], [100, 400, 100, 20], [100, 100, 100, 20]],
  });
  assert.deepStrictEqual(
    bands.map((b: TestBand) => [b.rect.x, b.rect.y]),
    [[100, 100], [100, 400], [300, 400]],
  );
}

{
  const bands = captureProof({ pixel: [[300, 401, 100, 20], [100, 400, 100, 20]] });
  assert.deepStrictEqual(bands.map((b: TestBand) => b.rect.x), [100, 300]);
}

{
  const bands = captureProof({ pixel: [[100, 100, 3, 3], [100, 200, 200, 30]] });
  assert.strictEqual(bands.length, 1);
  assert.ok(MIN_PROOF_EDGE_PX > 3);
}

{
  const many = Array.from({ length: 40 }, (_, index) => [100, index * 40, 200, 30]);
  assert.strictEqual(captureProof({ pixel: many }).length, MAX_PROOF_RECTS);
}

{
  assert.deepStrictEqual(captureProof({}), []);
  assert.deepStrictEqual(captureProof(null), []);
  assert.deepStrictEqual(captureProof({ pixel: [null, 'x', [1, 2], {}, [NaN, 1, 2, 3]] }), []);
}

{
  const bands = captureProof({ structured: [{ x: 10, y: 20, width: 300, height: 40 }] });
  assert.deepStrictEqual(bands[0].rect, { x: 10, y: 20, width: 300, height: 40 });
}


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
  for (const term of ['uia', 'ocr', 'region_elements', 'pixel']) {
    assert.ok(!mixed.toLowerCase().includes(term), `诊断术语泄漏到用户可见文案：${term}`);
  }
}


{
  const bands = captureProof({ pixel: [[500, 400, 200, 40]] });
  const [mapped] = toStageRects(bands, { origin: { x: 100, y: 100 }, scaleFactor: 2 });
  assert.deepStrictEqual(mapped.rect, { x: 200, y: 150, width: 100, height: 20 });
  assert.strictEqual(mapped.source, 'pixel');
}

{
  const bands = captureProof({ pixel: [[10, 10, 100, 20]] });
  assert.deepStrictEqual(toStageRects(bands)[0].rect, { x: 10, y: 10, width: 100, height: 20 });
  assert.deepStrictEqual(toStageRects(bands, { scaleFactor: 0 })[0].rect, { x: 10, y: 10, width: 100, height: 20 });
}

console.log('capture_proof_policy_test: all assertions passed');
