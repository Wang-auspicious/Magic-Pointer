'use strict';

declare global {
  interface ConceptTopologySummary {
    total: number;
    verified: number;
    questioned: number;
    gap: number;
    explored: number;
  }

  interface ConceptGraphController {
    cleanFormulaText(raw: string): string;
    extractTopology(conversation: MagicPointerConversation | null | undefined): {
      nodes: Array<{
        id: string;
        turnIndex: number;
        blockIndex: number;
        role: string;
        title: string;
        summary: string;
        formula?: string;
        terms: Array<{term: string; gloss: string}>;
        highlights: string[];
        status: MagicPointerLearnMasteryStatus;
        branchIds: string[];
        priority: 'P1' | 'P2' | 'P3' | '';
        prereqLabels: string[];
        attempts: number;
        note?: string;
        autoInferred?: boolean;
      }>;
      edges: Array<{fromId: string; toId: string; relation: string}>;
      prereqChains: string[][];
      summary: ConceptTopologySummary;
    };
  }

  var ConceptGraph: ConceptGraphController | undefined;
}

(() => {
  type MasteryStatus =
    | 'unseen'
    | 'explored'
    | 'questioned'
    | 'verified'
    | 'gap';

  type ConceptRole =
    | 'prerequisite'
    | 'concept'
    | 'mechanism'
    | 'formula'
    | 'compare'
    | 'trap'
    | 'conclusion';

  type EdgeRelation =
    | 'requires'
    | 'derives'
    | 'contrasts'
    | 'warns'
    | 'branches_to';

  interface ConceptNode {
    id: string;
    turnIndex: number;
    blockIndex: number;
    role: ConceptRole;
    title: string;
    summary: string;
    formula?: string;
    terms: Array<{term: string; gloss: string}>;
    highlights: string[];
    status: MasteryStatus;
    branchIds: string[];
    priority: 'P1' | 'P2' | 'P3' | '';
    prereqLabels: string[];
    attempts: number;
    note?: string;
    autoInferred?: boolean;
  }

  interface ConceptEdge {
    fromId: string;
    toId: string;
    relation: EdgeRelation;
  }

  interface ConceptTopology {
    nodes: ConceptNode[];
    edges: ConceptEdge[];
    prereqChains: string[][];
    summary: {
      total: number;
      verified: number;
      questioned: number;
      gap: number;
      explored: number;
    };
  }

  const GREEK_AND_MATH_MAP: ReadonlyArray<[RegExp, string]> = [
    [
      /\\(?:d|t)?frac\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})+)\}\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})+)\}/g,
      '($1)/($2)',
    ],
    [/\\(?:d|t)?frac\s+([^\s{}]+)\s+([^\s{}]+)/g, '($1)/($2)'],
    [/\\alpha(?![A-Za-z])/g, 'α'],
    [/\\beta(?![A-Za-z])/g, 'β'],
    [/\\gamma(?![A-Za-z])/g, 'γ'],
    [/\\delta(?![A-Za-z])/g, 'δ'],
    [/\\Delta(?![A-Za-z])/g, 'Δ'],
    [/\\(?:epsilon|varepsilon)(?![A-Za-z])/g, 'ε'],
    [/\\theta(?![A-Za-z])/g, 'θ'],
    [/\\Theta(?![A-Za-z])/g, 'Θ'],
    [/\\lambda(?![A-Za-z])/g, 'λ'],
    [/\\Lambda(?![A-Za-z])/g, 'Λ'],
    [/\\mu(?![A-Za-z])/g, 'μ'],
    [/\\sigma(?![A-Za-z])/g, 'σ'],
    [/\\Sigma(?![A-Za-z])/g, 'Σ'],
    [/\\sum(?![A-Za-z])/g, '∑'],
    [/\\prod(?![A-Za-z])/g, '∏'],
    [/\\int(?![A-Za-z])/g, '∫'],
    [/\\pi(?![A-Za-z])/g, 'π'],
    [/\\rho(?![A-Za-z])/g, 'ρ'],
    [/\\tau(?![A-Za-z])/g, 'τ'],
    [/\\nu(?![A-Za-z])/g, 'ν'],
    [/\\kappa(?![A-Za-z])/g, 'κ'],
    [/\\(?:phi|varphi)(?![A-Za-z])/g, 'φ'],
    [/\\psi(?![A-Za-z])/g, 'ψ'],
    [/\\omega(?![A-Za-z])/g, 'ω'],
    [/\\Omega(?![A-Za-z])/g, 'Ω'],
    [/\\eta(?![A-Za-z])/g, 'η'],
    [/\\nabla(?![A-Za-z])/g, '∇'],
    [/\\partial(?![A-Za-z])/g, '∂'],
    [/\\infty(?![A-Za-z])/g, '∞'],
    [/\\mid(?![A-Za-z])/g, '|'],
    [/\\(?:ge|geq)(?![A-Za-z])/g, '≥'],
    [/\\(?:le|leq)(?![A-Za-z])/g, '≤'],
    [/\\(?:neq|ne)(?![A-Za-z])/g, '≠'],
    [/\\approx(?![A-Za-z])/g, '≈'],
    [/\\cdot(?![A-Za-z])/g, '·'],
    [/\\times(?![A-Za-z])/g, '×'],
    [/\\(argmin|argmax|arg|min|max|exp|log|ln)(?![A-Za-z])/g, '$1'],
    [/\\(?:to|rightarrow)(?![A-Za-z])/g, '→'],
    [/\\Rightarrow(?![A-Za-z])/g, '⇒'],
    [/\\in(?![A-Za-z])/g, '∈'],
    [/\\subset(?![A-Za-z])/g, '⊂'],
    [/\\sqrt(?![A-Za-z])/g, '√'],
    [/\\mathbb\{R\}/g, 'ℝ'],
    [/\\mathbb\{E\}/g, '𝔼'],
    [/\\mathbb\{([^}]+)\}/g, '$1'],
    [/\\(?:left|right|text|mathrm|mathbf|boldsymbol|quad|qquad)(?![A-Za-z])/g, ''],
    [/\\[,;!]/g, ''],
    [/\^\s*\\\*/g, '^*'],
    [/\{\s*\\\*\s*\}/g, '{*}'],
  ];

  const SUBSCRIPTS: Readonly<Record<string, string>> = {
    '0': '₀',
    '1': '₁',
    '2': '₂',
    '3': '₃',
    '4': '₄',
    '5': '₅',
    '6': '₆',
    '7': '₇',
    '8': '₈',
    '9': '₉',
    a: 'ₐ',
    i: 'ᵢ',
    j: 'ⱼ',
    k: 'ₖ',
    m: 'ₘ',
    n: 'ₙ',
    t: 'ₜ',
    x: 'ₓ',
  };

  const SUPERSCRIPTS: Readonly<Record<string, string>> = {
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '*': '⁎',
    T: 'ᵀ',
  };

  /** Convert raw LaTeX expressions into crisp readable Unicode labels for UI chips. */
  function cleanFormulaText(raw: string): string {
    let text = String(raw || '')
      .replace(/\$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) {
      return '';
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const [pattern, replacement] of GREEK_AND_MATH_MAP) {
        text = text.replace(pattern, replacement);
      }
    }
    text = text.replace(/_\{([A-Za-z0-9]+)\}/g, (_m, sub: string) =>
      sub
        .split('')
        .map(ch => SUBSCRIPTS[ch] ?? ch)
        .join(''),
    );
    text = text.replace(/_([A-Za-z0-9])\b/g, (_m, ch: string) =>
      SUBSCRIPTS[ch] ?? `_${ch}`,
    );
    text = text.replace(/\^\{([0-9*T]+)\}/g, (_m, sup: string) =>
      sup
        .split('')
        .map(ch => SUPERSCRIPTS[ch] ?? ch)
        .join(''),
    );
    text = text.replace(/\^([0-9*T])/g, (_m, ch: string) =>
      SUPERSCRIPTS[ch] ?? `^${ch}`,
    );
    return text
      .replace(/\\(?:d|t)?frac(?![A-Za-z])/g, '')
      .replace(/\\([A-Za-z]+)(?![A-Za-z])/g, '')
      .replace(/[{}]/g, '')
      .replace(/\s*\|\s*/g, ' | ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function stripMarkupForSummary(raw: string): string {
    return String(raw || '')
      .replace(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g, '$1')
      .replace(/==([^=\n]+)==/g, '$1')
      .replace(/==/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*\*/g, '')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\$\$([^$]+)\$\$/g, (_m, tex: string) => cleanFormulaText(tex))
      .replace(/\$([^$\n]+)\$/g, (_m, tex: string) => cleanFormulaText(tex))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractInlineSignals(raw: string): {
    terms: Array<{term: string; gloss: string}>;
    highlights: string[];
    formula?: string;
  } {
    const terms: Array<{term: string; gloss: string}> = [];
    const highlights: string[] = [];
    let match: RegExpExecArray | null;

    const termRe = /\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g;
    while ((match = termRe.exec(raw)) !== null) {
      terms.push({term: match[1].trim(), gloss: match[2].trim()});
    }

    const hlRe = /==([^=\n]+)==/g;
    while ((match = hlRe.exec(raw)) !== null) {
      highlights.push(stripMarkupForSummary(match[1]));
    }

    const displayMath = /\$\$([\s\S]+?)\$\$/.exec(raw);
    const inlineMath = /\$([^$\n]+)\$/.exec(raw);
    const rawMath = displayMath?.[1] || inlineMath?.[1];
    const formula = rawMath ? cleanFormulaText(rawMath).slice(0, 80) : undefined;
    return {terms, highlights, formula};
  }

  function mapCardRole(rawCat: string, title: string, body: string): ConceptRole {
    const cat = rawCat.toLowerCase();
    if (cat === 'formula') {
      return 'formula';
    }
    if (cat === 'trap') {
      return 'trap';
    }
    if (cat === 'compare') {
      return /结论|总结|条件|适用|threshold|conclusion/i.test(`${title} ${body}`)
        ? 'conclusion'
        : 'compare';
    }
    if (cat === 'mechanism') {
      return 'mechanism';
    }
    if (/结论|适用条件|conclusion/i.test(title)) {
      return 'conclusion';
    }
    if (/前置|基础|prereq/i.test(title)) {
      return 'prerequisite';
    }
    return 'concept';
  }

  function priorityRank(raw: unknown): number {
    const up = String(raw || '').trim().toUpperCase();
    if (up === 'P1' || up === 'HIGH') {
      return 0;
    }
    if (up === 'P2' || up === 'MEDIUM') {
      return 1;
    }
    if (up === 'P3' || up === 'LOW') {
      return 2;
    }
    return 9;
  }

  function normalizePriority(raw: unknown): 'P1' | 'P2' | 'P3' | '' {
    const up = String(raw || '').trim().toUpperCase();
    if (up === 'P1' || up === 'HIGH') {
      return 'P1';
    }
    if (up === 'P2' || up === 'MEDIUM') {
      return 'P2';
    }
    if (up === 'P3' || up === 'LOW') {
      return 'P3';
    }
    return '';
  }

  function parseMarkdownUnits(answer: string): {
    prereqChains: string[][];
    units: Array<{
      blockIndex: number;
      role: ConceptRole;
      title: string;
      rawBody: string;
    }>;
  } {
    const lines = String(answer || '').replace(/\r\n/g, '\n').split('\n');
    const prereqChains: string[][] = [];
    const units: Array<{
      blockIndex: number;
      role: ConceptRole;
      title: string;
      rawBody: string;
    }> = [];

    let blockIndex = 0;
    let i = 0;
    let pendingHeading = '';

    while (i < lines.length) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (!trimmed) {
        i++;
        continue;
      }

      // Skip fenced code blocks cleanly while preserving block count alignment
      if (/^```/.test(trimmed)) {
        const start = i + 1;
        i++;
        while (i < lines.length && !/^```/.test(lines[i]!.trim())) {
          i++;
        }
        const codeBody = lines.slice(start, i).join('\n');
        units.push({
          blockIndex,
          role: 'mechanism',
          title: pendingHeading || '代码 / 实现细节',
          rawBody: codeBody.slice(0, 240),
        });
        pendingHeading = '';
        if (i < lines.length) {
          i++;
        }
        blockIndex++;
        continue;
      }

      // Parse :::prereq dependency chain declarations (consumes block slot when rendered)
      if (/^:::prereq\b/i.test(trimmed)) {
        const start = i + 1;
        i++;
        while (i < lines.length && lines[i]!.trim() !== ':::') {
          i++;
        }
        const bodyLines = lines
          .slice(start, i)
          .map(item => item.trim())
          .filter(Boolean);
        for (const chainLine of bodyLines) {
          const parts = chainLine
            .split(/\s*(?:->|→|=>)\s*/)
            .map(part => cleanFormulaText(part))
            .filter(Boolean);
          if (parts.length >= 2) {
            prereqChains.push(parts);
          }
        }
        if (i < lines.length) {
          i++;
        }
        blockIndex++;
        continue;
      }

      // Parse :::lab interactive blocks as mechanism/formula explorer nodes
      const labMatch = /^:::lab\b(.*)$/i.exec(trimmed);
      if (labMatch) {
        const start = i + 1;
        i++;
        while (i < lines.length && lines[i]!.trim() !== ':::') {
          i++;
        }
        const rawJson = lines.slice(start, i).join('\n').trim();
        let labTitle = labMatch[1].trim() || '交互参数实验';
        try {
          const parsed = JSON.parse(rawJson) as {title?: string; caption?: string};
          if (parsed.title) {
            labTitle = String(parsed.title);
          }
        } catch {
          /* ignore incomplete JSON while streaming */
        }
        units.push({
          blockIndex,
          role: 'formula',
          title: pendingHeading || labTitle,
          rawBody: rawJson.slice(0, 200),
        });
        pendingHeading = '';
        if (i < lines.length) {
          i++;
        }
        blockIndex++;
        continue;
      }

      // Parse :::card [cat] Title
      const cardMatch = /^:::card(?:\s+\[([^\]]+)\])?\s*(.*)$/i.exec(trimmed);
      if (cardMatch) {
        const cat = (cardMatch[1] || 'concept').trim();
        const title = (cardMatch[2] || '').trim() || pendingHeading || cat;
        const start = i + 1;
        i++;
        while (i < lines.length && lines[i]!.trim() !== ':::') {
          i++;
        }
        const body = lines.slice(start, i).join('\n').trim();
        units.push({
          blockIndex,
          role: mapCardRole(cat, title, body),
          title,
          rawBody: body,
        });
        pendingHeading = '';
        if (i < lines.length) {
          i++;
        }
        blockIndex++;
        continue;
      }

      // Markdown headings anchor the next block without inflating leaf count unnecessarily
      const headingMatch = /^#{1,4}\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        pendingHeading = stripMarkupForSummary(headingMatch[1]);
        blockIndex++;
        i++;
        continue;
      }

      // Standalone display math block
      if (trimmed.startsWith('$$')) {
        let mathBody = trimmed;
        if (!trimmed.endsWith('$$') || trimmed === '$$') {
          const start = i;
          i++;
          while (i < lines.length && !lines[i]!.trim().endsWith('$$')) {
            i++;
          }
          mathBody = lines.slice(start, i + 1).join('\n');
        }
        units.push({
          blockIndex,
          role: 'formula',
          title: pendingHeading || cleanFormulaText(mathBody).slice(0, 36) || '核心公式',
          rawBody: mathBody,
        });
        pendingHeading = '';
        blockIndex++;
        i++;
        continue;
      }

      // Plain paragraph / list block fallback
      const paraLines = [trimmed];
      i++;
      while (
        i < lines.length &&
        lines[i]!.trim() !== '' &&
        !/^(?:#{1,4}\s|:::|\$\$|```)/.test(lines[i]!.trim())
      ) {
        paraLines.push(lines[i]!.trim());
        i++;
      }
      const rawBody = paraLines.join(' ');
      const cleaned = stripMarkupForSummary(rawBody);
      if (cleaned.length >= 6) {
        const hasFormula = /\$\$?[^$\n]+\$\$?/.test(rawBody);
        const inferredRole: ConceptRole = /陷阱|注意|误区|失效|trap|warning/i.test(
          cleaned,
        )
          ? 'trap'
          : /结论|因此|所以|综上所述|阈值|适用/i.test(cleaned)
            ? 'conclusion'
            : hasFormula
              ? 'formula'
              : pendingHeading
                ? 'concept'
                : 'mechanism';
        const titleCandidate = cleaned
          .replace(/^\s*(?:\d+[.)、]\s*|[-*•]\s+)/, '')
          .split(/[：:。；!?]/)[0]
          .replace(/^[（(]+/, '')
          .trim()
          .slice(0, 28);
        const autoTitle =
          pendingHeading ||
          (titleCandidate.length >= 3 ? titleCandidate : '') ||
          `要点 ${blockIndex + 1}`;
        units.push({
          blockIndex,
          role: inferredRole,
          title: autoTitle,
          rawBody,
        });
      }
      pendingHeading = '';
      blockIndex++;
    }

    return {prereqChains, units};
  }

  const AUTO_GAP_RE =
    /(没懂|不懂|看不懂|糊涂|卡住|困惑|不明白|为啥还是|哪里错|搞错|弄混|混淆|区别在哪|搞反|为什么不行|为什么不能|还是有点乱)/i;
  const AUTO_VERIFIED_RE =
    /(懂了|明白了|清楚了|原来如此|搞懂|通了|没问题了|理解了|谢谢|get了)/i;

  const GENERIC_TOPIC_TOKENS = new Set([
    '概念',
    '要点',
    '模块',
    '机制',
    '原理',
    '部分',
    '补充',
    '总结',
    '结论',
    '步骤',
    '问题',
    '例子',
    '示例',
    '基础',
  ]);

  function inferAutoMasteryStatus(options: {
    turnIndex: number;
    totalTurns: number;
    title: string;
    rawBody: string;
    matchingBranches: MagicPointerLearnBranch[];
    turns: NonNullable<MagicPointerConversation['turns']>;
  }): MasteryStatus {
    const {turnIndex, totalTurns, title, rawBody, matchingBranches, turns} =
      options;
    const branchQuestions = matchingBranches
      .flatMap(br => (br.turns || []).map(t => String(t.question || '')))
      .join('\n');
    if (AUTO_GAP_RE.test(branchQuestions)) {
      return 'gap';
    }
    const laterTurns = turns.slice(turnIndex + 1);
    const laterQuestions = laterTurns
      .map(t => String(t.question || ''))
      .join('\n');
    const normTitle = title.trim().toLowerCase();
    const laterLower = laterQuestions.toLowerCase();
    const rawTokens = normTitle
      .split(/[\s·\-:：,/()（）]+/)
      .filter(tok => tok.length >= 2 && !GENERIC_TOPIC_TOKENS.has(tok));
    const hasSpecificDigits = /\d/.test(normTitle);
    const laterMentionsNode =
      laterLower.trim().length > 0 &&
      (hasSpecificDigits
        ? laterLower.includes(normTitle)
        : normTitle.length >= 2 &&
          (laterLower.includes(normTitle) ||
            rawTokens.some(tok => laterLower.includes(tok))));
    if (laterMentionsNode && AUTO_GAP_RE.test(laterQuestions)) {
      return 'gap';
    }
    if (matchingBranches.length > 0) {
      const hasMultiTurnOrSettled = matchingBranches.some(
        br => (br.turns?.length || 0) >= 2 && AUTO_VERIFIED_RE.test(branchQuestions),
      );
      if (hasMultiTurnOrSettled || AUTO_VERIFIED_RE.test(laterQuestions)) {
        return 'verified';
      }
      if (turnIndex < totalTurns - 1 && !laterMentionsNode) {
        return 'verified';
      }
      return 'questioned';
    }
    if (
      (laterMentionsNode && AUTO_VERIFIED_RE.test(laterQuestions)) ||
      (turnIndex < totalTurns - 1 && !laterMentionsNode)
    ) {
      return 'verified';
    }
    void rawBody;
    return 'explored';
  }

  function consolidateTopology(
    rawNodes: ConceptNode[],
    rawEdges: ConceptEdge[],
    maxNodes = 8,
  ): {nodes: ConceptNode[]; edges: ConceptEdge[]} {
    if (rawNodes.length <= maxNodes) {
      return {nodes: rawNodes, edges: rawEdges};
    }
    const nodes = rawNodes.map(n => ({
      ...n,
      terms: [...n.terms],
      highlights: [...n.highlights],
      branchIds: [...n.branchIds],
      prereqLabels: [...n.prereqLabels],
    }));
    const remap = new Map<string, string>();
    const roleKeepScore = (n: ConceptNode): number => {
      let score = 0;
      if (n.role === 'formula') {
        score += 5;
      } else if (n.role === 'trap') {
        score += 4;
      } else if (n.role === 'conclusion') {
        score += 4;
      } else if (n.role === 'compare') {
        score += 3;
      } else if (n.role === 'prerequisite') {
        score += 2;
      }
      if (n.branchIds.length > 0) {
        score += 4;
      }
      if (n.status === 'gap' || n.status === 'questioned') {
        score += 3;
      }
      if (n.highlights.length > 0) {
        score += 2;
      }
      return score;
    };

    while (nodes.length > maxNodes) {
      let mergeIdx = -1;
      let lowestScore = Infinity;
      for (let i = 1; i < nodes.length; i++) {
        const s = roleKeepScore(nodes[i]!);
        if (s < lowestScore) {
          lowestScore = s;
          mergeIdx = i;
        }
      }
      if (mergeIdx <= 0) {
        break;
      }
      const victim = nodes[mergeIdx]!;
      let target = nodes[mergeIdx - 1]!;
      for (let j = mergeIdx - 1; j >= 0; j--) {
        if (nodes[j]!.turnIndex === victim.turnIndex) {
          target = nodes[j]!;
          break;
        }
      }
      for (const bid of victim.branchIds) {
        if (!target.branchIds.includes(bid)) {
          target.branchIds.push(bid);
        }
      }
      for (const hl of victim.highlights) {
        if (!target.highlights.includes(hl) && target.highlights.length < 3) {
          target.highlights.push(hl);
        }
      }
      if (victim.status === 'gap') {
        target.status = 'gap';
      } else if (
        victim.status === 'questioned' &&
        target.status !== 'gap'
      ) {
        target.status = 'questioned';
      }
      remap.set(victim.id, target.id);
      nodes.splice(mergeIdx, 1);
    }

    const resolveId = (id: string): string => {
      let cur = id;
      const seen = new Set<string>();
      while (remap.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = remap.get(cur)!;
      }
      return cur;
    };

    const edgeKeys = new Set<string>();
    const edges: ConceptEdge[] = [];
    for (const e of rawEdges) {
      const fromId = resolveId(e.fromId);
      const toId = resolveId(e.toId);
      if (fromId === toId) {
        continue;
      }
      const k = `${fromId}->${toId}:${e.relation}`;
      if (!edgeKeys.has(k)) {
        edgeKeys.add(k);
        edges.push({fromId, toId, relation: e.relation});
      }
    }
    return {nodes, edges};
  }

  function extractTopology(
    conversation: MagicPointerConversation | null | undefined,
  ): ConceptTopology {
    const nodes: ConceptNode[] = [];
    const edges: ConceptEdge[] = [];
    const prereqChains: string[][] = [];

    if (!conversation) {
      return {
        nodes,
        edges,
        prereqChains,
        summary: {total: 0, verified: 0, questioned: 0, gap: 0, explored: 0},
      };
    }

    const masteryMap =
      conversation.learnMastery && typeof conversation.learnMastery === 'object'
        ? conversation.learnMastery
        : {};
    const rootBranches = (conversation.branches || []).filter(
      br => br.parentBranchId === null,
    );

    const turns = conversation.turns || [];
    turns.forEach((turn, turnIndex) => {
      const answer = String(turn.answer || '');
      if (!answer.trim()) {
        return;
      }
      const parsed = parseMarkdownUnits(answer);
      prereqChains.push(...parsed.prereqChains);

      const prereqNodeIds: string[] = [];
      for (const chain of parsed.prereqChains) {
        let prevPrereqId = '';
        for (const label of chain) {
          const existing = nodes.find(
            node =>
              node.title.toLowerCase() === label.toLowerCase() ||
              label.toLowerCase().includes(node.title.toLowerCase()),
          );
          if (existing) {
            if (prevPrereqId && prevPrereqId !== existing.id) {
              edges.push({
                fromId: prevPrereqId,
                toId: existing.id,
                relation: 'requires',
              });
            }
            prevPrereqId = existing.id;
            continue;
          }
          // Only create virtual prerequisite nodes for items not matching parsed section headings
          const matchesUnit = parsed.units.some(u =>
            u.title.toLowerCase().includes(label.toLowerCase()) ||
            label.toLowerCase().includes(u.title.toLowerCase()),
          );
          if (!matchesUnit) {
            const pId = `t${turnIndex}:prereq:${nodes.length}`;
            const saved = masteryMap[pId];
            nodes.push({
              id: pId,
              turnIndex,
              blockIndex: -1,
              role: 'prerequisite',
              title: cleanFormulaText(label) || label,
              summary: '前置依赖概念',
              terms: [],
              highlights: [],
              status: saved?.status || 'unseen',
              branchIds: [],
              priority: '',
              prereqLabels: [],
              attempts: Number(saved?.attempts || 0),
              note: saved?.note,
            });
            prereqNodeIds.push(pId);
            if (prevPrereqId) {
              edges.push({fromId: prevPrereqId, toId: pId, relation: 'requires'});
            }
            prevPrereqId = pId;
          }
        }
      }

      const turnBranches = rootBranches.filter(
        br => br.parentTurnIndex === turnIndex,
      );
      let prevUnitNodeId = prereqNodeIds.at(-1) || '';

      for (const unit of parsed.units) {
        const nodeId = `t${turnIndex}:b${unit.blockIndex}`;
        const signals = extractInlineSignals(unit.rawBody);
        const matchingBranches = turnBranches.filter(br => {
          if (typeof br.anchor?.blockIndex === 'number') {
            return br.anchor.blockIndex === unit.blockIndex;
          }
          const lbl = String(br.anchor?.label || '').trim();
          return (
            Boolean(lbl) &&
            (unit.title.includes(lbl) || unit.rawBody.includes(lbl))
          );
        });
        matchingBranches.sort(
          (a, b) =>
            priorityRank(a.anchor?.priority) - priorityRank(b.anchor?.priority),
        );
        const topPriority = matchingBranches
          .map(b => normalizePriority(b.anchor?.priority))
          .find(Boolean) || '';

        const savedMastery = masteryMap[nodeId];
        const status: MasteryStatus = savedMastery?.status
          ? savedMastery.status
          : inferAutoMasteryStatus({
              turnIndex,
              totalTurns: turns.length,
              title: cleanFormulaText(unit.title) || unit.title,
              rawBody: unit.rawBody,
              matchingBranches,
              turns,
            });
        const autoInferred = !savedMastery?.status;

        const prereqLabels: string[] = [];
        for (const chain of parsed.prereqChains) {
          const hitIdx = chain.findIndex(
            item =>
              unit.title.toLowerCase().includes(item.toLowerCase()) ||
              item.toLowerCase().includes(unit.title.toLowerCase()),
          );
          if (hitIdx > 0) {
            prereqLabels.push(chain[hitIdx - 1]!);
          }
        }

        const plainSummary = stripMarkupForSummary(unit.rawBody);
        const rawSummary =
          signals.highlights[0] ||
          (plainSummary.length > 110
            ? `${plainSummary.slice(0, 110)}…`
            : plainSummary);
        nodes.push({
          id: nodeId,
          turnIndex,
          blockIndex: unit.blockIndex,
          role: unit.role,
          title: cleanFormulaText(unit.title) || unit.title,
          summary: cleanFormulaText(rawSummary) || rawSummary,
          formula: signals.formula,
          terms: signals.terms,
          highlights: signals.highlights,
          status,
          branchIds: matchingBranches.map(b => b.id),
          priority: topPriority,
          prereqLabels,
          attempts: Number(savedMastery?.attempts || 0),
          note: savedMastery?.note,
          autoInferred,
        });

        if (prevUnitNodeId) {
          edges.push({
            fromId: prevUnitNodeId,
            toId: nodeId,
            relation:
              unit.role === 'trap'
                ? 'warns'
                : unit.role === 'compare'
                  ? 'contrasts'
                  : unit.role === 'formula'
                    ? 'derives'
                    : 'requires',
          });
        }
        prevUnitNodeId = nodeId;
      }
    });

    const consolidated = consolidateTopology(nodes, edges, 8);
    const summary = {
      total: consolidated.nodes.length,
      verified: consolidated.nodes.filter(n => n.status === 'verified').length,
      questioned: consolidated.nodes.filter(n => n.status === 'questioned').length,
      gap: consolidated.nodes.filter(n => n.status === 'gap').length,
      explored: consolidated.nodes.filter(n => n.status === 'explored').length,
    };

    return {
      nodes: consolidated.nodes,
      edges: consolidated.edges,
      prereqChains,
      summary,
    };
  }

  const ConceptGraphApi = {
    cleanFormulaText,
    extractTopology,
    parseMarkdownUnits,
  };

  if (typeof globalThis !== 'undefined') {
    (
      globalThis as typeof globalThis & {
        ConceptGraph?: typeof ConceptGraphApi;
      }
    ).ConceptGraph = ConceptGraphApi;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = ConceptGraphApi;
  }
})();
