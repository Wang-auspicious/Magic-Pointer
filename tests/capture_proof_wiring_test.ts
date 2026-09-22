'use strict';


const assert = require('assert');

const { captureProofFromBridge, stageEventFromBridge } = require('../electron/stage_contract');

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

{
  assert.deepStrictEqual(captureProofFromBridge({}), []);
  assert.deepStrictEqual(captureProofFromBridge(null), []);
}

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

{
  const event = stageEventFromBridge({ ok: true, answer: '好的。' });
  assert.ok(!('captureProof' in event), '无证据时仍然带了 captureProof 字段');
}

console.log('capture_proof_wiring_test: all assertions passed');
