import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();

test('W4-1 resource_learning_bridge extracts goals, connects posts cleanly, formats paragraphs, and builds Vault Markdown', async () => {
  const bridge = (await import('../electron/resource_learning_bridge.js')) as Record<string, unknown>;
  for (const fnName of [
    'buildLearningGoalContext',
    'inferLearningIntent',
    'enrichResourceForLearning',
    'rankResourcesForLearning',
    'formatPostForReading',
    'buildResourceVaultMarkdown',
  ]) {
    assert.equal(typeof bridge[fnName], 'function', `${fnName} must be exported`);
  }

  const buildLearningGoalContext = bridge.buildLearningGoalContext as (input: {
    threads?: Array<{ title?: string; summary?: string }>;
    vault?: {
      notes?: Array<{ title?: string; slug?: string; tags?: string[] }>;
      todos?: Array<{ text: string; done: boolean }>;
    };
  }) => {
    goals: Array<{ id: string; label: string; keywords: string[]; source: string }>;
  };

  const goalContext = buildLearningGoalContext({
    threads: [
      { title: '关闭电脑Codex应用' },
      { title: '指挥电脑CU帮我关闭codex' },
      { title: '指挥电脑commputer use 任务' },
      { title: '你好' },
      { title: '为什么 Attention 不能 Q 乘 Q', summary: 'RoPE 旋转位置编码与双线性交互' },
      { title: 'Hadoop MapReduce 作业调优' },
    ],
    vault: {
      notes: [
        { title: 'RoPE 位置编码笔记', slug: 'rope-position', tags: ['transformer', 'rope'] },
      ],
      todos: [{ text: '对比 Q·Q 与 Q·K 权重矩阵', done: false }],
    },
  });
  assert.ok(goalContext.goals.length >= 2 && goalContext.goals.length <= 4, 'should extract up to 4 curated study goals');
  assert.equal(goalContext.goals[0]?.source, 'vault-note', 'Vault notes should be prioritized ahead of raw chat threads');
  assert.equal(
    goalContext.goals.some(g => /Codex|commputer|关闭电脑|你好/i.test(g.label)),
    false,
    'operational/CU/greeting thread titles must be filtered out of study goals',
  );
  assert.ok(
    goalContext.goals.some(g => /Attention/i.test(g.label)),
    'genuine study thread should remain eligible after operational threads are filtered',
  );

  const formatPostForReading = bridge.formatPostForReading as (raw: string) => {
    paragraphs: string[];
    cleanTags: string[];
  };
  const formatted = formatPostForReading(
    '为什么 RoPE 能用复数相乘直接表示相对位置？把 q 和 k 在二维子空间里各自旋转 mθ 和 nθ，内积天然只剩 (m-n)θ。这就是平移不变性的几何本质。\n\n#大模型 #Transformer #深度学习 #人工智能 #考研 #每天学习一点点',
  );
  assert.ok(formatted.paragraphs.length >= 2, 'should split wall of text into readable paragraphs');
  assert.equal(
    formatted.paragraphs.some(p => p.includes('#每天学习一点点')),
    false,
    'trailing hashtag spam should be stripped from reading paragraphs',
  );
  assert.ok(formatted.cleanTags.length <= 4, 'cleanTags should cap noisy hashtag spam');

  const longUrl = 'https://www.xiaohongshu.com/user/profile/68e3269c000000003100dae3/6b009e26000000002a02cc60?xsec_token=ABrijmFVpySl2lVoE9D-xe2jatAxWL_v6Fl0lZEhbFvhU=&xsec_source=pc_user';
  const urlFormatted = formatPostForReading(longUrl);
  assert.deepEqual(urlFormatted.paragraphs, [longUrl], 'bare long URLs must never be split on dots into spaced fragments');

  const xhsOnlyTags = formatPostForReading('#iclr[话题]# #iclr27[话题]# #ai[话题]# #科研[话题]#');
  assert.equal(xhsOnlyTags.paragraphs.length, 0, 'pure hashtag post text should yield 0 body paragraphs');
  assert.deepEqual(xhsOnlyTags.cleanTags, ['iclr', 'iclr27', '科研']);

  const enrichResourceForLearning = bridge.enrichResourceForLearning as (
    resource: Record<string, unknown>,
    ctx: typeof goalContext,
  ) => {
    intent: 'concept' | 'practice' | 'reference';
    goalMatch?: { label: string; reason: string };
    paragraphs: string[];
    cleanTags: string[];
    score: number;
  };
  const ropePost = enrichResourceForLearning(
    {
      id: 'res_rope',
      source: 'xhs',
      title: '一篇讲透 RoPE 旋转位置编码为什么能保留相对距离',
      author: '算法笔记',
      url: 'https://www.xiaohongshu.com/explore/rope123',
      text: 'RoPE 在 Attention 里只旋转 Q 和 K，不改 softmax 本身。实践里对照 Q·Q 和 Q·K 会看得很清楚。#transformer #rope #llm #ai #study',
      tags: ['transformer', 'rope', 'llm', 'ai', 'study'],
      capturedAt: '2026-11-20T01:00:00Z',
    },
    goalContext,
  );
  assert.ok(ropePost.goalMatch, 'post overlapping active RoPE/Attention goal must produce goalMatch');
  assert.match(ropePost.goalMatch.reason, /RoPE|Attention|笔记|待办/);

  const buildResourceVaultMarkdown = bridge.buildResourceVaultMarkdown as (
    resource: Record<string, unknown>,
    enrichment: typeof ropePost,
  ) => { title: string; markdown: string; tags: string[] };
  const md = buildResourceVaultMarkdown(
    {
      id: 'res_rope',
      source: 'xhs',
      title: '一篇讲透 RoPE 旋转位置编码',
      author: '算法笔记',
      url: 'https://www.xiaohongshu.com/explore/rope123',
      capturedAt: '2026-11-20T01:00:00Z',
    },
    ropePost,
  );
  assert.match(md.markdown, /\[\[.*\]\]/, 'Vault markdown must include [[wikilinks]] to related notes/goals');
  assert.match(md.markdown, /https:\/\/www\.xiaohongshu\.com\/explore\/rope123/);

  const rankResourcesForLearning = bridge.rankResourcesForLearning as (
    items: Array<Record<string, unknown>>,
    ctx: typeof goalContext,
  ) => Array<Record<string, unknown>>;
  const ranked = rankResourcesForLearning(
    [
      {
        id: 'res_unrelated',
        source: 'x',
        title: '周末咖啡馆探店合集',
        text: '这家拿铁不错',
        capturedAt: '2026-11-20T02:00:00Z',
      },
      {
        id: 'res_rope',
        source: 'xhs',
        title: 'RoPE 位置编码与 Attention 对称性推导',
        text: 'RoPE 旋转编码让 Q·K 内积只依赖相对位置差',
        capturedAt: '2026-11-19T02:00:00Z',
      },
    ],
    goalContext,
  );
  assert.equal(ranked[0]?.id, 'res_rope', 'goal-relevant post must rank above unrelated newer chatter');
});

test('W4-2 knowledge_vault appendVaultTodo appends cleanly and shows up in scanKnowledgeVault', async () => {
  const vault = (await import('../electron/knowledge_vault.js')) as Record<string, unknown>;
  assert.equal(
    typeof vault.appendVaultTodo,
    'function',
    'knowledge_vault.ts must export appendVaultTodo',
  );
  const appendVaultTodo = vault.appendVaultTodo as (
    vaultDir: string,
    input: { text: string; title?: string; sourceUrl?: string; relatedLink?: string },
  ) => { ok: boolean; filePath: string; appended: boolean };
  const scanKnowledgeVault = vault.scanKnowledgeVault as (vaultDir: string) => {
    todos: Array<{ text: string; done: boolean }>;
  };

  const dir = mkdtempSync(join(tmpdir(), 'mp-vault-todo-'));
  try {
    const first = appendVaultTodo(dir, {
      text: '手推一遍 RoPE 二维复数旋转内积公式',
      sourceUrl: 'https://www.xiaohongshu.com/explore/rope123',
      relatedLink: 'RoPE 位置编码笔记',
    });
    assert.equal(first.ok, true);
    assert.equal(first.appended, true);

    const dup = appendVaultTodo(dir, {
      text: '手推一遍 RoPE 二维复数旋转内积公式',
    });
    assert.equal(dup.appended, false, 'identical open todo should be deduplicated');

    const snapshot = scanKnowledgeVault(dir);
    assert.ok(
      snapshot.todos.some(t => t.text.includes('手推一遍 RoPE 二维复数旋转内积公式') && !t.done),
      'appended todo must be discoverable by scanKnowledgeVault',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('W4-3 Resource Library UI matches Claude-native layout, compact toolbar, full-height reader, connector Sources, and exposed sidebar nav', () => {
  const rlTs = readFileSync(join(ROOT, 'electron/renderer/resource_library.ts'), 'utf8');
  const rlCss = readFileSync(join(ROOT, 'electron/renderer/resource_library.css'), 'utf8');
  const layoutCss = readFileSync(join(ROOT, 'electron/renderer/studio_layout.css'), 'utf8');
  const studioHtml = readFileSync(join(ROOT, 'electron/renderer/studio.html'), 'utf8');
  const studioTs = readFileSync(join(ROOT, 'electron/renderer/studio.ts'), 'utf8');

  assert.match(rlTs, /data-rl-goal-strip/, 'Resource Library must keep optional Goal Context Strip');
  assert.match(rlTs, /save-to-vault/, 'Reader must wire Save to Vault action');
  assert.match(rlTs, /add-vault-todo/, 'Reader must wire Add Learning Todo action');
  assert.match(rlTs, /data-rl-toggle-capture/, 'Quick capture drawer should toggle on demand instead of consuming top space');
  assert.match(rlTs, /mp-connector-table/, 'Sources view should use Claude-native connector table layout');
  assert.doesNotMatch(rlTs, /A little less scattered|rl-intent-badge/, 'Remove noisy kicker subtitle and orange intent pills from cards');
  assert.match(rlCss, /grid-template-columns:\s*repeat\(auto-fill/, 'Must use stable CSS Grid cards instead of jittery JS masonry');
  assert.match(rlCss, /\.rl-shell\.is-reading/, 'Reader view should collapse library header/toolbar to give full height');
  assert.doesNotMatch(layoutCss, /\.mp-main-navigation\s+#nav-resources/, 'Resources must not be hidden inside More');
  assert.doesNotMatch(layoutCss, /\.mp-main-navigation\s+#nav-scheduled/, 'Routines must not be hidden inside More');
  assert.match(studioHtml, /id="nav-resources"[\s\S]*?data-library-nav="resources"/, 'Resources nav button must support sidebar visibility toggle');
  assert.doesNotMatch(studioTs, /\['Resources',\s*'resources'/, 'Resources should not be hardcoded inside sidebar More menu');
});
