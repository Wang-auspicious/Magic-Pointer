import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  scanKnowledgeVault,
  type VaultNoteSummary,
} from './knowledge_vault';
import {
  DEFAULT_ATHENAEUM_DIR,
  DEFAULT_PERSISTENCE_DIR,
  ROADSHOW_CS336_COURSE_ID,
  ensureRoadshowCs336Course,
  getLearnCourse,
  learnCoursesRoot,
  listLearnCourses,
  saveLearnCourse,
  type LearnAnnotationMark,
  type LearnCourse,
  type LearnDagNode,
  type LearnDreamNudge,
  type LearnDreamRecord,
} from './learn_course_store';

export interface LearnDreamTranscriptSnippet {
  title: string;
  snippets: string[];
}

export interface LearnDreamRunOptions {
  userDataDir: string;
  courseId?: string;
  persistenceDir?: string;
  athenaeumDir?: string;
  recentTranscripts?: LearnDreamTranscriptSnippet[];
}

interface BridgeRule {
  id: string;
  pathOrTitlePattern: RegExp;
  courseTerms: RegExp;
  defaultFromTitle: string;
  buildInsight: (note: VaultNoteSummary, fromTitle: string) => string;
}

const MAX_MEMORY_INDEX_LINES = 175;

const ARCHITECTURAL_BRIDGE_RULES: BridgeRule[] = [
  {
    id: 'harness-kv-context',
    pathOrTitlePattern: /queryengine|query循环|microcompact|context管理/i,
    courseTerms: /flashattention|kv|cache|attention|scaling|context|token/i,
    defaultFromTitle: 'FlashAttention2 IO 感知分块与 Online Softmax',
    buildInsight: (note, fromTitle) =>
      `将「${note.title}」中的前缀缓存锁定与上下文微压缩机制，对照「${fromTitle}」的 KV Cache 显存预算与注意力分块边界，两者本质都是在序列增长下守住片上/上下文有效容量。`,
  },
  {
    id: 'swiglu-arch-bridge',
    pathOrTitlePattern: /architectures|l03|swiglu|dino/i,
    courseTerms: /swiglu|prenorm|rmsnorm|rope|mlp/i,
    defaultFromTitle: 'SwiGLU 门控与 8/3 d 对齐 64',
    buildInsight: (note, fromTitle) =>
      `笔记「${note.title}」记录了大模型 MLP 与缩放设计实践，可直接补全「${fromTitle}」的硬件对齐与特征门控直觉。`,
  },
  {
    id: 'rope-position-bridge',
    pathOrTitlePattern: /rope|旋转位置编码|attention/i,
    courseTerms: /rope|位置|旋转|extrapolat/i,
    defaultFromTitle: 'RoPE 旋转位置编码与长程衰减',
    buildInsight: (note, fromTitle) =>
      `「${note.title}」中的相对位移角度拆解可直接接上「${fromTitle}」，用 2D 向量夹角验证高频近程、低频远程衰减。`,
  },
];

function safeCourseSlug(courseId: string): string {
  const cleaned = String(courseId || ROADSHOW_CS336_COURSE_ID)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || ROADSHOW_CS336_COURSE_ID;
}

function learnerMemoryFilePath(userDataDir: string, courseId: string): string {
  return path.join(
    learnCoursesRoot(userDataDir),
    safeCourseSlug(courseId),
    'LEARNER_MEMORY.md',
  );
}

function atomicWriteTextSync(targetPath: string, text: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, {recursive: true});
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, text, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    throw error;
  }
}

function suggestConcreteNextAngle(conceptName: string, previousAngle: string): string {
  const lower = `${conceptName} ${previousAngle}`.toLowerCase();
  if (/rope|欧拉|复数|旋转位置/i.test(lower)) {
    return '改用 2D 单位圆箭头旋转几何与波长对照（先算 d=2 两个 token 夹角，再推高频/低频衰减）';
  }
  if (/swiglu|64|tile|tensor core|对齐/i.test(lower)) {
    return '改用 16x16 Tensor Core 瓦片填充图示与 d=4 实数矩阵步进手算，对照 ceil_to_64 阶梯图';
  }
  if (/flashattention|online softmax|sram|hbm/i.test(lower)) {
    return '改用两块 2x2 分块手算表格跟踪最大值 m_i 与归一化分母 l_i 的增量重标定';
  }
  if (/adamw|显存|梯度/i.test(lower)) {
    return '改用单参数 16 Bytes 显存拆账清单（FP16 权重/梯度 + FP32 主权重/m/v）对照实测步数';
  }
  if (/bpe|分词|tokenizer/i.test(lower)) {
    return '改用 10 字符 UTF-8 字节序列手走两轮相邻 pair 合并表与正则预切分边界';
  }
  if (/代数|推导|矩阵|公式/.test(lower)) {
    return '跳出纯符号代数推导，先用 2D 几何画面与最小数值实例（d<=4, T<=2）手算一遍';
  }
  return '先用最小具体数值样例从头手走一遍状态变化，再回到通用公式核对边界条件';
}

function deduplicateAndPruneCourse(
  course: LearnCourse,
  recentTranscripts: LearnDreamTranscriptSnippet[],
  nowIso: string,
): {synthesizedInsights: string[]; prunedNotes: string[]} {
  const synthesizedInsights: string[] = [];
  const prunedNotes: string[] = [];
  const today = nowIso.slice(0, 10);

  // 1. Deduplicate annotation marks by (type, fb, section, quote)
  const seenMarks = new Map<string, LearnAnnotationMark>();
  const duplicateCounts = new Map<string, number>();

  for (const mark of course.livingArtifact.annotations) {
    const key = [
      mark.type,
      mark.fb || '',
      mark.section.trim().toLowerCase(),
      mark.quote.trim().slice(0, 80).toLowerCase(),
    ].join('|');
    const prev = seenMarks.get(key);
    if (!prev) {
      seenMarks.set(key, mark);
    } else {
      duplicateCounts.set(key, (duplicateCounts.get(key) || 1) + 1);
      const mergedNote =
        mark.note && prev.note && mark.note !== prev.note
          ? `${prev.note}；${mark.note}`
          : mark.note || prev.note;
      seenMarks.set(key, {
        ...mark,
        note: mergedNote,
      });
    }
  }

  if (seenMarks.size < course.livingArtifact.annotations.length) {
    const removedCount = course.livingArtifact.annotations.length - seenMarks.size;
    course.livingArtifact.annotations = Array.from(seenMarks.values());
    prunedNotes.push(
      `合并并去重 ${removedCount} 条重复阅读标注（保留最新批注语境）`,
    );
  }
  for (const [key, count] of duplicateCounts.entries()) {
    const parts = key.split('|');
    const label = parts[2] || parts[3] || '片段';
    prunedNotes.push(`归并「${label}」重复标注 ×${count}，仅保留一条权威状态`);
  }

  // 2. Deduplicate density signals
  const seenDensity = new Set<string>();
  const dedupDensity: LearnCourse['profile']['densitySignals'] = [];
  let verboseCount = 0;
  for (const sig of course.profile.densitySignals) {
    const key = `${sig.doc}|${sig.blockType}|${sig.signal}`;
    if (!seenDensity.has(key)) {
      seenDensity.add(key);
      dedupDensity.push(sig);
    } else {
      prunedNotes.push(`去重密度信号：${sig.blockType} (${sig.signal})`);
    }
    if (sig.signal === 'verbose') {
      verboseCount += 1;
    }
  }
  course.profile.densitySignals = dedupDensity;
  if (verboseCount > 0) {
    synthesizedInsights.push(
      `读者在 ${verboseCount} 处推导段落反馈「啰嗦」，后续讲解优先压缩纯符号展开、直出张量形状表与 d=4 数值轨迹。`,
    );
  }

  // 3. Reconcile conceptStates from annotations & checkins
  const knownSections = new Set<string>();
  const confusedSections = new Set<string>();
  for (const mark of course.livingArtifact.annotations) {
    const conceptKey = (mark.section || mark.quote).trim().slice(0, 64);
    if (!conceptKey) {
      continue;
    }
    if (mark.type === 'fb' && mark.fb === 'known') {
      knownSections.add(conceptKey);
      const prevState = course.profile.conceptStates[conceptKey];
      course.profile.conceptStates[conceptKey] = {
        status: 'mastered',
        lastAngle: prevState?.lastAngle || mark.section || '直接阅读验证',
        evidence: `标注已懂：${mark.quote.slice(0, 100)}`,
        updatedAt: nowIso,
      };
      if (prevState && prevState.status !== 'mastered') {
        synthesizedInsights.push(
          `概念「${conceptKey}」已由 ${prevState.status} 晋升为 mastered。`,
        );
      }
    } else if (mark.type === 'fb' && mark.fb === 'confused') {
      confusedSections.add(conceptKey);
      const prevState = course.profile.conceptStates[conceptKey];
      const nextAngle = suggestConcreteNextAngle(
        conceptKey,
        prevState?.lastAngle || mark.note || '',
      );
      course.profile.conceptStates[conceptKey] = {
        status: 'stuck',
        lastAngle: nextAngle,
        evidence: mark.note
          ? `${mark.quote.slice(0, 80)}（${mark.note.slice(0, 80)}）`
          : `标注不懂：${mark.quote.slice(0, 100)}`,
        updatedAt: nowIso,
      };
    }
  }

  // Upgrade matching stuck conceptStates if a DAG node or section is explicitly marked known
  for (const [conceptName, state] of Object.entries(course.profile.conceptStates)) {
    const matchedKnown = Array.from(knownSections).some(
      k =>
        k === conceptName ||
        k.includes(conceptName) ||
        conceptName.includes(k),
    );
    if (matchedKnown && state.status !== 'mastered') {
      state.status = 'mastered';
      state.updatedAt = nowIso;
      synthesizedInsights.push(`将「${conceptName}」归并为已掌握，移出卡点队列。`);
      continue;
    }
    if (state.status === 'stuck') {
      const nextAngle = suggestConcreteNextAngle(conceptName, state.lastAngle);
      if (state.lastAngle !== nextAngle) {
        state.lastAngle = nextAngle;
        state.updatedAt = nowIso;
      }
      synthesizedInsights.push(
        `卡点「${conceptName}」重规划切入视角：${nextAngle}。`,
      );
    }
  }

  // 4. Inspect checkins (unsure gaps & reasoning notes)
  const seenCheckins = new Set<string>();
  const dedupCheckins: LearnCourse['livingArtifact']['checkins'] = [];
  for (const chk of course.livingArtifact.checkins) {
    const key = `${chk.nodeId || ''}|${chk.question}|${chk.selectedLabel}|${chk.unsure}`;
    if (seenCheckins.has(key)) {
      prunedNotes.push(`合并重复 Check-in 记录：${chk.question.slice(0, 32)}`);
      continue;
    }
    seenCheckins.add(key);
    dedupCheckins.push(chk);
  }
  course.livingArtifact.checkins = dedupCheckins;

  const unsureCheckins = dedupCheckins.filter(c => c.unsure);
  if (unsureCheckins.length > 0) {
    const latestUnsure = unsureCheckins[unsureCheckins.length - 1];
    synthesizedInsights.push(
      `Check-in 待补盲区：「${latestUnsure.question.slice(0, 56)}」${
        latestUnsure.reasoningNote
          ? `（自述卡点：${latestUnsure.reasoningNote.slice(0, 80)}）`
          : ''
      }。`,
    );
  }

  // 5. Annotate stuck DAG nodes with concrete nextAngle
  for (const node of course.dag) {
    if (node.status === 'stuck') {
      const nextAngle = suggestConcreteNextAngle(
        node.title,
        node.lastAttemptNote || '',
      );
      if (!node.lastAttemptNote || !node.lastAttemptNote.includes('下次切入')) {
        node.lastAttemptNote = node.lastAttemptNote
          ? `${node.lastAttemptNote}｜下次切入：${nextAngle}`
          : `下次切入：${nextAngle}`;
      }
    }
    if (knownSections.has(node.title) && node.status !== 'mastered') {
      node.status = 'mastered';
      synthesizedInsights.push(`课程节点「${node.title}」依据阅读反馈同步更新为 mastered。`);
    }
    if (confusedSections.has(node.title) && node.status === 'current') {
      node.lastAttemptNote = `读者在阅读中标出困惑；下次切入：${suggestConcreteNextAngle(node.title, '')}`;
    }
  }

  // 6. Fold recent conversation transcripts
  for (const tr of recentTranscripts.slice(-4)) {
    const joined = `${tr.title} ${tr.snippets.join(' ')}`.trim();
    if (!joined) {
      continue;
    }
    if (/2d|箭头|几何/.test(joined) && /rope/i.test(joined)) {
      synthesizedInsights.push(
        `近期对话「${tr.title}」验证了 RoPE 优先采用 2D 箭头旋转图解的偏好。`,
      );
    } else if (/kv|cache|显存|memory/i.test(joined)) {
      synthesizedInsights.push(
        `近期对话「${tr.title}」聚焦 KV Cache 与序列显存账，已计入下轮记忆索引。`,
      );
    } else {
      synthesizedInsights.push(
        `已吸收近期讨论「${tr.title}」（${today}）中的关键问答片段。`,
      );
    }
  }

  if (synthesizedInsights.length === 0) {
    const activeNode =
      course.dag.find(n => n.status === 'current') || course.dag[0];
    synthesizedInsights.push(
      `当前主线停在「${activeNode?.title || course.title}」，已保持 ${course.profile.mathLevel} 档数学与 ${course.profile.handsOnLevel} 档动手深度。`,
    );
  }

  return {
    synthesizedInsights: Array.from(new Set(synthesizedInsights)).slice(0, 8),
    prunedNotes: Array.from(new Set(prunedNotes)).slice(0, 8),
  };
}

function discoverCrossBridges(
  course: LearnCourse,
  persistenceDir: string,
): Array<{fromTitle: string; toTitle: string; toPath: string; insight: string}> {
  const candidates: VaultNoteSummary[] = [];
  const seenPaths = new Set<string>();

  if (fs.existsSync(persistenceDir)) {
    const overview = scanKnowledgeVault(persistenceDir);
    for (const note of overview.notes) {
      const resolved = path.resolve(note.filePath);
      if (!seenPaths.has(resolved)) {
        seenPaths.add(resolved);
        candidates.push(note);
      }
    }
  }
  if (
    course.vaultDir &&
    path.resolve(course.vaultDir) !== path.resolve(persistenceDir) &&
    fs.existsSync(course.vaultDir)
  ) {
    const courseOverview = scanKnowledgeVault(course.vaultDir);
    for (const note of courseOverview.notes) {
      const resolved = path.resolve(note.filePath);
      if (!seenPaths.has(resolved)) {
        seenPaths.add(resolved);
        candidates.push(note);
      }
    }
  }

  const bridges: Array<{
    fromTitle: string;
    toTitle: string;
    toPath: string;
    insight: string;
    score: number;
  }> = [];
  const usedPaths = new Set<string>();

  const findDagTitleForNote = (
    note: VaultNoteSummary,
    fallbackTitle: string,
  ): string => {
    const hay = `${note.title} ${note.relativePath} ${note.tags.join(' ')} ${note.excerpt}`.toLowerCase();
    let bestNode: LearnDagNode | undefined;
    let bestScore = 0;
    for (const node of course.dag) {
      const tokens = `${node.id} ${node.title} ${node.summary}`
        .toLowerCase()
        .match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,6}/g) || [];
      let sc = 0;
      for (const tok of tokens) {
        if (hay.includes(tok)) {
          sc += tok.length;
        }
      }
      if (sc > bestScore) {
        bestScore = sc;
        bestNode = node;
      }
    }
    return bestNode?.title || fallbackTitle;
  };

  for (const note of candidates) {
    const combined = `${note.title} ${note.relativePath} ${note.tags.join(' ')} ${note.excerpt}`;
    for (const rule of ARCHITECTURAL_BRIDGE_RULES) {
      if (usedPaths.has(note.filePath)) {
        break;
      }
      if (
        rule.pathOrTitlePattern.test(combined) &&
        rule.courseTerms.test(combined)
      ) {
        const matchedDag =
          course.dag.find(n => n.title === rule.defaultFromTitle) ||
          course.dag.find(n => rule.courseTerms.test(`${n.id} ${n.title}`)) ||
          course.dag[0];
        const fromTitle = matchedDag?.title || rule.defaultFromTitle;
        bridges.push({
          fromTitle,
          toTitle: note.title,
          toPath: note.filePath,
          insight: rule.buildInsight(note, fromTitle),
          score: 20,
        });
        usedPaths.add(note.filePath);
      }
    }
  }

  // Fallback general keyword matching against active course DAG nodes
  const bridgeKeywords = [
    'kv cache',
    'context',
    'compact',
    'swiglu',
    'rope',
    'attention',
    'rmsnorm',
    'bpe',
    'scaling',
    'flashattention',
    'adamw',
    'transformer',
  ];

  for (const note of candidates) {
    if (usedPaths.has(note.filePath) || bridges.length >= 5) {
      continue;
    }
    const hay = `${note.title} ${note.relativePath} ${note.tags.join(' ')} ${note.excerpt}`.toLowerCase();
    const hits = bridgeKeywords.filter(kw => hay.includes(kw));
    if (hits.length === 0) {
      continue;
    }
    const fromTitle = findDagTitleForNote(
      note,
      course.dag.find(n => n.status === 'current')?.title ||
        course.dag[0]?.title ||
        course.title,
    );
    bridges.push({
      fromTitle,
      toTitle: note.title,
      toPath: note.filePath,
      insight: `笔记「${note.title}」命中共同机制锚点（${hits.slice(0, 3).join(' / ')}），可与课程节点「${fromTitle}」互相印证。`,
      score: hits.length * 4,
    });
    usedPaths.add(note.filePath);
  }

  bridges.sort((a, b) => b.score - a.score || a.toTitle.localeCompare(b.toTitle));
  const seenPairs = new Set<string>();
  const deduped: Array<{fromTitle: string; toTitle: string; toPath: string; insight: string}> = [];
  for (const b of bridges) {
    const stem = b.toTitle
      .toLowerCase()
      .replace(/v?\d+(?:\.\d+)*/g, '')
      .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
      .slice(0, 16);
    const pairKey = `${b.fromTitle}::${stem || b.toTitle.toLowerCase()}`;
    if (seenPairs.has(pairKey)) {
      continue;
    }
    seenPairs.add(pairKey);
    deduped.push({
      fromTitle: b.fromTitle,
      toTitle: b.toTitle,
      toPath: b.toPath,
      insight: b.insight,
    });
    if (deduped.length >= 3) {
      break;
    }
  }
  return deduped;
}

function buildStudyNudges(
  course: LearnCourse,
  crossBridges: LearnDreamRecord['crossBridges'],
): LearnDreamNudge[] {
  const nudges: LearnDreamNudge[] = [];
  const stuckNode = course.dag.find(n => n.status === 'stuck');
  const currentNode =
    course.dag.find(n => n.status === 'current') || course.dag[0];
  const stuckConceptEntry = Object.entries(course.profile.conceptStates).find(
    ([, v]) => v.status === 'stuck',
  );

  if (stuckNode || stuckConceptEntry) {
    const targetTitle = stuckNode?.title || stuckConceptEntry?.[0] || '卡点概念';
    const angle =
      stuckConceptEntry?.[1]?.lastAngle ||
      suggestConcreteNextAngle(targetTitle, stuckNode?.lastAttemptNote || '');
    nudges.push({
      id: `nudge-unblock-${randomUUID().slice(0, 6)}`,
      kind: 'unblock_stuck',
      title: `换个视角拆通「${targetTitle}」`,
      rationale: `此前记录卡住，Dream 建议切换路径：${angle}`,
      estimatedMinutes: 8,
      launchPrompt: `先别用纯代数硬推「${targetTitle}」，按新视角「${angle}」带我从最小具体数值例子重走一遍。`,
      targetNodeId: stuckNode?.id,
    });
  }

  if (currentNode) {
    const hasUnsureCheckin = course.livingArtifact.checkins.some(
      c => c.unsure && (!c.nodeId || c.nodeId === currentNode.id),
    );
    nudges.push({
      id: `nudge-trace-${randomUUID().slice(0, 6)}`,
      kind: hasUnsureCheckin ? 'code_bench' : 'worked_trace',
      title: hasUnsureCheckin
        ? `对照代码与实验台补全「${currentNode.title}」`
        : `巩固「${currentNode.title}」手算与边界检验`,
      rationale: hasUnsureCheckin
        ? 'Check-in 中存在标为不确定的问题，用单步实数张量与 PyTorch 形状对照直接消除盲区。'
        : '当前正处于该机制节点，做一次 5 分钟参数/显存边界自检即可解锁后续模块。',
      estimatedMinutes: 10,
      launchPrompt: `围绕「${currentNode.title}」，带我对照最小数值算例和对应代码检查第一版实现最容易踩的坑。`,
      targetNodeId: currentNode.id,
    });
  }

  if (crossBridges.length > 0) {
    const topBridge = crossBridges[0];
    nudges.push({
      id: `nudge-bridge-${randomUUID().slice(0, 6)}`,
      kind: 'cross_bridge',
      title: `跨库联结：${topBridge.fromTitle} ↔ ${topBridge.toTitle}`,
      rationale: topBridge.insight,
      estimatedMinutes: 6,
      launchPrompt: `把「${topBridge.fromTitle}」和我在笔记「${topBridge.toTitle}」里的收获放到同一张对照表里，指出两条设计在显存与信息保留上的共同约束。`,
    });
  }

  return nudges.slice(0, 3);
}

function renderLearnerMemoryMarkdown(
  course: LearnCourse,
  record: LearnDreamRecord,
): string {
  const lines: string[] = [
    `# LEARNER MEMORY · ${course.title}`,
    '',
    `- Course ID: \`${course.id}\``,
    `- Consolidated At: ${record.runAt}`,
    `- Profile: mathLevel=${course.profile.mathLevel}, handsOnLevel=${course.profile.handsOnLevel}`,
    '',
    '## Curriculum DAG Status',
  ];

  for (const node of course.dag) {
    const note = node.lastAttemptNote
      ? ` — ${node.lastAttemptNote.slice(0, 90)}`
      : '';
    lines.push(`- [${node.status}] **${node.title}** (\`${node.id}\`)${note}`);
  }

  lines.push('', '## Concept States');
  const conceptEntries = Object.entries(course.profile.conceptStates).slice(0, 12);
  if (conceptEntries.length === 0) {
    lines.push('- (none recorded yet)');
  } else {
    for (const [name, state] of conceptEntries) {
      lines.push(
        `- **${name}** [${state.status}] | angle: ${state.lastAngle.slice(0, 80)} | evidence: ${state.evidence.slice(0, 90)}`,
      );
    }
  }

  lines.push('', '## Synthesized Insights');
  for (const insight of record.synthesizedInsights.slice(0, 8)) {
    lines.push(`- ${insight}`);
  }

  if (record.prunedNotes.length > 0) {
    lines.push('', '## Pruned & Deduplicated');
    for (const pruned of record.prunedNotes.slice(0, 6)) {
      lines.push(`- ${pruned}`);
    }
  }

  lines.push('', '## Cross-Vault Bridges');
  if (record.crossBridges.length === 0) {
    lines.push('- (no cross-bridges discovered yet)');
  } else {
    for (const bridge of record.crossBridges.slice(0, 5)) {
      lines.push(
        `- **${bridge.fromTitle}** ↔ **${bridge.toTitle}** (\`${bridge.toPath}\`): ${bridge.insight}`,
      );
    }
  }

  lines.push('', '## Next Proactive Nudges');
  for (const nudge of record.nudges.slice(0, 4)) {
    lines.push(
      `- [${nudge.kind}, ~${nudge.estimatedMinutes}m] **${nudge.title}**: ${nudge.rationale}`,
    );
  }

  if (course.profile.longTermPrefs.length > 0) {
    lines.push('', '## Long-Term Reader Preferences');
    for (const pref of course.profile.longTermPrefs.slice(-4)) {
      lines.push(`- (${pref.date}) ${pref.pref}`);
    }
  }

  if (lines.length > MAX_MEMORY_INDEX_LINES) {
    return `${lines.slice(0, MAX_MEMORY_INDEX_LINES - 1).join('\n')}\n- ... (truncated to stay under 180 lines)\n`;
  }
  return `${lines.join('\n')}\n`;
}

export function runLearnDreamConsolidation(
  options: LearnDreamRunOptions,
): LearnDreamRecord {
  const athenaeumDir = path.resolve(options.athenaeumDir || DEFAULT_ATHENAEUM_DIR);
  const persistenceDir = path.resolve(
    options.persistenceDir || DEFAULT_PERSISTENCE_DIR,
  );
  const targetCourseId =
    options.courseId ||
    listLearnCourses(options.userDataDir, {athenaeumDir, persistenceDir})
      .activeCourseId ||
    ROADSHOW_CS336_COURSE_ID;

  const course =
    getLearnCourse(options.userDataDir, targetCourseId, {
      athenaeumDir,
      persistenceDir,
    }) ||
    ensureRoadshowCs336Course(options.userDataDir, {
      athenaeumDir,
      persistenceDir,
    });

  const nowIso = new Date().toISOString();
  const {synthesizedInsights, prunedNotes} = deduplicateAndPruneCourse(
    course,
    options.recentTranscripts || [],
    nowIso,
  );
  const crossBridges = discoverCrossBridges(course, persistenceDir);
  const nudges = buildStudyNudges(course, crossBridges);
  const memoryFilePath = learnerMemoryFilePath(options.userDataDir, course.id);

  const record: LearnDreamRecord = {
    id: `dream-${randomUUID().slice(0, 8)}`,
    runAt: nowIso,
    synthesizedInsights,
    prunedNotes,
    crossBridges,
    nudges,
    memoryFilePath,
  };

  const memoryMarkdown = renderLearnerMemoryMarkdown(course, record);
  atomicWriteTextSync(memoryFilePath, memoryMarkdown);

  course.dreamHistory = [...(course.dreamHistory || []), record].slice(-24);
  course.updatedAt = nowIso;
  saveLearnCourse(options.userDataDir, course);

  return record;
}

export function readLearnerMemoryIndex(
  userDataDir: string,
  courseId: string,
): string {
  const filePath = learnerMemoryFilePath(userDataDir, courseId);
  try {
    if (!fs.existsSync(filePath)) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}
