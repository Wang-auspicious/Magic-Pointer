import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createConversationStore} from '../electron/conversation_store';
import {buildSystemPrompt} from '../electron/runtime/agent';

const ROOT = path.resolve(__dirname, '..');

test('ConceptGraph extracts DAG topology from structured and plain Learn answers and formats Unicode math labels', () => {
  const ConceptGraph = require('../electron/renderer/concept_graph');
  assert.equal(typeof ConceptGraph.extractTopology, 'function');
  assert.equal(typeof ConceptGraph.cleanFormulaText, 'function');

  assert.equal(
    ConceptGraph.cleanFormulaText('\\lambda_{21} - \\lambda_{11} \\ge \\omega_1'),
    'λ₂₁ - λ₁₁ ≥ ω₁',
  );
  assert.equal(
    ConceptGraph.cleanFormulaText('后验门槛 $\\tau$ 与 \\rho = \\arg\\min_a R^*'),
    '后验门槛 τ 与 ρ = argminₐ R⁎',
  );

  const structuredConv = {
    id: 'conv-m2-1',
    workMode: 'learn',
    learnMastery: {
      't0:b1': {
        nodeId: 't0:b1',
        title: '核心定义',
        status: 'verified',
        updatedAt: 1000,
        attempts: 1,
      },
    },
    turns: [
      {
        question: 'Explain Bayes risk threshold',
        answer: [
          ':::prereq\n先验概率 P(w_j) -> 条件风险 R(a_i|x) -> 似然比阈值\n:::',
          '',
          ':::card [concept] 核心定义',
          '==最小条件风险等价于后验期望损失最小==，依赖 [[后验概率|观测 x 后归属类别的概率]]。',
          ':::',
          '',
          ':::card [formula] 似然比阈值',
          '$$\\frac{p(x\\mid\\omega_1)}{p(x\\mid\\omega_2)} \\ge \\frac{(\\lambda_{12}-\\lambda_{22})P(\\omega_2)}{(\\lambda_{21}-\\lambda_{11})P(\\omega_1)}$$',
          ':::',
          '',
          ':::card [trap] 噪声与失配陷阱',
          '若噪声超过 20% 或误判代价倒挂，则固定阈值失效。',
          ':::',
        ].join('\n'),
      },
    ],
    branches: [
      {
        id: 'br-1',
        parentBranchId: null,
        parentTurnIndex: 0,
        anchor: {
          kind: 'trap' as unknown as 'card',
          label: '噪声与失配陷阱',
          snippet: '固定阈值失效',
          priority: 'P1',
          blockIndex: 3,
        },
        title: '为什么噪声超过20%失效？',
        agentSessionId: 'sess-br-1',
        turns: [{question: '为什么噪声超过20%失效？', answer: '估计偏移'}],
        createdAt: 1000,
        updatedAt: 1000,
      },
    ],
  };

  const topo = ConceptGraph.extractTopology(structuredConv);
  assert.ok(topo.nodes.length >= 4, `expected >=4 nodes, got ${topo.nodes.length}`);
  assert.ok(topo.edges.some((e: any) => e.relation === 'requires'));
  const verifiedNode = topo.nodes.find((n: any) => n.status === 'verified');
  assert.ok(verifiedNode, 'verified mastery state should propagate to node');
  const branchedNode = topo.nodes.find((n: any) => n.branchIds.includes('br-1'));
  assert.ok(branchedNode, 'branch should attach to matching block node');
  assert.equal(branchedNode.priority, 'P1');
  assert.equal(branchedNode.status, 'questioned');

  // Plain unannotated markdown also yields connected ConceptNodes
  const plainTopo = ConceptGraph.extractTopology({
    id: 'conv-m2-plain',
    workMode: 'learn',
    turns: [
      {
        question: 'Explain Gradient Descent',
        answer:
          '## 目标函数\n\n给定可微损失 L(w)。\n\n$$w_{t+1} = w_t - \\eta \\nabla L(w_t)$$\n\n步长过大导致震荡发散。',
      },
    ],
  });
  assert.ok(plainTopo.nodes.length >= 2);
});

test('conversation_store persists learnMastery state across reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-mastery-store-'));
  try {
    const store1 = createConversationStore({
      baseDir: dir,
      now: () => 1_700_000_000_000,
    });
    const conv = store1.appendTurn({
      workMode: 'learn',
      question: 'Bayes minimum risk?',
      answer: ':::card [concept] Risk\nBody\n:::',
    });
    const res = store1.setLearnMastery(conv.id, {
      nodeId: 't0:b0',
      title: 'Risk',
      status: 'verified',
      note: 'Passed Feynman check',
    });
    assert.equal(res.ok, true);
    store1.flush();

    const store2 = createConversationStore({baseDir: dir});
    const reloaded = store2.get(conv.id);
    assert.equal(reloaded?.learnMastery?.['t0:b0']?.status, 'verified');
    assert.equal(reloaded?.learnMastery?.['t0:b0']?.attempts, 1);
    assert.equal(
      reloaded?.learnMastery?.['t0:b0']?.note,
      'Passed Feynman check',
    );
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('LEARN_HARNESS_PROMPT teaches non-linear prereq/lab scaffolding while remaining strictly static', async () => {
  const p1 = await buildSystemPrompt({
    workspace: ROOT,
    userDataDir: ROOT,
    workMode: 'learn',
    permissionMode: 'default',
    hasSelection: false,
  });
  const p2 = await buildSystemPrompt({
    workspace: ROOT,
    userDataDir: ROOT,
    workMode: 'learn',
    permissionMode: 'default',
    hasSelection: false,
  });
  assert.equal(p1, p2);
  assert.match(p1, /:::prereq/);
  assert.match(p1, /:::lab/);
});
