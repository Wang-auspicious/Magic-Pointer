'use strict';

(() => {
  type SaliencyLevel = 0 | 1 | 2 | 3;

  type SaliencyLocale = 'en' | 'zh-Hans';

  type TokenReason =
    | 'negation'
    | 'quantifier'
    | 'number'
    | 'condition'
    | 'entity'
    | 'technical'
    | 'emphasis'
    | 'skeleton'
    | 'content'
    | 'supporting'
    | 'function'
    | 'punctuation';

  interface ScoreParagraphOptions {
    locale?: SaliencyLocale | 'auto';
  }

  interface CompressedLevelsMap {
    level1?: string;
    level2?: string;
    level3?: string;
    l1?: string;
    l2?: string;
    l3?: string;
  }

  type CompressedLevelsInput = readonly string[] | CompressedLevelsMap;

  interface ApplyOptions {
    locale?: SaliencyLocale | 'auto';
    compressedLevels?: CompressedLevelsInput;
    reveal?: boolean;
  }

  interface ScoredToken {
    text: string;
    start: number;
    end: number;
    isWord: boolean;
    level: SaliencyLevel;
    clauseIndex: number;
    protected: boolean;
    reason: TokenReason;
  }

  interface ScoredClause {
    index: number;
    start: number;
    end: number;
    wordCount: number;
    darkCount: number;
    tokens: ScoredToken[];
  }

  interface ScoredParagraph {
    text: string;
    locale: SaliencyLocale;
    tokens: ScoredToken[];
    words: ScoredToken[];
    clauses: ScoredClause[];
    durationMs: number;
  }

  interface SegmentSlice {
    segment: string;
    index: number;
    isWordLike: boolean;
  }

  interface EditableTextRun {
    kind: 'text';
    node: Text;
    text: string;
    inStrong: boolean;
    start: number;
    end: number;
  }

  interface IslandRun {
    kind: 'island';
    text: string;
    start: number;
    end: number;
  }

  type BlockRun = EditableTextRun | IslandRun;

  const HAS_INTL_SEGMENTER =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
  const EN_SEGMENTER = HAS_INTL_SEGMENTER
    ? new Intl.Segmenter('en', {granularity: 'word'})
    : null;
  const ZH_SEGMENTER = HAS_INTL_SEGMENTER
    ? new Intl.Segmenter('zh-Hans', {granularity: 'word'})
    : null;

  const CJK_RE = /[\u4e00-\u9fff]/;
  const DIGIT_RE = /\d/;
  const SENTENCE_END_PUNCT_RE = /[.!?。！？；;\n]/;
  const CLAUSE_BREAK_PUNCT_RE = /[,，、:：—–()（）[\]【】「」『』]/;
  const EN_VERB_SUFFIX_RE = /(?:ing|ed|es|ies|ize|ise|ate|ify|en|s)$/i;
  const EN_NOUN_SUFFIX_RE =
    /(?:tion|sion|ment|ness|ity|ance|ence|ship|ism|ist|er|or|ry|al)$/i;
  const ZH_VERB_PREV_CUES = new Set([
    '把',
    '被',
    '将',
    '对',
    '向',
    '给',
    '能',
    '会',
    '要',
    '可以',
    '应该',
    '必须',
    '无法',
    '不能',
    '不会',
  ]);
  const ZH_VERB_NEXT_CUES = new Set(['了', '过', '着']);

  const EN_NEGATIONS = new Set([
    'not',
    'never',
    'no',
    'none',
    'nothing',
    'nowhere',
    'nobody',
    'neither',
    'nor',
    'cannot',
    'without',
    'hardly',
    'scarcely',
    'barely',
    'seldom',
    'rarely',
    'lack',
    'lacks',
    'lacking',
    'except',
    'unless',
  ]);

  const EN_QUANTIFIERS = new Set([
    'all',
    'only',
    'every',
    'each',
    'any',
    'both',
    'always',
    'must',
    'required',
    'zero',
    'single',
    'sole',
    'most',
    'least',
    'many',
    'few',
    'several',
    'half',
    'double',
    'triple',
    'first',
    'second',
    'third',
    'last',
    'maximum',
    'minimum',
    'max',
    'min',
    'entire',
    'whole',
    'total',
  ]);

  const EN_FUNCTION_L0 = new Set([
    'a',
    'an',
    'the',
    'of',
    'to',
    'in',
    'on',
    'at',
    'by',
    'for',
    'as',
    'from',
    'with',
    'into',
    'onto',
    'upon',
    'per',
    'via',
    'and',
    'or',
    'but',
    'so',
    'yet',
    'than',
    'that',
    'off',
    'up',
    'out',
  ]);

  const EN_SUPPORTING_L1 = new Set([
    'i',
    'you',
    'he',
    'she',
    'it',
    'we',
    'they',
    'me',
    'him',
    'her',
    'us',
    'them',
    'my',
    'your',
    'his',
    'its',
    'our',
    'their',
    'this',
    'these',
    'those',
    'who',
    'whom',
    'whose',
    'which',
    'what',
    'where',
    'when',
    'why',
    'how',
    'while',
    'then',
    'moreover',
    'furthermore',
    'meanwhile',
    'instead',
    'about',
    'across',
    'after',
    'against',
    'along',
    'among',
    'around',
    'before',
    'behind',
    'below',
    'beneath',
    'beside',
    'between',
    'beyond',
    'during',
    'inside',
    'near',
    'outside',
    'over',
    'through',
    'throughout',
    'toward',
    'towards',
    'under',
    'underneath',
    'until',
    'within',
    'am',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'shall',
    'should',
    'can',
    'could',
    'may',
    'might',
    'also',
    'just',
    'even',
    'still',
    'already',
    'soon',
    'now',
    'here',
    'there',
    'very',
    'quite',
    'rather',
    'really',
    'actually',
    'typically',
    'generally',
    'usually',
    'often',
    'sometimes',
    'perhaps',
    'maybe',
    'such',
    'some',
    'more',
    'much',
    'other',
    'another',
    'same',
    'own',
    'well',
  ]);

  const EN_MODALS_AUX = new Set([
    'will',
    'would',
    'shall',
    'should',
    'can',
    'could',
    'may',
    'might',
    'must',
    'do',
    'does',
    'did',
    'has',
    'have',
    'had',
    'to',
  ]);

  const EN_DET_CUES = new Set([
    'the',
    'a',
    'an',
    'this',
    'that',
    'these',
    'those',
    'each',
    'every',
    'my',
    'our',
    'their',
    'its',
  ]);

  const ZH_NEGATION_PREFIX_RE =
    /^(?:也|都|还|却|并|绝|决|从|更|才|再)?(?:不|没|无|别|未|莫|勿)|^(?:并非|绝非|莫非|除非|非)$/;

  const ZH_NEGATION_EXACT = new Set([
    '不',
    '没',
    '没有',
    '非',
    '无',
    '别',
    '未',
    '莫',
    '勿',
    '否',
    '并非',
    '绝非',
    '莫非',
    '除非',
    '不是',
    '不能',
    '不可',
    '不会',
    '不用',
    '不要',
    '不得',
    '无法',
    '毫无',
    '决不',
    '绝不',
    '从不',
    '从未',
    '未必',
    '并不',
    '并未',
    '不再',
    '不必',
    '也不能',
    '也不',
    '都不',
    '还不',
    '却不',
    '仍不',
    '也没',
    '都没',
    '还没',
  ]);

  const ZH_QUANTIFIERS = new Set([
    '所有',
    '全部',
    '全部都',
    '全部的',
    '仅',
    '仅仅',
    '只',
    '只有',
    '只要',
    '每',
    '每个',
    '每次',
    '每当',
    '一切',
    '任何',
    '唯一',
    '必须',
    '总是',
    '永远',
    '至少',
    '至多',
    '最多',
    '最少',
    '零',
    '第一',
    '第二',
    '第三',
    '首先',
    '最后',
    '完全',
  ]);

  const ZH_FUNCTION_L0 = new Set([
    '的',
    '地',
    '得',
    '了',
    '着',
    '过',
    '吗',
    '呢',
    '吧',
    '啊',
    '呀',
    '哦',
    '嘛',
    '之',
    '于',
    '和',
    '与',
    '及',
    '并',
    '而',
    '以',
    '在',
    '从',
    '上',
    '下',
    '中',
    '里',
    '内',
    '时',
    '后',
    '前',
    '等',
  ]);

  const ZH_SUPPORTING_L1 = new Set([
    '是',
    '有',
    '会',
    '能',
    '可以',
    '可能',
    '应该',
    '需要',
    '将',
    '把',
    '被',
    '对',
    '向',
    '为',
    '给',
    '让',
    '由',
    '按',
    '按照',
    '通过',
    '根据',
    '关于',
    '或者',
    '或',
    '以及',
    '而且',
    '并且',
    '同时',
    '此外',
    '例如',
    '比如',
    '就是',
    '也',
    '都',
    '还',
    '就',
    '才',
    '再',
    '又',
    '已',
    '已经',
    '正在',
    '非常',
    '比较',
    '通常',
    '一般',
    '很',
    '更',
    '最',
    '这',
    '那',
    '这个',
    '那个',
    '这些',
    '那些',
    '这里',
    '那里',
    '它',
    '它们',
    '他',
    '他们',
    '她',
    '她们',
    '我',
    '我们',
    '你',
    '你们',
    '其',
    '其中',
    '某',
    '某些',
    '各自',
    '情况',
  ]);

  const SKIP_TAGS = new Set([
    'PRE',
    'CODE',
    'KBD',
    'SAMP',
    'BUTTON',
    'TABLE',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
    'SVG',
    'MATH',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'IFRAME',
  ]);

  const BLOCK_TAGS = new Set([
    'P',
    'LI',
    'UL',
    'OL',
    'DL',
    'DD',
    'DT',
    'BLOCKQUOTE',
    'DIV',
    'SECTION',
    'ARTICLE',
    'ASIDE',
    'MAIN',
    'HEADER',
    'FOOTER',
    'NAV',
    'FIGCAPTION',
    'FIGURE',
    'ADDRESS',
    'DETAILS',
    'SUMMARY',
    'HR',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'PRE',
    'TABLE',
  ]);

  function nowMs(): number {
    if (
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
    ) {
      return performance.now();
    }
    return Date.now();
  }

  function detectLocale(
    text: string,
    preferred?: SaliencyLocale | 'auto',
  ): SaliencyLocale {
    if (preferred === 'en' || preferred === 'zh-Hans') {
      return preferred;
    }
    return CJK_RE.test(text) ? 'zh-Hans' : 'en';
  }

  function segmentText(text: string, locale: SaliencyLocale): SegmentSlice[] {
    if (!text) {
      return [];
    }
    const segmenter = locale === 'zh-Hans' ? ZH_SEGMENTER : EN_SEGMENTER;
    if (segmenter) {
      const slices: SegmentSlice[] = [];
      for (const item of segmenter.segment(text)) {
        slices.push({
          segment: item.segment,
          index: item.index,
          isWordLike: Boolean(item.isWordLike),
        });
      }
      return slices;
    }
    const slices: SegmentSlice[] = [];
    const fallbackRe = /[\u4e00-\u9fff]|[A-Za-z0-9]+(?:['._-][A-Za-z0-9]+)*/g;
    let cursor = 0;
    let match = fallbackRe.exec(text);
    while (match) {
      if (match.index > cursor) {
        slices.push({
          segment: text.slice(cursor, match.index),
          index: cursor,
          isWordLike: false,
        });
      }
      slices.push({
        segment: match[0],
        index: match.index,
        isWordLike: true,
      });
      cursor = match.index + match[0].length;
      match = fallbackRe.exec(text);
    }
    if (cursor < text.length) {
      slices.push({
        segment: text.slice(cursor),
        index: cursor,
        isWordLike: false,
      });
    }
    return slices;
  }

  function isNegationWord(word: string, lower: string): boolean {
    if (EN_NEGATIONS.has(lower)) {
      return true;
    }
    if (/(?:^|['’])n['’]t$/i.test(lower)) {
      return true;
    }
    if (ZH_NEGATION_EXACT.has(word)) {
      return true;
    }
    if (CJK_RE.test(word) && ZH_NEGATION_PREFIX_RE.test(word)) {
      return true;
    }
    return false;
  }

  function isQuantifierOrNumber(word: string, lower: string): boolean {
    if (DIGIT_RE.test(word)) {
      return true;
    }
    if (EN_QUANTIFIERS.has(lower)) {
      return true;
    }
    if (ZH_QUANTIFIERS.has(word)) {
      return true;
    }
    return false;
  }

  const EN_CONDITION_AND_BOUND_CUES = new Set([
    'if',
    'unless',
    'until',
    'otherwise',
    'else',
    'therefore',
    'thus',
    'hence',
    'because',
    'since',
    'although',
    'though',
    'however',
    'above',
    'below',
    'over',
    'under',
    'within',
    'exceed',
    'exceeds',
    'exceeding',
  ]);

  const ZH_CONDITION_AND_BOUND_CUES = new Set([
    '如果',
    '若',
    '假如',
    '只要',
    '只有',
    '只有当',
    '除非',
    '否则',
    '一旦',
    '因此',
    '所以',
    '从而',
    '可见',
    '综上',
    '总之',
    '因为',
    '但是',
    '然而',
    '超过',
    '不超过',
    '低于',
    '不低于',
    '高于',
    '不高于',
    '小于',
    '大于',
    '以上',
    '以下',
    '以内',
    '保证',
    '成立',
  ]);

  function isConditionOrBoundCue(word: string, lower: string): boolean {
    return (
      EN_CONDITION_AND_BOUND_CUES.has(lower) ||
      ZH_CONDITION_AND_BOUND_CUES.has(word)
    );
  }

  function classifyTechnicalOrEntity(
    word: string,
    isSentenceStart: boolean,
  ): 'technical' | 'entity' | null {
    if (/[_./]/.test(word) && /[A-Za-z]/.test(word)) {
      return 'technical';
    }
    if (/^[A-Z]{2,}$/.test(word)) {
      return 'technical';
    }
    if (/[a-z][A-Z]/.test(word)) {
      return 'technical';
    }
    if (!isSentenceStart && /^[A-Z]/.test(word) && word !== 'I') {
      return 'entity';
    }
    return null;
  }

  function classifyInitialToken(
    word: string,
    isSentenceStart: boolean,
  ): {level: SaliencyLevel; protected: boolean; reason: TokenReason} {
    const lower = word.toLowerCase();
    if (isNegationWord(word, lower)) {
      return {level: 3, protected: true, reason: 'negation'};
    }
    if (isQuantifierOrNumber(word, lower)) {
      return {
        level: 3,
        protected: true,
        reason: DIGIT_RE.test(word) ? 'number' : 'quantifier',
      };
    }
    if (isConditionOrBoundCue(word, lower)) {
      return {level: 3, protected: true, reason: 'condition'};
    }
    const techOrEntity = classifyTechnicalOrEntity(word, isSentenceStart);
    if (techOrEntity !== null) {
      return {level: 3, protected: true, reason: techOrEntity};
    }
    if (EN_FUNCTION_L0.has(lower) || ZH_FUNCTION_L0.has(word)) {
      return {level: 0, protected: false, reason: 'function'};
    }
    if (EN_SUPPORTING_L1.has(lower) || ZH_SUPPORTING_L1.has(word)) {
      return {level: 1, protected: false, reason: 'supporting'};
    }
    return {level: 2, protected: false, reason: 'content'};
  }

  function skeletonCandidateScore(
    token: ScoredToken,
    idxInClause: number,
    clauseWords: ScoredToken[],
  ): number {
    let score = token.level === 2 ? 10 : token.level === 1 ? 3 : -10;
    const prev = idxInClause > 0 ? clauseWords[idxInClause - 1] : null;
    const next =
      idxInClause + 1 < clauseWords.length
        ? clauseWords[idxInClause + 1]
        : null;
    const lower = token.text.toLowerCase();
    const isCjk = CJK_RE.test(token.text);

    if (isCjk) {
      if (token.text.length >= 2) {
        score += 2.5;
      }
      if (prev && ZH_VERB_PREV_CUES.has(prev.text)) {
        score += 3.5;
      }
      if (next && ZH_VERB_NEXT_CUES.has(next.text)) {
        score += 3.5;
      }
      if (prev && prev.text === '的') {
        score += 2.2;
      }
    } else {
      if (token.text.length >= 7) {
        score += 2.0;
      } else if (token.text.length >= 5) {
        score += 0.8;
      }
      if (prev && EN_MODALS_AUX.has(prev.text.toLowerCase())) {
        score += 3.5;
      } else if (EN_VERB_SUFFIX_RE.test(lower) && token.text.length >= 4) {
        score += 2.4;
      }
      if (prev && EN_DET_CUES.has(prev.text.toLowerCase())) {
        score += 2.0;
      } else if (EN_NOUN_SUFFIX_RE.test(lower) && token.text.length >= 5) {
        score += 1.6;
      }
    }

    const total = clauseWords.length;
    if (idxInClause >= 1 && idxInClause <= Math.min(4, total - 1)) {
      score += 1.2;
    }
    if (idxInClause >= Math.max(0, total - 2)) {
      score += 1.4;
    }
    return score;
  }

  function applyClauseSkeleton(
    tokens: ScoredToken[],
    clausesMap: Map<number, ScoredToken[]>,
  ): ScoredClause[] {
    const clauseIndices = [...clausesMap.keys()].sort((a, b) => a - b);
    const clauses: ScoredClause[] = [];

    for (const clauseIdx of clauseIndices) {
      const clauseTokens = clausesMap.get(clauseIdx) || [];
      const clauseWords = clauseTokens.filter(t => t.isWord);
      const wordCount = clauseWords.length;

      let minDark = 0;
      if (wordCount >= 6) {
        minDark = Math.max(2, Math.round(wordCount * 0.28));
      } else if (wordCount >= 4) {
        minDark = 1;
      } else if (wordCount >= 1 && clauseWords.some(w => w.level >= 2)) {
        minDark = 1;
      }

      let darkCount = 0;
      for (const word of clauseWords) {
        if (word.level >= 3) {
          darkCount += 1;
        }
      }

      while (darkCount < minDark) {
        let bestIdx = -1;
        let bestScore = -Infinity;
        for (let i = 0; i < clauseWords.length; i += 1) {
          const candidate = clauseWords[i];
          if (candidate.level >= 3) {
            continue;
          }
          let score = skeletonCandidateScore(candidate, i, clauseWords);
          const prevDark = i > 0 && clauseWords[i - 1].level >= 3;
          const nextDark =
            i + 1 < clauseWords.length && clauseWords[i + 1].level >= 3;
          if (prevDark || nextDark) {
            score -= 1.5;
          }
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }
        if (bestIdx < 0) {
          break;
        }
        const chosen = clauseWords[bestIdx];
        chosen.level = 3;
        if (!chosen.protected) {
          chosen.reason = 'skeleton';
        }
        darkCount += 1;
      }

      const start = clauseTokens.length ? clauseTokens[0].start : 0;
      const end = clauseTokens.length
        ? clauseTokens[clauseTokens.length - 1].end
        : 0;
      clauses.push({
        index: clauseIdx,
        start,
        end,
        wordCount,
        darkCount,
        tokens: clauseTokens,
      });
    }

    return clauses;
  }

  function buildScoredTokens(
    text: string,
    locale: SaliencyLocale,
  ): {tokens: ScoredToken[]; clausesMap: Map<number, ScoredToken[]>} {
    const slices = segmentText(text, locale);
    const tokens: ScoredToken[] = [];
    const clausesMap = new Map<number, ScoredToken[]>();
    let clauseIndex = 0;
    let isSentenceStart = true;

    for (const slice of slices) {
      const tokenText = slice.segment;
      const start = slice.index;
      const end = start + tokenText.length;

      if (!slice.isWordLike) {
        const token: ScoredToken = {
          text: tokenText,
          start,
          end,
          isWord: false,
          level: 0,
          clauseIndex,
          protected: false,
          reason: 'punctuation',
        };
        tokens.push(token);
        const list = clausesMap.get(clauseIndex) || [];
        list.push(token);
        clausesMap.set(clauseIndex, list);

        if (SENTENCE_END_PUNCT_RE.test(tokenText)) {
          clauseIndex += 1;
          isSentenceStart = true;
        } else if (CLAUSE_BREAK_PUNCT_RE.test(tokenText)) {
          clauseIndex += 1;
        }
        continue;
      }

      const classified = classifyInitialToken(tokenText, isSentenceStart);
      const token: ScoredToken = {
        text: tokenText,
        start,
        end,
        isWord: true,
        level: classified.level,
        clauseIndex,
        protected: classified.protected,
        reason: classified.reason,
      };
      tokens.push(token);
      const list = clausesMap.get(clauseIndex) || [];
      list.push(token);
      clausesMap.set(clauseIndex, list);
      isSentenceStart = false;
    }

    return {tokens, clausesMap};
  }

  function scoreParagraph(
    text: string,
    options?: ScoreParagraphOptions,
  ): ScoredParagraph {
    const t0 = nowMs();
    const raw = String(text ?? '');
    const locale = detectLocale(raw, options?.locale);
    const {tokens, clausesMap} = buildScoredTokens(raw, locale);
    const clauses = applyClauseSkeleton(tokens, clausesMap);
    const words = tokens.filter(token => token.isWord);

    return {
      text: raw,
      locale,
      tokens,
      words,
      clauses,
      durationMs: nowMs() - t0,
    };
  }

  function normalizeForAlign(word: string): string {
    return word.toLowerCase().replace(/^['’"]+|['’"]+$/g, '');
  }

  function lcsMatchIndices(
    originalWords: readonly string[],
    summaryWords: readonly string[],
  ): Set<number> {
    const m = originalWords.length;
    const n = summaryWords.length;
    const matched = new Set<number>();
    if (m === 0 || n === 0) {
      return matched;
    }

    const stride = n + 1;
    const dp = new Int32Array((m + 1) * stride);

    for (let i = 1; i <= m; i += 1) {
      const orig = originalWords[i - 1];
      const rowOffset = i * stride;
      const prevRowOffset = (i - 1) * stride;
      for (let j = 1; j <= n; j += 1) {
        if (orig === summaryWords[j - 1]) {
          dp[rowOffset + j] = dp[prevRowOffset + (j - 1)] + 1;
        } else {
          const up = dp[prevRowOffset + j];
          const left = dp[rowOffset + (j - 1)];
          dp[rowOffset + j] = up >= left ? up : left;
        }
      }
    }

    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
      if (
        originalWords[i - 1] === summaryWords[j - 1] &&
        dp[i * stride + j] === dp[(i - 1) * stride + (j - 1)] + 1
      ) {
        matched.add(i - 1);
        i -= 1;
        j -= 1;
      } else if (dp[(i - 1) * stride + j] >= dp[i * stride + (j - 1)]) {
        i -= 1;
      } else {
        j -= 1;
      }
    }

    return matched;
  }

  function resolveCompressionTiers(
    compressedLevels: CompressedLevelsInput,
    locale: SaliencyLocale,
  ): Array<{level: SaliencyLevel; words: string[]}> {
    const extractWords = (summary: string): string[] =>
      segmentText(String(summary || ''), locale)
        .filter(s => s.isWordLike)
        .map(s => normalizeForAlign(s.segment))
        .filter(Boolean);

    if (!Array.isArray(compressedLevels)) {
      const mapInput = compressedLevels as CompressedLevelsMap;
      const tiers: Array<{level: SaliencyLevel; words: string[]}> = [];
      const tier1 = mapInput.level1 ?? mapInput.l1;
      const tier2 = mapInput.level2 ?? mapInput.l2;
      const tier3 = mapInput.level3 ?? mapInput.l3;
      if (tier1 && String(tier1).trim()) {
        tiers.push({level: 1, words: extractWords(String(tier1))});
      }
      if (tier2 && String(tier2).trim()) {
        tiers.push({level: 2, words: extractWords(String(tier2))});
      }
      if (tier3 && String(tier3).trim()) {
        tiers.push({level: 3, words: extractWords(String(tier3))});
      }
      return tiers;
    }

    const parsed = compressedLevels
      .map((entry, idx) => ({
        idx,
        words: extractWords(String(entry || '')),
      }))
      .filter(item => item.words.length > 0);

    if (parsed.length === 0) {
      return [];
    }

    // Tighter compressions have fewer words -> higher saliency level (3 > 2 > 1).
    parsed.sort((a, b) => a.words.length - b.words.length || a.idx - b.idx);

    if (parsed.length === 1) {
      return [{level: 3, words: parsed[0].words}];
    }
    if (parsed.length === 2) {
      return [
        {level: 2, words: parsed[1].words},
        {level: 3, words: parsed[0].words},
      ];
    }
    return [
      {level: 1, words: parsed[2].words},
      {level: 2, words: parsed[1].words},
      {level: 3, words: parsed[0].words},
    ];
  }

  function alignCompressions(
    original: string,
    compressedLevels: CompressedLevelsInput,
    options?: ScoreParagraphOptions,
  ): ScoredParagraph {
    const t0 = nowMs();
    const raw = String(original ?? '');
    const locale = detectLocale(raw, options?.locale);
    const tiers = resolveCompressionTiers(compressedLevels, locale);
    if (tiers.length === 0) {
      return scoreParagraph(raw, options);
    }

    const slices = segmentText(raw, locale);
    const tokens: ScoredToken[] = [];
    const wordTokens: ScoredToken[] = [];
    const clausesMap = new Map<number, ScoredToken[]>();
    let clauseIndex = 0;

    for (const slice of slices) {
      const tokenText = slice.segment;
      const start = slice.index;
      const end = start + tokenText.length;
      if (!slice.isWordLike) {
        const token: ScoredToken = {
          text: tokenText,
          start,
          end,
          isWord: false,
          level: 0,
          clauseIndex,
          protected: false,
          reason: 'punctuation',
        };
        tokens.push(token);
        const list = clausesMap.get(clauseIndex) || [];
        list.push(token);
        clausesMap.set(clauseIndex, list);
        if (
          SENTENCE_END_PUNCT_RE.test(tokenText) ||
          CLAUSE_BREAK_PUNCT_RE.test(tokenText)
        ) {
          clauseIndex += 1;
        }
        continue;
      }

      const token: ScoredToken = {
        text: tokenText,
        start,
        end,
        isWord: true,
        level: 0,
        clauseIndex,
        protected: false,
        reason: 'function',
      };
      tokens.push(token);
      wordTokens.push(token);
      const list = clausesMap.get(clauseIndex) || [];
      list.push(token);
      clausesMap.set(clauseIndex, list);
    }

    const originalNorm = wordTokens.map(w => normalizeForAlign(w.text));
    const orderedTiers = [...tiers].sort((a, b) => a.level - b.level);
    for (const tier of orderedTiers) {
      const matched = lcsMatchIndices(originalNorm, tier.words);
      for (const wordIdx of matched) {
        const token = wordTokens[wordIdx];
        if (tier.level > token.level) {
          token.level = tier.level;
          token.reason =
            tier.level === 3
              ? 'skeleton'
              : tier.level === 2
                ? 'content'
                : 'supporting';
        }
      }
    }

    const clauses: ScoredClause[] = [];
    for (const [idx, clauseTokens] of [...clausesMap.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const cWords = clauseTokens.filter(t => t.isWord);
      const darkCount = cWords.filter(w => w.level >= 3).length;
      clauses.push({
        index: idx,
        start: clauseTokens.length ? clauseTokens[0].start : 0,
        end: clauseTokens.length
          ? clauseTokens[clauseTokens.length - 1].end
          : 0,
        wordCount: cWords.length,
        darkCount,
        tokens: clauseTokens,
      });
    }

    return {
      text: raw,
      locale,
      tokens,
      words: wordTokens,
      clauses,
      durationMs: nowMs() - t0,
    };
  }

  function getAttr(el: Element, key: string): string | null {
    if (typeof el.getAttribute === 'function') {
      return el.getAttribute(key);
    }
    return null;
  }

  function setAttr(el: Element, key: string, value: string): void {
    if (typeof el.setAttribute === 'function') {
      el.setAttribute(key, value);
    }
  }

  function removeAttr(el: Element, key: string): void {
    if (typeof el.removeAttribute === 'function') {
      el.removeAttribute(key);
    }
  }

  function getClassList(el: Element): string[] {
    const raw = getAttr(el, 'class') ?? el.className ?? '';
    return raw ? String(raw).trim().split(/\s+/).filter(Boolean) : [];
  }

  function hasClass(el: Element, name: string): boolean {
    return getClassList(el).includes(name);
  }

  function addClass(el: Element, name: string): void {
    const classes = getClassList(el);
    if (!classes.includes(name)) {
      classes.push(name);
      setAttr(el, 'class', classes.join(' '));
    }
  }

  function removeClass(el: Element, name: string): void {
    const classes = getClassList(el);
    if (!classes.includes(name)) {
      return;
    }
    const next = classes.filter(c => c !== name);
    if (next.length === 0) {
      removeAttr(el, 'class');
    } else {
      setAttr(el, 'class', next.join(' '));
    }
  }

  function tagNameOf(node: Node): string {
    return String((node as Element).tagName || '').toUpperCase();
  }

  function hasAncestorClass(
    node: Node,
    className: string,
    boundary: Node,
  ): boolean {
    let cur = node.parentNode;
    while (cur) {
      if (cur.nodeType === 1 && hasClass(cur as Element, className)) {
        return true;
      }
      if (cur === boundary) {
        break;
      }
      cur = cur.parentNode;
    }
    return false;
  }

  function isSkippedElement(el: Element, boundary: Element): boolean {
    const tag = tagNameOf(el);
    if (SKIP_TAGS.has(tag)) {
      return true;
    }
    if (
      hasClass(el, 'katex') ||
      hasClass(el, 'mp-katex-display') ||
      hasClass(el, 'mp-learn-math-block') ||
      hasClass(el, 'mp-learn-math-inline')
    ) {
      return true;
    }
    const skipAttr = getAttr(el, 'data-tsm-skip');
    if (skipAttr !== null && skipAttr !== 'false') {
      return true;
    }
    if (
      hasClass(el, 'mp-learn-card-tag') &&
      hasAncestorClass(el, 'mp-learn-card', boundary)
    ) {
      return true;
    }
    return false;
  }

  function hasBlockChild(el: Element): boolean {
    const children = el.childNodes || [];
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child.nodeType !== 1) {
        continue;
      }
      const childEl = child as Element;
      if (BLOCK_TAGS.has(tagNameOf(childEl))) {
        return true;
      }
      if (hasBlockChild(childEl)) {
        return true;
      }
    }
    return false;
  }

  function mergeAdjacentTextNodes(parent: Node): void {
    const children = parent.childNodes;
    if (!children || children.length < 2) {
      return;
    }
    let idx = 0;
    while (idx < children.length - 1) {
      const current = children[idx];
      const next = children[idx + 1];
      if (current.nodeType === 3 && next.nodeType === 3) {
        const curText = (current as Text).data ?? current.textContent ?? '';
        const nextText = (next as Text).data ?? next.textContent ?? '';
        (current as Text).data = curText + nextText;
        parent.removeChild(next);
      } else {
        idx += 1;
      }
    }
  }

  function clear(rootEl: Element | null | undefined): void {
    if (!rootEl || rootEl.nodeType !== 1 || typeof document === 'undefined') {
      return;
    }
    const wordSpans: Element[] = [];
    const blockEls: Element[] = [];
    const walk = (node: Element): void => {
      if (hasClass(node, 'mp-tsm-block')) {
        blockEls.push(node);
      }
      if (getAttr(node, 'data-tsm-applied') !== null) {
        blockEls.push(node);
      }
      if (hasClass(node, 'mp-tsm-word')) {
        wordSpans.push(node);
        return;
      }
      const children = node.childNodes || [];
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child.nodeType === 1) {
          walk(child as Element);
        }
      }
    };
    walk(rootEl);

    const dirtyParents = new Set<Node>();
    for (const span of wordSpans) {
      const parent = span.parentNode;
      if (!parent) {
        continue;
      }
      const textNode = document.createTextNode(span.textContent || '');
      parent.replaceChild(textNode, span);
      dirtyParents.add(parent);
    }

    for (const parent of dirtyParents) {
      mergeAdjacentTextNodes(parent);
    }
    for (const el of blockEls) {
      removeClass(el, 'mp-tsm-block');
      removeAttr(el, 'data-tsm-applied');
    }
  }

  function collectInlineRuns(
    node: Node,
    boundary: Element,
    inStrong: boolean,
    runs: BlockRun[],
    cursor: {offset: number},
  ): void {
    if (node.nodeType === 3) {
      const text = (node as Text).data ?? node.textContent ?? '';
      if (!text) {
        return;
      }
      const start = cursor.offset;
      const end = start + text.length;
      cursor.offset = end;
      runs.push({
        kind: 'text',
        node: node as Text,
        text,
        inStrong,
        start,
        end,
      });
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const el = node as Element;
    if (isSkippedElement(el, boundary)) {
      const raw = el.textContent || '';
      const placeholder = raw.trim() ? ' item ' : ' ';
      const start = cursor.offset;
      const end = start + placeholder.length;
      cursor.offset = end;
      runs.push({kind: 'island', text: placeholder, start, end});
      return;
    }
    const tag = tagNameOf(el);
    if (tag === 'BR') {
      const start = cursor.offset;
      const end = start + 1;
      cursor.offset = end;
      runs.push({kind: 'island', text: '\n', start, end});
      return;
    }
    const nextStrong = inStrong || tag === 'STRONG' || tag === 'B';
    const children = [...(el.childNodes || [])];
    for (const child of children) {
      collectInlineRuns(child, boundary, nextStrong, runs, cursor);
    }
  }

  function createWordSpan(text: string, level: SaliencyLevel): Element {
    const span = document.createElement('span');
    setAttr(span, 'class', `mp-tsm-word mp-tsm-l${level}`);
    span.appendChild(document.createTextNode(text));
    return span;
  }

  function applyScoredRuns(
    runs: BlockRun[],
    options: ApplyOptions | undefined,
  ): boolean {
    const textRuns = runs.filter(
      (run): run is EditableTextRun => run.kind === 'text',
    );
    if (textRuns.length === 0) {
      return false;
    }
    const hasReadableText = textRuns.some(run => Boolean(run.text.trim()));
    if (!hasReadableText) {
      return false;
    }

    const fullText = runs.map(r => r.text).join('');
    const locale = detectLocale(fullText, options?.locale);
    let scored: ScoredParagraph;

    if (options?.compressedLevels !== undefined) {
      scored = alignCompressions(fullText, options.compressedLevels, {locale});
    } else {
      const {tokens, clausesMap} = buildScoredTokens(fullText, locale);
      for (const token of tokens) {
        if (!token.isWord) {
          continue;
        }
        const overlappingStrong = textRuns.some(
          run => run.inStrong && token.start < run.end && token.end > run.start,
        );
        if (overlappingStrong) {
          token.level = 3;
          token.protected = true;
          token.reason = 'emphasis';
        }
      }
      const clauses = applyClauseSkeleton(tokens, clausesMap);
      scored = {
        text: fullText,
        locale,
        tokens,
        words: tokens.filter(t => t.isWord),
        clauses,
        durationMs: 0,
      };
    }

    let didModulate = false;
    for (const run of textRuns) {
      if (!run.node.parentNode) {
        continue;
      }
      const frag = document.createDocumentFragment();
      let hasRunWords = false;
      for (const token of scored.tokens) {
        if (token.end <= run.start || token.start >= run.end) {
          continue;
        }
        const sliceStart = Math.max(0, run.start - token.start);
        const sliceEnd = Math.min(token.text.length, run.end - token.start);
        const piece = token.text.slice(sliceStart, sliceEnd);
        if (!piece) {
          continue;
        }
        if (token.isWord) {
          const level: SaliencyLevel = run.inStrong ? 3 : token.level;
          frag.appendChild(createWordSpan(piece, level));
          hasRunWords = true;
        } else {
          frag.appendChild(document.createTextNode(piece));
        }
      }
      if (hasRunWords) {
        run.node.parentNode.replaceChild(frag, run.node);
        didModulate = true;
      }
    }

    return didModulate;
  }

  function modulateElement(
    el: Element,
    rootEl: Element,
    options: ApplyOptions | undefined,
  ): void {
    if (isSkippedElement(el, rootEl)) {
      return;
    }

    const tag = tagNameOf(el);
    if (tag === 'P' || !hasBlockChild(el)) {
      const runs: BlockRun[] = [];
      collectInlineRuns(el, rootEl, false, runs, {offset: 0});
      if (applyScoredRuns(runs, options)) {
        addClass(el, 'mp-tsm-block');
      }
      return;
    }

    const children = [...(el.childNodes || [])];
    let pendingInline: Node[] = [];

    const flushInline = (): void => {
      if (pendingInline.length === 0) {
        return;
      }
      const runs: BlockRun[] = [];
      const cursor = {offset: 0};
      for (const inlineNode of pendingInline) {
        collectInlineRuns(inlineNode, rootEl, false, runs, cursor);
      }
      pendingInline = [];
      applyScoredRuns(runs, options);
    };

    for (const child of children) {
      if (child.nodeType === 1 && BLOCK_TAGS.has(tagNameOf(child as Element))) {
        flushInline();
        modulateElement(child as Element, rootEl, options);
      } else {
        pendingInline.push(child);
      }
    }
    flushInline();
  }

  function apply<T extends Element>(rootEl: T, options?: ApplyOptions): T {
    if (!rootEl || rootEl.nodeType !== 1 || typeof document === 'undefined') {
      return rootEl;
    }
    clear(rootEl);

    if (options?.reveal === true) {
      setAttr(rootEl, 'data-tsm-reveal', 'true');
    } else if (options?.reveal === false) {
      removeAttr(rootEl, 'data-tsm-reveal');
    }

    modulateElement(rootEl, rootEl, options);
    setAttr(rootEl, 'data-tsm-applied', 'true');
    return rootEl;
  }

  const TextSaliencyApi = {
    scoreParagraph,
    alignCompressions,
    apply,
    clear,
  };

  if (typeof globalThis !== 'undefined') {
    (
      globalThis as typeof globalThis & {TextSaliency?: typeof TextSaliencyApi}
    ).TextSaliency = TextSaliencyApi;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = TextSaliencyApi;
  }
})();
