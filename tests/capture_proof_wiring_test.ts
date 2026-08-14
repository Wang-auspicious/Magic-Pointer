'use strict';

// 带子契约：Python 记录命中的矩形 → 随响应传出 → stage_contract 算成证据带。
// 只有行为断言；文件内容钉死（grep 型 wiring pin）已按 review Q9 删除。

const assert = require('assert');

const { captureProofFromBridge, stageEventFromBridge } = require('../electron/stage_contract');

// OCR 命中的块变成像素来源的带子。
{
  const proof = captureProofFromBridge({
    selectionContext: {
      artifacts: {
        captured_rects: [[100, 200, 300, 40], [100, 260, 280, 40]],
        captured_rects_source: 'pixel',
      },
    },
  });
  assert.strictEqual(proof.length, 2);
  assert.ok(proof.every((band: { source: string }) => band.source === 'pixel'));
}

// 指针锚点不是"读到的东西"，不能拿它冒充证据。
{
  const proof = captureProofFromBridge({
    selectionContext: {
      artifacts: {
        selection_geometry_kind: 'pointer_anchor',
        selection_rectangles: [[0, 0, 1920, 1080]],
      },
    },
  });
  assert.deepStrictEqual(proof, []);
}

// 结构层的选区矩形是蓝色那一档。
{
  const proof = captureProofFromBridge({
    selectionContext: {
      artifacts: {
        selection_geometry_kind: 'text_range',
        selection_rectangles: [[212, 330, 2280, 37]],
      },
    },
  });
  assert.strictEqual(proof.length, 1);
  assert.strictEqual(proof[0].source, 'structured');
}

// 没有任何几何信息时不造带子。
{
  assert.deepStrictEqual(captureProofFromBridge({}), []);
  assert.deepStrictEqual(captureProofFromBridge(null), []);
}

// 带子随结果事件一起送到舞台，并附一句人话。
{
  const event = stageEventFromBridge({
    ok: true,
    answer: '这是一条群聊消息。',
    selectionContext: {
      artifacts: { captured_rects: [[100, 200, 300, 40]], captured_rects_source: 'pixel' },
    },
  });
  assert.strictEqual(event.type, 'RESULT');
  assert.strictEqual(event.captureProof.length, 1);
  assert.ok(event.captureProofSummary.includes('认出'));
}

// 没有证据时不塞空字段——空数组会让渲染端以为"这次读到了零处"。
{
  const event = stageEventFromBridge({ ok: true, answer: '好的。' });
  assert.ok(!('captureProof' in event), '无证据时仍然带了 captureProof 字段');
}

console.log('capture_proof_wiring_test: all assertions passed');
