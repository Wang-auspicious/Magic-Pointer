import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Script} from 'node:vm';

import {
  buildLearnNeuralGraph,
  discoverAthenaeumCourses,
  ensureRoadshowCs336Course,
  getLearnCourse,
  listLearnCourses,
  promoteSideChatLemma,
  recordAnnotationFeedback,
  recordCourseCheckin,
  scanCourseMaterials,
  setActiveLearnCourse,
  summarizeCourseForPrompt,
} from '../electron/learn_course_store';
import {
  readLearnerMemoryIndex,
  runLearnDreamConsolidation,
} from '../electron/learn_dream';

interface FixtureEnv {
  root: string;
  userDataDir: string;
  athenaeumDir: string;
  persistenceDir: string;
  cleanup: () => void;
}

function createFixtureEnv(): FixtureEnv {
  const root = mkdtempSync(join(tmpdir(), 'mp-learn-track1a-'));
  const userDataDir = join(root, 'userData');
  const athenaeumDir = join(root, 'Athenaeum');
  const persistenceDir = join(root, 'Persistence');

  mkdirSync(userDataDir, {recursive: true});

  const cs336Root = join(athenaeumDir, 'Stanford CS336');
  mkdirSync(join(cs336Root, 'lectures'), {recursive: true});
  mkdirSync(join(cs336Root, 'assignments'), {recursive: true});
  mkdirSync(join(cs336Root, 'notes', 'learn-cs336', 'code', 'model'), {
    recursive: true,
  });
  mkdirSync(join(cs336Root, 'scripts'), {recursive: true});
  mkdirSync(join(athenaeumDir, 'CMU 15-442 DLSys', 'lectures'), {recursive: true});
  mkdirSync(join(athenaeumDir, 'MIT 6.S081', 'lectures'), {recursive: true});
  mkdirSync(join(athenaeumDir, '.git'), {recursive: true});

  writeFileSync(
    join(cs336Root, 'lectures', 'L01-overview-tokenization.md'),
    '---\ntitle: L01 Byte-Level BPE 分词\n---\n# BPE\nUTF-8 256 base bytes and pre-tokenization.\n',
    'utf8',
  );
  writeFileSync(
    join(cs336Root, 'lectures', 'L03-architectures.md'),
    '---\ntitle: L03 现代 Transformer 架构\n---\n# SwiGLU & RoPE\nPre-Norm RMSNorm SwiGLU 8/3 d and RoPE.\n',
    'utf8',
  );
  writeFileSync(
    join(cs336Root, 'assignments', 'A1-basics.md'),
    '# A1 Basics\nImplement RMSNorm, SwiGLU, RoPE, AdamW.\n',
    'utf8',
  );
  writeFileSync(
    join(cs336Root, 'notes', 'learn-cs336', 'code', 'model', 'transformer.py'),
    'class SwiGLUFFN:\n    pass\n',
    'utf8',
  );
  writeFileSync(
    join(cs336Root, 'scripts', 'server_setup.sh'),
    '#!/usr/bin/env bash\necho ok\n',
    'utf8',
  );
  writeFileSync(
    join(athenaeumDir, 'CMU 15-442 DLSys', 'lectures', '01-autodiff.md'),
    '# Automatic Differentiation\nReverse-mode autodiff and GPU kernel tiling.\n',
    'utf8',
  );
  writeFileSync(
    join(athenaeumDir, 'MIT 6.S081', 'lectures', '01-os.md'),
    '# xv6 Interfaces\nPage tables and traps.\n',
    'utf8',
  );

  mkdirSync(join(persistenceDir, 'CS 336', 'lectures'), {recursive: true});
  mkdirSync(join(persistenceDir, 'harness', 'ClaudeCode'), {recursive: true});
  mkdirSync(join(persistenceDir, 'dino-xray'), {recursive: true});

  writeFileSync(
    join(persistenceDir, 'CS 336', 'lectures', 'L03-architectures.md'),
    '---\ntitle: CS336 L03 架构笔记\ntags: [cs336, swiglu, rope]\n---\nSwiGLU 隐藏维 8/3 d 对齐 64，配合 [[Pre-Norm 与 RMSNorm]] 和 [[RoPE 旋转位置编码]]。\n',
    'utf8',
  );
  writeFileSync(
    join(persistenceDir, 'CS 336', 'lectures', 'Pre-Norm 与 RMSNorm.md'),
    '---\ntitle: Pre-Norm 与 RMSNorm\ntags: [rmsnorm, prenorm]\n---\n残差流形成梯度恒等通路，RMSNorm 去掉均值归约。\n',
    'utf8',
  );
  writeFileSync(
    join(persistenceDir, 'CS 336', 'lectures', 'RoPE 旋转位置编码.md'),
    '---\ntitle: RoPE 旋转位置编码\ntags: [rope, attention]\n---\n二维子空间旋转与高频/低频衰减基底。\n',
    'utf8',
  );
  writeFileSync(
    join(persistenceDir, 'harness', 'ClaudeCode', '01-query循环与QueryEngine.md'),
    '---\ntitle: QueryEngine 上下文循环\ntags: [harness, context, kv-cache]\n---\nQueryEngine 的 KV Prefix Cache 与 [[microcompact 上下文压缩]] 策略对应大模型推理里的 KV Cache 显存预算。\n',
    'utf8',
  );
  writeFileSync(
    join(persistenceDir, 'harness', 'ClaudeCode', '05-context管理与microcompact.md'),
    '---\ntitle: microcompact 上下文压缩\ntags: [compact, context, token]\n---\n通过 KV Cache 前缀稳定与裁剪旧工具结果压缩长序列上下文，类比 Transformer FlashAttention 与 KV 预算管理。\n',
    'utf8',
  );
  writeFileSync(
    join(persistenceDir, 'dino-xray', 'dino.md'),
    '---\ntitle: DINOv2 自监督表征\ntags: [vision, scaling]\n---\nScaling 与 SwiGLU MLP 维度对齐在大规模预训练中一致有效。\n',
    'utf8',
  );

  return {
    root,
    userDataDir,
    athenaeumDir,
    persistenceDir,
    cleanup: () => {
      rmSync(root, {recursive: true, force: true});
    },
  };
}

test('1. ensureRoadshowCs336Course builds 7-node DAG, valid reader-kit/figure-kit HTML, and idempotently preserves edits', () => {
  const env = createFixtureEnv();
  try {
    const course = ensureRoadshowCs336Course(env.userDataDir, {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });

    assert.equal(course.id, 'stanford-cs336');
    assert.equal(course.dag.length, 7);
    assert.deepEqual(
      course.dag.map(n => [n.id, n.status]),
      [
        ['bpe-tokenization', 'mastered'],
        ['prenorm-rmsnorm', 'mastered'],
        ['swiglu-alignment', 'current'],
        ['rope-extrapolation', 'stuck'],
        ['flashattention-tiling', 'locked'],
        ['adamw-memory-accounting', 'locked'],
        ['scaling-laws-wsd', 'locked'],
      ],
    );
    assert.ok(course.materials.length >= 4, 'should scan fixture course materials');
    assert.equal(course.profile.mathLevel, 2);
    assert.equal(course.profile.handsOnLevel, 2);
    assert.equal(course.profile.conceptStates['RoPE 外推频率基底']?.status, 'stuck');
    assert.equal(
      course.profile.conceptStates['Pre-Norm 梯度恒等通路']?.status,
      'mastered',
    );

    const html = course.livingArtifact.html;
    assert.ok(html.includes('<main id="doc">'), 'HTML must contain <main id="doc">');
    assert.ok(html.includes('XRAY.ready'), 'HTML must use XRAY.ready');
    assert.ok(html.includes('FK.fig'), 'HTML must render diagram via FK.fig');
    assert.ok(html.includes('FK.plot'), 'HTML must render chart via FK.plot');
    assert.ok(html.includes('figSwiGluFlow'), 'HTML must include figSwiGluFlow host');
    assert.ok(html.includes('figAlignPlot'), 'HTML must include figAlignPlot host');
    assert.ok(html.includes('ctlAlign'), 'HTML must include ctlAlign slider host');
    assert.ok(html.includes('class="bench"'), 'HTML must include .bench section');
    assert.ok(html.includes('class="steps"'), 'HTML must include .steps section');
    assert.ok(
      html.includes('data-checkin-id="cs336-swiglu-q1"'),
      'HTML must include .mp-inline-checkin block',
    );
    assert.ok(
      html.includes('id="xray-notes"'),
      'HTML must include #xray-notes metadata block',
    );

    assert.doesNotMatch(
      html,
      /#d97757|#cc5a36|#f59575/i,
      'HTML must strictly adhere to CDS palette without legacy orange hexes',
    );
    assert.doesNotMatch(html, /——/, 'HTML must not contain em-dashes ——');

    const mainSection = html.split('<main id="doc">')[1]?.split('</main>')[0] || '';
    const proseWithoutCode = mainSection.replace(/<pre[\s\S]*?<\/pre>/g, '');
    assert.doesNotMatch(
      proseWithoutCode,
      /\*\*[^*\n]+\*\*/,
      'HTML prose must not contain raw markdown **bold**',
    );

    const headingMatches = mainSection.matchAll(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/g);
    for (const m of headingMatches) {
      const headingText = m[1].replace(/<[^>]+>/g, '').trim();
      assert.doesNotMatch(
        headingText,
        /[?？]|什么|为什么|怎么|怎样|如何|哪|吗|呢/,
        `heading must not read as a question: ${headingText}`,
      );
    }

    const figHostMatches = html.matchAll(/<div class="fk-fig"[^>]*>([\s\S]*?)<\/div>/g);
    for (const m of figHostMatches) {
      assert.equal(
        m[1].trim(),
        '',
        '.fk-fig host elements must remain empty in source HTML',
      );
    }

    const scriptBlocks = Array.from(
      html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g),
    )
      .filter(m => !/type="application\/json"/i.test(m[0]) && !/src=/i.test(m[0]))
      .map(m => m[1]);
    assert.ok(scriptBlocks.length >= 3, 'should contain inline XRAY/FK/ready scripts');
    for (const code of scriptBlocks) {
      assert.doesNotThrow(() => new Script(code), 'inline script must be valid JS');
    }

    const discovered = discoverAthenaeumCourses(env.athenaeumDir, env.persistenceDir);
    assert.ok(discovered.some(c => c.id === 'stanford-cs336'));
    assert.ok(discovered.some(c => c.id === 'cmu-15-442-dlsys'));
    assert.ok(!discovered.some(c => c.id.includes('git')));

    const listRes = listLearnCourses(env.userDataDir, {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });
    assert.equal(listRes.activeCourseId, 'stanford-cs336');
    assert.ok(listRes.courses.length >= 3);

    const setRes = setActiveLearnCourse(env.userDataDir, 'cmu-15-442-dlsys', {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });
    assert.equal(setRes.activeCourseId, 'cmu-15-442-dlsys');
    assert.equal(setRes.course?.id, 'cmu-15-442-dlsys');

    // Mutate DAG status on disk and verify ensureRoadshowCs336Course preserves it
    recordCourseCheckin(env.userDataDir, 'stanford-cs336', {
      question: 'SwiGLU test',
      selectedIndex: 0,
      selectedLabel: 'A',
      unsure: false,
      reasoningNote: '8/3 d matches 8d^2',
      nodeId: 'swiglu-alignment',
    });
    const reloaded = ensureRoadshowCs336Course(env.userDataDir, {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });
    assert.equal(reloaded.livingArtifact.checkins.length, 1);

    // Fallback when directories do not exist
    const fallbackRoot = join(env.root, 'missing-user');
    const fallbackCourse = ensureRoadshowCs336Course(fallbackRoot, {
      athenaeumDir: join(env.root, 'nonexistent-athenaeum'),
      persistenceDir: join(env.root, 'nonexistent-persistence'),
    });
    assert.equal(fallbackCourse.dag.length, 7);
    assert.deepEqual(
      scanCourseMaterials(join(env.root, 'nonexistent-athenaeum')),
      [],
    );
  } finally {
    env.cleanup();
  }
});

test('2. recordAnnotationFeedback & recordCourseCheckin update conceptStates, densitySignals, and prompt summary', () => {
  const env = createFixtureEnv();
  try {
    ensureRoadshowCs336Course(env.userDataDir, {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });

    const afterConfused = recordAnnotationFeedback(env.userDataDir, 'stanford-cs336', {
      type: 'fb',
      fb: 'confused',
      quote: 'ceil_to_64(8 * d / 3) 如何影响 Tensor Core tile 利用率',
      section: '隐藏维对齐 64 的硬件悬崖',
      note: '为什么 64 的倍数能对齐 Tensor Core',
    });
    assert.ok(afterConfused);
    assert.equal(
      afterConfused.profile.conceptStates['隐藏维对齐 64 的硬件悬崖']?.status,
      'stuck',
    );

    const afterVerbose = recordAnnotationFeedback(env.userDataDir, 'stanford-cs336', {
      type: 'fb',
      fb: 'verbose',
      quote: '矩阵分步乘法展开过长',
      section: '绝不省略的 d=4 实数手算轨迹',
      blockType: 'steps',
    });
    assert.ok(afterVerbose);
    assert.equal(afterVerbose.profile.densitySignals.length, 1);
    assert.equal(afterVerbose.profile.densitySignals[0]?.signal, 'verbose');

    const afterKnown = recordAnnotationFeedback(env.userDataDir, 'stanford-cs336', {
      type: 'fb',
      fb: 'known',
      quote: '双矩阵参数量 8d^2',
      section: '双矩阵到三矩阵的参数账',
    });
    assert.ok(afterKnown);
    assert.equal(
      afterKnown.profile.conceptStates['双矩阵到三矩阵的参数账']?.status,
      'mastered',
    );

    const afterCheckin = recordCourseCheckin(env.userDataDir, 'stanford-cs336', {
      question: 'SwiGLU 隐藏维改回 4d 最先暴露什么症状？',
      selectedIndex: 0,
      selectedLabel: 'A. 激活值与参数量同时上涨约 50%',
      unsure: false,
      reasoningNote: '3 * 4d^2 = 12d^2 对比 8d^2 多出 50%',
      nodeId: 'swiglu-alignment',
    });
    assert.ok(afterCheckin);
    const swigluNode = afterCheckin.dag.find(n => n.id === 'swiglu-alignment');
    assert.ok(swigluNode?.lastAttemptNote?.includes('50%'));
    assert.equal(
      afterCheckin.profile.conceptStates['SwiGLU 门控与 8/3 d 对齐 64']?.status,
      'mastered',
    );

    const summary = summarizeCourseForPrompt(afterCheckin);
    assert.equal(summary.courseTitle, 'Stanford CS336');
    assert.equal(summary.currentNodeTitle, 'SwiGLU 门控与 8/3 d 对齐 64');
    assert.ok(summary.stuckConcepts.includes('RoPE 外推频率基底'));
    assert.ok(summary.stuckConcepts.includes('隐藏维对齐 64 的硬件悬崖'));
    assert.equal(summary.recentAnnotations.length, 3);
  } finally {
    env.cleanup();
  }
});

test('3. promoteSideChatLemma injects structured lemma into livingArtifact.html and persists across reload', () => {
  const env = createFixtureEnv();
  try {
    ensureRoadshowCs336Course(env.userDataDir, {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });

    const updated = promoteSideChatLemma(env.userDataDir, 'stanford-cs336', {
      title: '为什么 8/3 d 是从 FLOPs 守恒算出来的？',
      quote: '隐藏维从 4d 压到 8/3 d',
      insight: '标准 FFN 只有 W_1 和 W_2 两块矩阵共 2*4*d^2 = 8d^2 参数；SwiGLU 多了一块门控矩阵，3*d*d_ff = 8d^2 解出 d_ff = 8/3 d。',
      section: '双矩阵到三矩阵的参数账',
    });
    assert.ok(updated);

    const html = updated.livingArtifact.html;
    const endMarkerIdx = html.indexOf('<!-- MP-LEMMA-END -->');
    assert.ok(endMarkerIdx > 0, 'HTML must retain <!-- MP-LEMMA-END --> anchor');
    assert.ok(html.includes('已固化引理'));
    assert.ok(html.includes('3*d*d_ff = 8d^2'));
    assert.ok(
      html.indexOf('已固化引理') < endMarkerIdx,
      'injected lemma must appear before <!-- MP-LEMMA-END -->',
    );
    assert.ok(updated.livingArtifact.markdown.includes('3*d*d_ff = 8d^2'));

    const reloaded = getLearnCourse(env.userDataDir, 'stanford-cs336', {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });
    assert.ok(reloaded?.livingArtifact.html.includes('3*d*d_ff = 8d^2'));

    const reEnsured = ensureRoadshowCs336Course(env.userDataDir, {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });
    assert.ok(
      reEnsured.livingArtifact.html.includes('3*d*d_ff = 8d^2'),
      'idempotent ensure must not wipe promoted lemmas',
    );
  } finally {
    env.cleanup();
  }
});

test('4. buildLearnNeuralGraph connects course DAG, vault notes, wikilinks, and cross-bridges cleanly', () => {
  const env = createFixtureEnv();
  try {
    ensureRoadshowCs336Course(env.userDataDir, {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });

    const graph = buildLearnNeuralGraph(env.userDataDir, {
      courseId: 'stanford-cs336',
      persistenceDir: env.persistenceDir,
      athenaeumDir: env.athenaeumDir,
    });

    assert.ok(graph.nodes.length >= 10 && graph.nodes.length <= 45);
    assert.equal(graph.stats.totalNodes, graph.nodes.length);
    assert.ok(graph.stats.courseNodes >= 5);
    assert.ok(graph.stats.vaultNodes >= 3);
    assert.ok(graph.stats.stuckNodes >= 1);
    assert.ok(graph.stats.crossLinks >= 2);

    const nodeIds = new Set(graph.nodes.map(n => n.id));
    for (const edge of graph.edges) {
      assert.ok(nodeIds.has(edge.source), `missing edge source ${edge.source}`);
      assert.ok(nodeIds.has(edge.target), `missing edge target ${edge.target}`);
    }
    assert.ok(
      graph.edges.some(e => e.kind === 'prereq'),
      'graph must contain DAG prereq edges',
    );
    assert.ok(
      graph.edges.some(e => e.kind === 'cross-bridge'),
      'graph must contain cross-bridge edges',
    );
    assert.ok(
      graph.edges.some(e => e.kind === 'wikilink'),
      'graph must preserve Obsidian wikilink edges',
    );
  } finally {
    env.cleanup();
  }
});

test('5. runLearnDreamConsolidation deduplicates notes, discovers cross-bridges, writes <200 line LEARNER_MEMORY.md, and generates nudges', () => {
  const env = createFixtureEnv();
  try {
    ensureRoadshowCs336Course(env.userDataDir, {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });

    recordAnnotationFeedback(env.userDataDir, 'stanford-cs336', {
      type: 'fb',
      fb: 'confused',
      quote: '高频旋转对管近处、低频管远处',
      section: 'RoPE 外推频率基底',
      note: '代数角度太抽象',
    });
    recordAnnotationFeedback(env.userDataDir, 'stanford-cs336', {
      type: 'fb',
      fb: 'confused',
      quote: '高频旋转对管近处、低频管远处',
      section: 'RoPE 外推频率基底',
      note: '依然卡在波长衰减',
    });
    recordAnnotationFeedback(env.userDataDir, 'stanford-cs336', {
      type: 'fb',
      fb: 'verbose',
      quote: '长段展开过细',
      section: '绝不省略的 d=4 实数手算轨迹',
      blockType: 'steps',
    });
    recordAnnotationFeedback(env.userDataDir, 'stanford-cs336', {
      type: 'fb',
      fb: 'known',
      quote: 'Byte-Level BPE 从 256 字节起步',
      section: 'Byte-Level BPE 分词',
    });
    recordCourseCheckin(env.userDataDir, 'stanford-cs336', {
      question: 'SwiGLU 对齐到 64 倍数的原因',
      selectedIndex: null,
      selectedLabel: '我不太确定 / 先跳过',
      unsure: true,
      reasoningNote: '还不清楚 Tensor Core tile 尺寸',
      nodeId: 'swiglu-alignment',
    });

    const record = runLearnDreamConsolidation({
      userDataDir: env.userDataDir,
      courseId: 'stanford-cs336',
      persistenceDir: env.persistenceDir,
      athenaeumDir: env.athenaeumDir,
      recentTranscripts: [
        {
          title: 'CS336 SwiGLU 与 RoPE 追问',
          snippets: ['RoPE 复数乘法不如画 2D 箭头旋转清楚', 'KV Cache 显存受序列长度影响'],
        },
      ],
    });

    assert.ok(record.id.startsWith('dream-'));
    assert.ok(record.synthesizedInsights.length >= 2);
    assert.ok(
      record.prunedNotes.length >= 1,
      'must deduplicate repeated annotations and record prunedNotes',
    );
    assert.ok(
      record.crossBridges.length >= 1,
      'must discover cross-bridge notes from Persistence fixture',
    );
    assert.ok(
      record.crossBridges.some(b => /QueryEngine|microcompact|L03|DINOv2/i.test(b.toTitle)),
      'cross-bridge must reference real Persistence notes',
    );
    assert.ok(
      record.nudges.length >= 2 && record.nudges.length <= 4,
      'must synthesize 2-3 proactive study nudges',
    );
    assert.ok(
      record.nudges.some(n => n.kind === 'unblock_stuck'),
      'nudges must include an unblock_stuck action',
    );

    const memoryText = readLearnerMemoryIndex(env.userDataDir, 'stanford-cs336');
    assert.ok(memoryText.length > 0);
    const lines = memoryText.split(/\r?\n/);
    assert.ok(
      lines.length < 180,
      `LEARNER_MEMORY.md must stay under 180 lines (got ${lines.length})`,
    );
    assert.ok(memoryText.includes('RoPE'));
    assert.ok(memoryText.includes('SwiGLU'));

    const onDisk = readFileSync(record.memoryFilePath, 'utf8');
    assert.equal(onDisk, memoryText);

    const reloaded = getLearnCourse(env.userDataDir, 'stanford-cs336', {
      athenaeumDir: env.athenaeumDir,
      persistenceDir: env.persistenceDir,
    });
    assert.equal(reloaded?.dreamHistory.length, 1);
  } finally {
    env.cleanup();
  }
});
