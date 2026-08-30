/* exported renderCard, cardElapsedText */
/* ============================================================================
   卡片渲染：一张卡 → 一个 DOM 节点
   ----------------------------------------------------------------------------
   舞台胶囊、随行窗、工作室共用这一个函数。它们的差别只是外层的 density，
   不是三份各写一遍的模板——上一版就是三份，于是同一次问答在三个界面上长得
   不一样，用户说「他们俩应该是完全同步的才对」。

   **不拼 HTML 字符串。** 舞台是一个浮在别人窗口上、渲染模型输出的界面，
   tests/stage_static_test.js 因此钉死了「stage.js 里不许出现 innerHTML」。
   拼串意味着每一处插值都得记得转义，而漏掉一处就是一个洞。这里改成用 h()
   造节点：文本一律走 createTextNode，转义是结构性的，不靠记性。

   h() 在浏览器里造真节点，在 Node 里造一个能序列化成 outerHTML 的轻量对象，
   所以整份渲染层不用 DOM 也能测。

   事件不在这里绑。外层用一次事件委托监听 [data-act]，卡片本身是纯的。

   **整份包在 IIFE 里。** 渲染层是一串 classic script，共用同一个全局作用域：
   studio.js 和 settings.js 各有一个返回 HTML 字符串的 `icon()`，后加载的那个
   会把这里的顶掉，于是卡片的眉毛行里会出现 `<SVG CLASS="">…` 的字面文本。
   只暴露 CardRender 一个名字，这类事故就不可能发生。
   ============================================================================ */

const CardRender = (() => {

  // 卡是模型给的自由形状数据：只按运行时要用的字段取值，不做结构假设。
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

  /* ---- Node 侧的最小节点。只为可测，不追求像 DOM。 ---- */
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
      // 两种 node 实现各收各的孩子；shim 节点在 Node 侧只收 string。
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

  // 只允许我们自己写得出来的图片来源。模型给一个 javascript: 或
  // data:text/html 就能在渲染进程里执行脚本，所以这道闸在设 src 之前。
  function safeSrc(value: unknown): string {
    const raw = String(value || '').trim();
    if (/^(file:\/\/|https:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/i.test(raw)) return raw;
    return '';
  }

  /* ---------------------------------------------------------------------------
     markdown 的极小子集：**粗**、`码`、无序/有序列表、三级标题、围栏代码。
     和 stage.js 里原来那份是同一套规则，只是产出节点。
     --------------------------------------------------------------------------- */
  // `==这样==` 是荧光笔。Vida 把草稿落进 Slack 时，被改动的关键短语用黄色
  // 标出来——这是「我改了哪里」最省事的说法，不用写一段解释也不用做 diff。
  //
  // `![说明](地址)` 是图。一次问答的结果可以本来就是一张图（模型出的、工具
  // 返回的、我们截的），而上一版的子集里没有它，于是那行 markdown 被当成
  // 一串普通文字原样印出来——用户看到的是 `![图](https://…)` 这七个字符。
  // 地址一律过 safeSrc：模型给一个 javascript: 就能在渲染进程里执行脚本。
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
          // 挡下来的地址不能静默变成空白：说清楚有一张图没敢加载。
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

  /* ---- 每种卡的身份：一个图标 + 一句名字。运行中也显示，
         所以你从第一帧就知道等来的会是什么。 ---- */
  const KIND_FACE: Record<string, [string, string]> = {
    prose:    ['ic-spark',   '回答'],
    facts:    ['ic-check',   '已确认'],
    metric:   ['ic-pulse',   '数据'],
    image:    ['ic-img',     '图'],
    proposal: ['ic-shield',  '待你点头'],
    diff:     ['ic-pen',     '改动'],
    table:    ['ic-window',  '对比'],
    calendar: ['ic-hist',    '日程'],
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

  /* ============================================================
     头部
     ============================================================ */
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
    // 标题和眉毛说的是同一件事时，只留眉毛。一张写回卡上「改动」写两遍，
    // 第二遍不提供任何信息，只是把卡撑高。
    const title = card.title && String(card.title).trim() !== eyebrow ? String(card.title) : '';
    if (!title && !origin && card.kind === 'prose') return null;
    return h('header', { class: 'mcard-top' }, [
      // 来源跟眉毛同一行：它俩说的是同一件事（这是什么 / 从哪儿来的）。
      // 放在标题后面会被 .mcard-title 的整行占位挤到第三行去，孤零零飘在右边。
      h('span', { class: 'mcard-eyebrow' }, [icon(ico), eyebrow]),
      origin,
      title ? h('b', { class: 'mcard-title' }, [title]) : null,
      card.subtitle ? h('span', { class: 'mcard-sub' }, [card.subtitle]) : null,
    ]);
  }

  /* ============================================================
     运行进度 = 证据流本身
     ----------------------------------------------------------------------------
     百分比条从根上删掉了（PromptRescue 逐帧：Vida 卡内部是逐行展开的
     证据流，没有任何进度条）。唯一保留的附注是真实秒数——一个两分钟的
     卡死和一个两秒的等待，光靠步骤行分不出来。它排成证据流末尾一行
     安静的等宽小字，不参与进度表达。
     ============================================================ */
  function renderNowLine(card: CardSpec): CardNode | null {
    if (card.state !== 'running') return null;
    return h('div', { class: 'mcard-nowline' }, [
      h('span', { class: 'mcard-now' }, [card.runningLabel || '正在处理']),
      h('em', { class: 'mcard-elapsed', 'data-elapsed': '' }, []),
    ]);
  }

  /* 走过的步骤，照 PromptRescue 逐帧复刻（Vida §5.3 版式即语义）：
     ✓ 是「我做了什么」，黑色无衬线一行；「我从那个动作里读到什么」是
     它下面独立的 → 等宽灰行。等待的十几秒因此在建立信任，而不是在耗人。 */
  function renderSteps(card: CardSpec): CardNode | null {
    const steps: any[] = card.steps || [];
    if (!steps.length) return null;
    return h('ol', { class: 'mcard-steps' }, steps.map((s) => {
      const facts = [s.note, Number.isFinite(s.ms) ? `${s.ms}ms` : ''].filter(Boolean);
      return h('li', { 'data-state': s.state || 'done' }, [
        h('span', { class: 'mstep-row' }, [
          icon(s.state === 'done' ? 'ic-check' : 'ic-circle', 'mstep-dot'),
          h('span', { class: 'mstep-label' }, [s.label || '']),
        ]),
        facts.length ? h('span', { class: 'mstep-fact' }, [`→ ${facts.join(' · ')}`]) : null,
      ]);
    }));
  }

  /* ============================================================
     各种卡的身子
     ============================================================ */
  const BODY: Record<string, (card: CardSpec) => CardChild | CardChild[]> = {
    prose(card) {
      const main = String(card.answer || card.message || '');
      const detail = String(card.detail || '');
      if (!main && !detail) return null;
      return h('div', { class: 'mcard-prose' }, [
        // card.plainText：这段字是要发出去的（回微信、回邮件、填回输入框）。
        // 对面读到的是字面量的 `**` 和 `-`，所以我们这儿也不能把它渲染成粗体
        // 和列表——渲染成那样会让人以为发过去也是那样。段落还是要分的：
        // 空行是纯文本里本来就有的东西，不是 markdown 语法。
        ...(card.plainText
          ? String(main).replace(/\r\n?/g, '\n').split(/\n\s*\n/).filter(Boolean)
            .map((block) => h('p', { class: 'mplain' }, [block]))
          : markdown(main)),
        detail ? h('p', { class: 'mcard-detail' }, [detail]) : null,
        // 状态行照抄桥给的原话：accepted 就是 accepted，不许升级成看起来完成了
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

    // 数据卡：一个大数字压住整张卡，单位和变化贴着它，细分在底下一排。
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

    // 图。运行中先占好位——比例是已知的，所以图落下来时卡不会跳一下。
    // 但失败之后不能还挂着那块在闪的骨架屏：它等于在说「还在出图」，
    // 而这张卡上面已经写了「没能完成」，两句话是矛盾的。
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

    // 提案。要点头的那张卡上，预览必须长得像结果本身——用户要能在 0.3 秒里
    // 判断该不该批准，而不是去读一段命令回显。
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

    calendar(card) {
      return h('div', { class: 'mcard-cal' }, [
        // 标题已经在头部画过了，这里不再来一遍——上一版两处都画，
        // 于是每张日程卡上「和设计过一遍卡片」出现两次。
        h('div', { class: 'mcal-row' }, [
          icon('ic-hist'), [card.start, card.end].filter(Boolean).join(' — '),
        ]),
        card.location ? h('div', { class: 'mcal-row' }, [icon('ic-target'), card.location]) : null,
        card.conflict
          ? h('div', { class: 'mcal-row is-warn' }, [icon('ic-warn'), card.conflict])
          : null,
      ]);
    },

    prompt(card) {
      return h('div', { class: 'mcard-prompt' }, [
        h('textarea', { class: 'mprompt-text', 'data-act': 'prompt-edit', rows: '6' }, [card.prompt || '']),
      ]);
    },

    steps() {
      return null;   // 过程卡的身子就是上面那串步骤，不用再画一遍
    },

    // MCP server 自己渲染的一块界面。
    //
    // MCP 2026-07-28 的 MCP Apps 允许 server 在对话里渲染交互式 UI，所以一次
    // 问答的结果可以是别人家的一块界面，而不只是我们画的一张卡。
    //
    // 两条不是样式的规矩：
    // 1. 沙盒里**绝不能有 allow-same-origin**。加上它，那块界面就能拿到我们的
    //    DOM 和 preload 桥——渲染别人的 UI 不等于把渲染进程交出去。
    // 2. 必须框起来并写清是哪个 server。用户任何时候都要能分清「它说的」
    //    和「我们说的」。
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
        // 拿不到能安全渲染的内容就说清楚，绝不静默留白
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

  /* 提案的预览按它将产生什么来画，而不是按它将执行什么命令来画。 */
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

  /* ============================================================
     动作
     ============================================================ */
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

  /* ============================================================
     入口
     ============================================================ */
  function renderCard(card: CardSpec | null | undefined, options: { density?: string } = {}): CardNode | null {
    if (!card || typeof card !== 'object') return null;
    const kind = BODY[card.kind] ? card.kind : 'prose';
    const density = options.density || 'full';   // capsule | companion | full
    return h('article', {
      class: 'mcard',
      'data-kind': kind,
      'data-state': card.state || 'done',
      'data-density': density,
      'data-card-id': card.id || '',
    }, [
      renderTop(card),
      renderSteps(card),
      renderNowLine(card),
      card.state === 'failed'
        ? h('p', { class: 'mcard-fail' }, [icon('ic-warn'), card.error || '这次没能完成。'])
        : null,
      BODY[kind](card) as CardChild,
      renderActions(card),
    ]);
  }

  return { renderCard, cardElapsedText, esc, safeSrc, markdown, inlineMd, h, KIND_FACE };
})();

// 渲染层用 renderCard(...)；主进程/测试 require 这个模块。
// 这两个名字是 classic-script 跨文件全局 API，定义文件本身不再引用。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const renderCard = CardRender.renderCard;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const cardElapsedText = CardRender.cardElapsedText;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CardRender;
}
