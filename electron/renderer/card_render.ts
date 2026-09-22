/* exported renderCard, cardElapsedText */

const CardRender = (() => {

  interface CardSpec {
    [key: string]: any;
  }
  interface CardShimNode {
    tagName: string;
    ns: string | null;
    attrs: Record<string, string>;
    children: (string | CardShimNode)[];
    setAttribute(k: string, v: string): void;
    appendChild(child: unknown): unknown;
    readonly textContent: string;
    readonly outerHTML: string;
  }
  type CardNode = Element | CardShimNode;
  type CardChild = CardNode | Text | string | null | undefined | false;

  const CARD_DOC = typeof document !== 'undefined' ? document : null;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CARD_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'use']);

  function esc(value: unknown) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => CARD_ESCAPES[c]);
  }

  function shimNode(tag: string, ns: string | null): CardShimNode {
    const node: CardShimNode = {
      tagName: tag, ns, attrs: {}, children: [],
      setAttribute(k: string, v: string) { this.attrs[k] = String(v); },
      appendChild(child: unknown): unknown {
        this.children.push(child as string | CardShimNode);
        return child;
      },
      get textContent() {
        return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
      },
      get outerHTML() {
        const attrs = Object.entries(this.attrs)
          .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
        if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
        const inner = this.children
          .map((c) => (typeof c === 'string' ? esc(c) : c.outerHTML)).join('');
        return `<${tag}${attrs}>${inner}</${tag}>`;
      },
    };
    return node;
  }

  function h(tag: string, attrs?: Record<string, unknown>, children?: CardChild | CardChild[]): CardNode {
    const ns = tag === 'svg' || tag === 'use' ? SVG_NS : null;
    const node = CARD_DOC
      ? (ns ? CARD_DOC.createElementNS(ns, tag) : CARD_DOC.createElement(tag))
      : shimNode(tag, ns);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, String(value));
    }
    for (const child of flatten(children)) {
      if (child === null || child === undefined || child === false || child === '') continue;
      node.appendChild((typeof child === 'object' ? child : text(String(child))) as unknown as Node);
    }
    return node;
  }

  function text(value: string): Text | string {
    return CARD_DOC ? CARD_DOC.createTextNode(value) : value;
  }

  function flatten(value: CardChild | CardChild[]): CardChild[] {
    if (!Array.isArray(value)) return value === undefined ? [] : [value];
    return value.flatMap(flatten);
  }

  function icon(id: string, cls?: string): CardNode {
    return h('svg', cls ? { class: cls } : {}, [h('use', { href: `#${id}` }, [])]);
  }

  function safeSrc(value: unknown): string {
    const raw = String(value || '').trim();
    if (/^(file:\/\/|https:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/i.test(raw)) return raw;
    return '';
  }

  function inlineMd(value: unknown): CardChild[] {
    return String(value ?? '')
      .split(/(!\[[^\]]*\]\([^)\s]+\)|\*\*[^*]+\*\*|`[^`]+`|==[^=]+==)/g)
      .filter(Boolean)
      .map((frag) => {
        if (frag.startsWith('**') && frag.endsWith('**')) return h('strong', {}, [frag.slice(2, -2)]);
        if (frag.startsWith('`') && frag.endsWith('`')) return h('code', {}, [frag.slice(1, -1)]);
        if (frag.startsWith('==') && frag.endsWith('==')) return h('mark', { class: 'mhi' }, [frag.slice(2, -2)]);
        if (frag.startsWith('![')) {
          const match = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(frag);
          const src = match ? safeSrc(match[2]) : '';
          if (!src) return h('span', { class: 'mmd-img-blocked' }, ['[一张图的地址不安全，没有加载]']);
          return h('img', { class: 'mmd-img', src, alt: match![1] || '图', loading: 'lazy' }, []);
        }
        return text(frag);
      });
  }

  function markdown(value: unknown): CardNode[] {
    const blocks = String(value ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).filter(Boolean);
    return blocks.map((block) => {
      const lines = block.split('\n');
      if (/^```[\s\S]*```$/.test(block)) {
        return h('pre', {}, [h('code', {}, [block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')])]);
      }
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return h('ul', {}, lines.map((l) => h('li', {}, inlineMd(l.replace(/^\s*[-*]\s+/, '')))));
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        return h('ol', {}, lines.map((l) => h('li', {}, inlineMd(l.replace(/^\s*\d+[.)]\s+/, '')))));
      }
      if (/^#{1,3}\s+/.test(block)) return h('h3', {}, inlineMd(block.replace(/^#{1,3}\s+/, '')));
      return h('p', {}, inlineMd(lines.join('\n')));
    });
  }

  const KIND_FACE: Record<string, [string, string]> = {
    prose:    ['ic-spark',   '回答'],
    facts:    ['ic-check',   '已确认'],
    metric:   ['ic-pulse',   '数据'],
    image:    ['ic-img',     '图'],
    proposal: ['ic-shield',  '待你点头'],
    diff:     ['ic-pen',     '改动'],
    table:    ['ic-window',  '对比'],
    prompt:   ['ic-handoff', '提示词'],
    steps:    ['ic-target',  '过程'],
    slot:     ['ic-mcp',     '工具界面'],
  };

  function cardElapsedText(card: CardSpec | null | undefined, now: number): string {
    if (!card || !card.startedAt) return '';
    const seconds = Math.max(0, (now - card.startedAt) / 1000);
    if (seconds < 1) return '';
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  }

  function renderTop(card: CardSpec): CardNode | null {
    const [ico, name] = KIND_FACE[card.kind] || KIND_FACE.prose;
    const eyebrow = card.state === 'failed' ? '没能完成'
      : card.state === 'running' ? name
        : (card.eyebrow || name);
    const origin = card.source && (card.source.app || card.source.label)
      ? h('button', { class: 'mcard-origin', type: 'button', 'data-act': 'origin' }, [
        icon('ic-target'),
        [card.source.app, card.source.label].filter(Boolean).join(' · '),
      ])
      : null;
    const title = card.title && String(card.title).trim() !== eyebrow ? String(card.title) : '';
    if (!title && !origin && card.kind === 'prose') return null;
    return h('header', { class: 'mcard-top' }, [
      h('span', { class: 'mcard-eyebrow' }, [icon(ico), eyebrow]),
      origin,
      title ? h('b', { class: 'mcard-title' }, [title]) : null,
      card.subtitle ? h('span', { class: 'mcard-sub' }, [card.subtitle]) : null,
    ]);
  }

  function renderNowLine(card: CardSpec, density = 'full'): CardNode | null {
    if (card.state !== 'running' || density === 'capsule') return null;
    return h('div', { class: 'mcard-nowline' }, [
      h('span', { class: 'mcard-now' }, [card.runningLabel || '正在处理']),
      h('em', { class: 'mcard-elapsed', 'data-elapsed': '' }, []),
    ]);
  }

  function stepRows(steps: any[], { showFacts = true } = {}): CardNode {
    return h('ol', { class: 'mcard-steps' }, steps.map((s) => {
      const fact = typeof s.note === 'string' ? s.note.trim() : '';
      return h('li', { 'data-state': s.state || 'done' }, [
        h('span', { class: 'mstep-row' }, [
          icon(
            s.state === 'done' ? 'ic-check' : s.state === 'failed' ? 'ic-warn' : 'ic-circle',
            'mstep-dot',
          ),
          h('span', { class: 'mstep-label' }, [s.label || '']),
          s.state === 'pending'
            ? h('em', { class: 'mstep-elapsed', 'data-elapsed': '' }, [])
            : null,
        ]),
        showFacts && fact ? h('span', { class: 'mstep-fact' }, [`→ ${fact}`]) : null,
      ]);
    }));
  }

  function renderSteps(card: CardSpec, density = 'full'): CardNode | null {
    const steps: any[] = card.steps || [];
    const model: any = (globalThis as { CardModel?: unknown }).CardModel;
    const isPlumbing = typeof model?.isPlumbingPhase === 'function'
      ? (phase: unknown) => model.isPlumbingPhase(phase)
      : () => false;
    const plumbing = steps.filter((s) => isPlumbing(s.phase));
    const actions = steps.filter((s) => !isPlumbing(s.phase));
    if (density === 'capsule') {
      const activity = [...actions];
      if (card.state === 'running' && !activity.some((s) => s.state === 'pending')) {
        activity.push({
          phase: '__active__',
          label: card.runningLabel || '正在处理',
          state: 'pending',
        });
      }
      return activity.length ? stepRows(activity, { showFacts: false }) : null;
    }
    if (!steps.length) return null;
    if (!plumbing.length) return stepRows(actions.length ? actions : steps);
    return h('div', { class: 'mcard-steps-wrap' }, [
      h('details', { class: 'mcard-steps-plumbing' }, [
        h('summary', {}, [`准备阶段 · ${plumbing.length} 步`]),
        stepRows(plumbing),
      ]),
      actions.length ? stepRows(actions) : null,
    ]);
  }

  function renderFoldedProcess(steps: any[] | undefined | null): CardNode | null {
    if (!Array.isArray(steps) || !steps.length) return null;
    return h('details', { class: 'mcard-process-folded' }, [
      h('summary', {}, [`过程 · ${steps.length} 步`]),
      stepRows(steps),
    ]);
  }

  const BODY: Record<string, (card: CardSpec) => CardChild | CardChild[]> = {
    prose(card) {
      const main = String(card.answer || card.message || '');
      const detail = String(card.detail || '');
      if (!main && !detail) return null;
      return h('div', { class: 'mcard-prose' }, [
        ...(card.plainText
          ? String(main).replace(/\r\n?/g, '\n').split(/\n\s*\n/).filter(Boolean)
            .map((block) => h('p', { class: 'mplain' }, [block]))
          : markdown(main)),
        detail ? h('p', { class: 'mcard-detail' }, [detail]) : null,
        card.statusLabel
          ? h('p', { class: 'mcard-receipt', 'data-status': card.status || 'unknown' }, [card.statusLabel])
          : null,
      ]);
    },

    facts(card) {
      const rows = Array.isArray(card.rows) ? card.rows : [];
      if (!rows.length) return null;
      return h('div', { class: 'mcard-facts' }, rows.map((r) => h('div', { class: 'mfact' }, [
        h('span', { class: 'mfact-label' }, [r.label || '']),
        h('span', { class: `mfact-value${r.tone ? ` is-${r.tone}` : ''}` }, [String(r.value ?? '')]),
      ])));
    },

    metric(card) {
      const foot = Array.isArray(card.foot) ? card.foot : [];
      return h('div', { class: 'mcard-metric' }, [
        h('div', { class: 'mmetric-head' }, [
          h('span', { class: 'mmetric-value' }, [
            String(card.value ?? '—'),
            card.unit ? h('em', { class: 'mmetric-unit' }, [card.unit]) : null,
          ]),
          card.delta
            ? h('span', { class: `mmetric-delta${card.deltaTone ? ` is-${card.deltaTone}` : ''}` }, [
              icon('ic-chev', 'mdelta-arrow'), String(card.delta),
            ])
            : null,
        ]),
        card.caption ? h('p', { class: 'mmetric-caption' }, [card.caption]) : null,
        foot.length
          ? h('div', { class: 'mmetric-foot' }, foot.map((f) => h('span', { class: 'mfoot' }, [
            h('b', {}, [String(f.value ?? '')]),
            h('small', {}, [f.label || '']),
          ])))
          : null,
      ]);
    },

    image(card) {
      const src = safeSrc(card.src);
      if (card.state === 'failed' && !src) return null;
      const ratioWidth = Number.isFinite(card.w) && card.w > 0 ? card.w : 3;
      const ratioHeight = Number.isFinite(card.h) && card.h > 0 ? card.h : 2;
      const ratioSizer = () => h('svg', {
        class: 'mimg-ratio',
        viewBox: `0 0 ${ratioWidth} ${ratioHeight}`,
        preserveAspectRatio: 'none',
        'aria-hidden': 'true',
      }, []);
      if (card.state === 'running' || !src) {
        return h('div', { class: 'mcard-image is-waiting' }, [
          ratioSizer(),
          h('div', { class: 'mimg-skeleton' }, [icon('ic-img')]),
        ]);
      }
      const before = safeSrc(card.before);
      return [
        h('div', { class: 'mcard-image' }, [
          ratioSizer(),
          before ? h('img', { class: 'mimg-before', src: before, alt: '改之前' }, []) : null,
          h('img', { class: 'mimg', src, alt: card.caption || '结果图' }, []),
          before ? h('span', { class: 'mimg-flip', 'data-act': 'flip' }, ['按住看改之前']) : null,
        ]),
        card.caption ? h('p', { class: 'mimg-caption' }, [card.caption]) : null,
      ];
    },

    proposal(card) {
      return h('div', { class: 'mcard-proposal' }, [
        card.summary ? h('p', { class: 'mprop-summary' }, [card.summary]) : null,
        renderPreview(card.preview),
        card.irreversible
          ? h('p', { class: 'mprop-warn' }, [icon('ic-warn'), '这一步做完撤不回来。'])
          : null,
      ]);
    },

    diff(card) {
      if (!card.original && !card.proposed) return null;
      return h('div', { class: 'mcard-diff' }, [h('pre', {}, [
        card.original ? h('del', {}, [card.original]) : null,
        card.proposed ? h('ins', {}, [card.proposed]) : null,
      ])]);
    },

    table(card) {
      const head = Array.isArray(card.columns) ? card.columns : [];
      const rows = Array.isArray(card.rows) ? card.rows : [];
      if (!rows.length) return null;
      return h('div', { class: 'mcard-table' }, [h('table', {}, [
        head.length ? h('thead', {}, [h('tr', {}, head.map((c) => h('th', {}, [String(c)])))]) : null,
        h('tbody', {}, rows.map((r) => h('tr', {}, (Array.isArray(r) ? r : [r]).map(
          (c) => h('td', {}, [String(c)]),
        )))),
      ])]);
    },

    prompt(card) {
      return h('div', { class: 'mcard-prompt' }, [
        h('textarea', { class: 'mprompt-text', 'data-act': 'prompt-edit', rows: '6' }, [card.prompt || '']),
      ]);
    },

    steps() {
      return null;
    },

    slot(card) {
      const server = String(card.server || card.source?.app || '未知工具');
      const html = String(card.html || '');
      const url = String(card.url || '');
      const height = Number.isFinite(card.height)
        ? Math.max(96, Math.min(520, card.height))
        : 260;
      let frame;
      if (html) {
        frame = h('iframe', {
          class: 'mslot-frame',
          sandbox: 'allow-scripts allow-forms',
          csp: "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          srcdoc: html,
          height: String(height),
          title: `${server} 提供的界面`,
        }, []);
      } else if (/^https:\/\//i.test(url)) {
        frame = h('iframe', {
          class: 'mslot-frame',
          sandbox: 'allow-scripts allow-forms',
          src: url,
          height: String(height),
          title: `${server} 提供的界面`,
        }, []);
      } else {
        frame = h('p', { class: 'mslot-blocked' }, [
          url ? '这个工具想加载一个非 https 的界面，已挡下。' : '这个工具没有返回可渲染的界面。',
        ]);
      }
      return h('div', { class: 'mcard-slot' }, [
        h('div', { class: 'mslot-top' }, [
          icon('ic-mcp'),
          h('b', {}, [server]),
          h('span', { class: 'spacer' }, []),
          h('span', { class: 'mslot-badge' }, ['工具提供的界面']),
        ]),
        frame,
      ]);
    },
  };

  function renderPreview(preview: unknown): CardNode | null {
    if (!preview || typeof preview !== 'object') return null;
    const p = preview as Record<string, any>;
    const items = Array.isArray(p.items) ? p.items : [];
    if (p.kind === 'folders' || p.kind === 'files') {
      const isFolder = p.kind === 'folders';
      return h('div', { class: `mprev mprev-${p.kind}` }, items.map((it) => h('span', {
        class: isFolder ? 'mfolder' : 'mfile',
      }, [icon(isFolder ? 'ic-folder' : 'ic-file'), h('small', {}, [it.name || String(it)])])));
    }
    if (p.kind === 'text') {
      return h('div', { class: 'mprev mprev-text' }, [h('pre', {}, [p.text || ''])]);
    }
    return null;
  }

  function renderActions(card: CardSpec): CardNode | null {
    const actions = Array.isArray(card.actions) ? card.actions : [];
    if (!actions.length) return null;
    return h('footer', { class: 'mcard-acts' }, actions.map((a, i) => h('button', {
      type: 'button',
      class: `btn btn-${a.tone || (i === actions.length - 1 ? 'solid' : 'quiet')}`,
      'data-act': 'action',
      'data-action-id': a.id || '',
      'data-token': a.token || null,
    }, [a.label || '执行'])));
  }

  function renderCard(card: CardSpec | null | undefined, options: { density?: string } = {}): CardNode | null {
    if (!card || typeof card !== 'object') return null;
    const kind = BODY[card.kind] ? card.kind : 'prose';
    const density = options.density || 'full';
    return h('article', {
      class: 'mcard',
      'data-kind': kind,
      'data-state': card.state || 'done',
      'data-density': density,
      'data-card-id': card.id || '',
    }, [
      renderTop(card),
      renderSteps(card, density),
      renderNowLine(card, density),
      card.state === 'failed'
        ? h('p', { class: 'mcard-fail' }, [icon('ic-warn'), card.error || '这次没能完成。'])
        : null,
      BODY[kind](card) as CardChild,
      renderActions(card),
    ]);
  }

  return { renderCard, renderFoldedProcess, cardElapsedText, esc, safeSrc, markdown, inlineMd, h, KIND_FACE };
})();

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const renderCard = CardRender.renderCard;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const renderFoldedProcess = CardRender.renderFoldedProcess;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const cardElapsedText = CardRender.cardElapsedText;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CardRender;
}
