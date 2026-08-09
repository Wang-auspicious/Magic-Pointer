'use strict';

// 光有纯策略不算做完——带子得真的画出来。
//
// 这组断言钉的是整条链：Python 记录命中的矩形 → 随响应传出 → stage_contract 算成
// 证据带 → 舞台按来源分色画出来 → 新会话开始时清掉。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { captureProofFromBridge, stageEventFromBridge } = require('../electron/stage_contract');

// --- 契约层 -----------------------------------------------------------------

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

// --- 渲染层接线 -------------------------------------------------------------

{
  const stageJs = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.ts'), 'utf8');
  const stageHtml = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.html'), 'utf8');
  const stageCss = fs.readFileSync(path.join(root, 'electron', 'renderer', 'stage.css'), 'utf8');

  assert(stageHtml.includes('id="capture-proof"'), '舞台上没有放证据带的容器');
  assert(stageHtml.includes('capture_proof_policy.js'), '渲染进程没有加载策略');
  assert(stageJs.includes('function renderCaptureProof('), '证据带从未被渲染');
  assert(stageJs.includes("element.dataset.source = band.source"), '带子没有带上来源，无法分色');
  assert(stageJs.includes('clearCaptureProof()'), '新会话不会清掉上一次的带子');

  // 颜色是有含义的，不是装饰：读到的和认出来的必须不同。
  assert(stageCss.includes(".capture-proof-band[data-source='pixel']"), '像素来源没有独立配色');
  assert(
    stageCss.includes(".capture-proof-band[data-source='structured']"),
    '结构层来源没有独立配色',
  );
  const pixelBlock = stageCss.slice(stageCss.indexOf("[data-source='pixel']"));
  const structuredBlock = stageCss.slice(
    stageCss.indexOf("[data-source='structured']"),
    stageCss.indexOf("[data-source='pixel']"),
  );
  const pixelEdge = /--proof-edge:\s*([^;]+);/.exec(pixelBlock);
  const structuredEdge = /--proof-edge:\s*([^;]+);/.exec(structuredBlock);
  if (pixelEdge === null || structuredEdge === null) {
    throw new Error('两种来源都要定义边框色');
  }
  assert.notStrictEqual(
    pixelEdge[1].trim(),
    structuredEdge[1].trim(),
    '"我确切知道"和"我认出来了"用了同一种颜色',
  );

  // 用户点名的是"跑一圈"，所以必须真的有绕行动画。
  assert(stageCss.includes('capture-proof-run'), '没有跑一圈的动画');
  assert(stageCss.includes('conic-gradient'), '绕行是靠 conic 扫过实现的');
  assert(stageCss.includes('prefers-reduced-motion'), '没有为减少动效的用户降级');
}

// --- Python 侧 ---------------------------------------------------------------

{
  const bridge = fs.readFileSync(path.join(root, 'scripts', 'selection_bridge.py'), 'utf8');
  assert(bridge.includes('"captured_rects"'), 'OCR 命中的矩形没有被记录');
  assert(bridge.includes('"captured_rects_source"'), '矩形没有标明来源');
}

console.log('capture_proof_wiring_test: all assertions passed');
