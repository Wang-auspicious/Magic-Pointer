/* exported ChatMarkdown */

const ChatMarkdown = (() => {
  interface ShimNode {
    tagName: string;
    attrs: Record<string, string>;
    children: Array<string | ShimNode>;
    rawHtml?: string;
    setAttribute(key: string, value: string): void;
    appendChild(child: string | ShimNode): unknown;
    readonly outerHTML: string;
  }

  interface KatexLike {
    renderToString(
      tex: string,
      options?: {
        displayMode?: boolean;
        throwOnError?: boolean;
        strict?: boolean | string;
        output?: 'html' | 'mathml' | 'htmlAndMathml';
      },
    ): string;
  }

  function resolveKatex(): KatexLike | null {
    const globalKatex = (
      globalThis as typeof globalThis & {katex?: KatexLike}
    ).katex;
    if (globalKatex && typeof globalKatex.renderToString === 'function') {
      return globalKatex;
    }
    if (typeof require === 'function') {
      try {
        const loaded = require('katex') as KatexLike;
        if (loaded && typeof loaded.renderToString === 'function') {
          return loaded;
        }
      } catch {
        /* katex optional in isolated sandboxes */
      }
    }
    return null;
  }

  type MdNode = Element | ShimNode;
  type MdChild = string | number | MdNode | null | undefined | false;

  const DOC = typeof document !== 'undefined' ? document : null;
  const VOID_TAGS = new Set(['br', 'hr', 'input', 'img']);
  const ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function shimNode(tag: string): ShimNode {
    const node: ShimNode = {
      tagName: tag,
      attrs: {},
      children: [],
      setAttribute(key, value) {
        node.attrs[key] = String(value);
      },
      appendChild(child) {
        node.children.push(child);
        return child;
      },
      get outerHTML() {
        const attr = Object.entries(node.attrs)
          .map(
            ([key, value]) =>
              ` ${key}="${value.replace(/[&<>"]/g, ch => ESCAPES[ch])}"`,
          )
          .join('');
        if (VOID_TAGS.has(tag)) {
          return `<${tag}${attr}>`;
        }
        if (typeof node.rawHtml === 'string') {
          return `<${tag}${attr}>${node.rawHtml}</${tag}>`;
        }
        const body = node.children
          .map(child =>
            typeof child === 'string'
              ? child.replace(/[&<>"']/g, ch => ESCAPES[ch])
              : child.outerHTML,
          )
          .join('');
        return `<${tag}${attr}>${body}</${tag}>`;
      },
    };
    return node;
  }

  function hRaw(
    tag: string,
    attrs: Record<string, string>,
    rawHtml: string,
  ): MdNode {
    const node = DOC ? DOC.createElement(tag) : shimNode(tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
    if (DOC) {
      (node as Element).innerHTML = rawHtml;
    } else {
      (node as ShimNode).rawHtml = rawHtml;
    }
    return node;
  }

  function learnAskSvgMarkup(): string {
    return (
      '<svg class="mp-learn-icon" width="14" height="14" viewBox="0 0 20 20" ' +
      'fill="none" stroke="currentColor" stroke-width="1.35" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4.625 15.375L15.375 4.625M15.375 11.696L15.375 4.625L8.304 4.625" vector-effect="non-scaling-stroke"/>' +
      '</svg>'
    );
  }

  function renderMathNode(tex: string, displayMode: boolean): MdNode {
    const cleaned = String(tex || '').trim();
    const katexApi = resolveKatex();
    const baseAttrs: Record<string, string> = {
      class: displayMode ? 'mp-learn-math-block' : 'mp-learn-math-inline',
      'data-mp-learn-anchor': 'math',
      'data-mp-learn-tex': cleaned,
      role: 'button',
      tabindex: '0',
      title: '点击就此公式深入追问',
    };
    if (katexApi) {
      try {
        const rendered = katexApi.renderToString(cleaned, {
          displayMode,
          throwOnError: false,
          strict: false,
          output: 'htmlAndMathml',
        });
        if (displayMode) {
          const wrap = h('div', baseAttrs);
          append(wrap, hRaw('div', {class: 'mp-learn-math-body'}, rendered));
          append(
            wrap,
            hRaw(
              'span',
              {class: 'mp-learn-math-ask-pill', 'aria-hidden': 'true'},
              learnAskSvgMarkup(),
            ),
          );
          return wrap;
        }
        return hRaw('span', baseAttrs, rendered);
      } catch {
        /* fallback to code span below */
      }
    }
    return h(
      displayMode ? 'div' : 'code',
      baseAttrs,
      displayMode ? `$$${cleaned}$$` : `$${cleaned}$`,
    );
  }

  function append(parent: MdNode, child: MdChild): void {
    if (child === null || child === undefined || child === false) {
      return;
    }
    if (DOC) {
      (parent as Element).appendChild(
        typeof child === 'string' || typeof child === 'number'
          ? DOC.createTextNode(String(child))
          : (child as Node),
      );
      return;
    }
    (parent as ShimNode).appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : (child as ShimNode),
    );
  }

  function h(
    tag: string,
    attrs: Record<string, string> = {},
    ...children: MdChild[]
  ): MdNode {
    const node = DOC ? DOC.createElement(tag) : shimNode(tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      append(node, child);
    }
    return node;
  }

  function safeHref(raw: string): string | null {
    const value = raw.trim();
    if (/^(https?:|mailto:)/i.test(value)) {
      return value;
    }
    return null;
  }

  function safeImageSource(raw: string): string | null {
    const value = raw.trim();
    if (/^(https?:\/\/|file:\/\/)/i.test(value)) {
      return value;
    }
    if (
      /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=]+$/i.test(
        value,
      )
    ) {
      return value;
    }
    if (/^(?:[a-z]:[\\/]|\/)/i.test(value)) {
      const slashed = value.replace(/\\/g, '/');
      return encodeURI(
        slashed.startsWith('/') ? `file://${slashed}` : `file:///${slashed}`,
      );
    }
    return null;
  }

  function codeCopyIcon(): MdChild {
    const icons =
      typeof ChatIcons !== 'undefined'
        ? ChatIcons
        : typeof require === 'function'
          ? require('./chat_icons')
          : null;
    const node = icons ? icons.node('copy', 14) : null;
    return node as unknown as MdChild;
  }

  type InlineMatch = {index: number; length: number; nodes: MdChild[]};

  function firstInline(text: string): InlineMatch | null {
    const candidates: InlineMatch[] = [];
    const add = (match: RegExpExecArray | null, nodes: MdChild[]) => {
      if (match) {
        candidates.push({index: match.index, length: match[0].length, nodes});
      }
    };

    let match = /`([^`\n]+)`/.exec(text);
    add(match, match ? [h('code', {}, match[1])] : []);

    // Escaped literal \$ -> '$'
    match = /\\\$/.exec(text);
    add(match, match ? ['$'] : []);

    // Inline display math $$...$$ inside a single line
    match = /\$\$([^\n$]+?)\$\$/.exec(text);
    if (match && match[1].trim()) {
      add(match, [renderMathNode(match[1], false)]);
    }

    // Inline \( ... \) math
    match = /\\\(([^\n]+?)\\\)/.exec(text);
    if (match && match[1].trim()) {
      add(match, [renderMathNode(match[1], false)]);
    }

    // Inline $...$ math (evaluated BEFORE *...* / _..._ so subscripts like $x_1 + x_2$ never get eaten)
    match = /(?<!\\)\$(?!\s|\$)((?:\\.|[^$\\\n])+?)(?<!\s)\$/.exec(text);
    if (match && !/^\d+(?:[.,]\d+)?$/.test(match[1].trim())) {
      add(match, [renderMathNode(match[1], false)]);
    }

    // Dotted-underline concept / leap anchor: [[term|gloss]] or [[term]]
    match = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*?))?\]\]/.exec(text);
    if (match) {
      const term = match[1].trim();
      const gloss = (match[2] || '').trim();
      const attrs: Record<string, string> = {
        type: 'button',
        class: 'mp-learn-term',
        'data-mp-learn-anchor': 'term',
        'data-mp-learn-term': term,
      };
      if (gloss) {
        attrs['data-mp-learn-gloss'] = gloss;
      }
      add(match, [h('button', attrs, ...inlineNodes(term))]);
    }

    // Highlighter sweep: ==important conclusion== (allow single '=' like $i=1$ inside!)
    match = /==((?:(?!==)[^\n])+?)==/.exec(text);
    if (match && match[1].trim()) {
      add(match, [
        h(
          'mark',
          {class: 'mp-learn-mark', 'data-fade-target': 'true'},
          ...inlineNodes(match[1]),
        ),
      ]);
    }

    match =
      /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"([^"\n]*)")?\)/.exec(
        text,
      );
    if (match) {
      const src = safeImageSource(match[2] || match[3]);
      const attrs: Record<string, string> = {
        class: 'mp-chat-image',
        src: src || '',
        alt: match[1],
        loading: 'lazy',
        decoding: 'async',
        'data-mp-chat-act': 'view-image',
        role: 'button',
        tabindex: '0',
      };
      if (match[4]) {
        attrs.title = match[4];
      }
      add(match, src ? [h('img', attrs)] : [match[0]]);
    }

    match = /\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/.exec(text);
    if (match) {
      const href = safeHref(match[2]);
      add(
        match,
        href
          ? [
              h(
                'a',
                {href, target: '_blank', rel: 'noreferrer'},
                ...inlineNodes(match[1]),
              ),
            ]
          : [match[1], ` (${match[2]})`],
      );
    }

    match = /\*\*([^*\n]+)\*\*/.exec(text);
    add(match, match ? [h('strong', {}, ...inlineNodes(match[1]))] : []);
    match = /__([^_\n]+)__/.exec(text);
    add(match, match ? [h('strong', {}, ...inlineNodes(match[1]))] : []);
    match = /~~([^~\n]+)~~/.exec(text);
    add(match, match ? [h('del', {}, ...inlineNodes(match[1]))] : []);
    match = /(^|[^*])\*([^*\n]+)\*/.exec(text);
    if (match) {
      const prefix = match[1];
      candidates.push({
        index: match.index,
        length: match[0].length,
        nodes: [prefix, h('em', {}, ...inlineNodes(match[2]))],
      });
    }
    match = /(^|[^_])_([^_\n]+)_/.exec(text);
    if (match) {
      const prefix = match[1];
      candidates.push({
        index: match.index,
        length: match[0].length,
        nodes: [prefix, h('em', {}, ...inlineNodes(match[2]))],
      });
    }

    candidates.sort(
      (left, right) => left.index - right.index || right.length - left.length,
    );
    return candidates[0] || null;
  }

  function inlineNodes(text: string): MdChild[] {
    const out: MdChild[] = [];
    let rest = String(text || '');
    while (rest) {
      const match = firstInline(rest);
      if (!match) {
        out.push(rest);
        break;
      }
      if (match.index > 0) {
        out.push(rest.slice(0, match.index));
      }
      out.push(...match.nodes);
      rest = rest.slice(match.index + match.length);
    }
    return out;
  }

  function splitTableRow(line: string): string[] {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());
  }

  function imageLineNodes(line: string): MdNode[] | null {
    if (!line.trim().startsWith('![')) {
      return null;
    }
    const nodes = inlineNodes(line.trim());
    if (
      nodes.some(node =>
        typeof node === 'string'
          ? Boolean(node.trim())
          : !node ||
            typeof node === 'number' ||
            node.tagName.toLowerCase() !== 'img',
      )
    ) {
      return null;
    }
    const images = nodes.filter(node => typeof node !== 'string') as MdNode[];
    return images.length ? images : null;
  }

  function isTableDivider(line: string): boolean {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
  }

  type CardCategory = 'concept' | 'mechanism' | 'compare' | 'trap' | 'formula';

  function normalizeCardCategory(rawTag: string): {
    category: CardCategory;
    tagLabel: string;
  } {
    const lower = rawTag.trim().toLowerCase();
    if (!lower) {
      return {category: 'concept', tagLabel: ''};
    }
    if (lower === 'concept' || lower === '概念' || lower === 'p0') {
      return {category: 'concept', tagLabel: 'concept'};
    }
    if (
      lower === 'mechanism' ||
      lower === '机制' ||
      lower === 'p1' ||
      lower.startsWith('step')
    ) {
      return {category: 'mechanism', tagLabel: 'mechanism'};
    }
    if (lower === 'compare' || lower === '对比' || lower === 'p2') {
      return {category: 'compare', tagLabel: 'compare'};
    }
    if (lower === 'trap' || lower === '误区' || lower === 'pitfall') {
      return {category: 'trap', tagLabel: 'trap'};
    }
    if (lower === 'formula' || lower === '公式') {
      return {category: 'formula', tagLabel: 'formula'};
    }
    return {category: 'concept', tagLabel: lower};
  }

  function isBlockStart(lines: string[], index: number): boolean {
    const line = lines[index] || '';
    return (
      /^\s*$/.test(line) ||
      /^\s*```/.test(line) ||
      /^\s*:::card\b/i.test(line) ||
      /^\s*:::prereq\b/i.test(line) ||
      /^\s*:::lab\b/i.test(line) ||
      /^\s*\$\$/.test(line) ||
      /^\s*\\\[/.test(line) ||
      /^\s{0,3}#{1,6}\s+/.test(line) ||
      /^\s{0,3}>\s?/.test(line) ||
      /^\s{0,3}(?:[-+*]|\d+[.)])\s+/.test(line) ||
      /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
      (line.includes('|') && isTableDivider(lines[index + 1] || ''))
    );
  }

  function renderBlocks(lines: string[]): MdNode[] {
    const blocks: MdNode[] = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      // Prerequisite dependency chain strip: :::prereq\nA -> B -> C\n:::
      if (/^\s*:::prereq\b/i.test(line)) {
        const prereqLines: string[] = [];
        index += 1;
        while (index < lines.length && !/^\s*:::\s*$/.test(lines[index])) {
          prereqLines.push(lines[index++]);
        }
        if (index < lines.length && /^\s*:::\s*$/.test(lines[index])) {
          index += 1;
        }
        const strip = h('section', {
          class: 'mp-learn-prereq-strip',
          'data-learn-prereq': 'true',
        });
        append(strip, h('span', {class: 'mp-learn-prereq-label'}, '先修脉络'));
        const items: string[] = [];
        for (const pLine of prereqLines) {
          for (const part of pLine.split(/\s*(?:->|→|=>)\s*/)) {
            const clean = part.trim();
            if (clean && !items.includes(clean)) {
              items.push(clean);
            }
          }
        }
        items.forEach((item, itemIdx) => {
          if (itemIdx > 0) {
            append(
              strip,
              h(
                'span',
                {class: 'mp-learn-prereq-arrow', 'aria-hidden': 'true'},
                '→',
              ),
            );
          }
          append(
            strip,
            h(
              'button',
              {
                type: 'button',
                class: 'mp-learn-prereq-chip',
                'data-mp-learn-anchor': 'term',
                'data-mp-learn-term': item,
                'data-mp-learn-gloss': '前置依赖概念：点击快速回溯或提问',
              },
              item,
            ),
          );
        });
        blocks.push(strip);
        continue;
      }

      // Interactive Explorable Lab block: :::lab\n{...}\n:::
      if (/^\s*:::lab\b/i.test(line)) {
        const labLines: string[] = [];
        index += 1;
        while (index < lines.length && !/^\s*:::\s*$/.test(lines[index])) {
          labLines.push(lines[index++]);
        }
        const complete = index < lines.length && /^\s*:::\s*$/.test(lines[index]);
        if (complete) {
          index += 1;
        }
        const rawSpec = labLines.join('\n').trim();
        blocks.push(
          h(
            'section',
            {
              class: 'mp-learn-lab-host',
              'data-learn-lab-complete': complete ? 'true' : 'false',
              'data-learn-lab-spec': rawSpec,
            },
            complete ? '正在挂载交互实验…' : '正在生成交互参数…',
          ),
        );
        continue;
      }

      // Same-layer Learn editorial divider: :::card [concept|mechanism|compare|trap|formula] Title ... :::
      const cardMatch = /^\s*:::card(?:\s+\[([^\]]+)\])?\s*(.*?)\s*$/i.exec(line);
      if (cardMatch) {
        const rawTag = (cardMatch[1] || '').trim();
        const {category, tagLabel} = normalizeCardCategory(rawTag);
        const title = (cardMatch[2] || '').trim() || tagLabel || '要点分解';
        const cardLines: string[] = [];
        index += 1;
        while (index < lines.length && !/^\s*:::\s*$/.test(lines[index])) {
          cardLines.push(lines[index++]);
        }
        if (index < lines.length && /^\s*:::\s*$/.test(lines[index])) {
          index += 1;
        }
        const snippet = cardLines.join('\n').trim().slice(0, 900);
        const head = h('header', {class: 'mp-learn-card-head'});
        const titleCluster = h('div', {class: 'mp-learn-card-title-cluster'});
        if (tagLabel) {
          append(
            titleCluster,
            h('span', {class: 'mp-learn-card-tag'}, tagLabel),
          );
        }
        append(
          titleCluster,
          h('strong', {class: 'mp-learn-card-title'}, ...inlineNodes(title)),
        );
        append(head, titleCluster);
        append(
          head,
          hRaw(
            'button',
            {
              type: 'button',
              class: 'mp-learn-card-ask',
              'aria-label': `深入追问：${title}`,
              title: '深入追问',
              'data-mp-learn-anchor': 'card',
              'data-mp-learn-label': title,
              'data-mp-learn-snippet': snippet || title,
              ...(tagLabel ? {'data-mp-learn-category': category} : {}),
            },
            learnAskSvgMarkup(),
          ),
        );
        const bodyNode = h(
          'div',
          {class: 'mp-learn-card-body'},
          ...renderBlocks(cardLines),
        );
        blocks.push(
          h(
            'section',
            {
              class: 'mp-learn-card',
              'data-category': category,
              'data-card-title': title,
            },
            head,
            bodyNode,
          ),
        );
        continue;
      }

      // Display Math block: $$ ... $$ or \[ ... \]
      const singleLineDollarMath = /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
      if (singleLineDollarMath && singleLineDollarMath[1].trim()) {
        blocks.push(renderMathNode(singleLineDollarMath[1], true));
        index += 1;
        continue;
      }
      if (/^\s*\$\$\s*$/.test(line) || /^\s*\\\[\s*$/.test(line)) {
        const closing = /^\s*\$\$/.test(line) ? /^\s*\$\$\s*$/ : /^\s*\\\]\s*$/;
        const mathLines: string[] = [];
        index += 1;
        while (index < lines.length && !closing.test(lines[index])) {
          mathLines.push(lines[index++]);
        }
        if (index < lines.length) {
          index += 1;
        }
        blocks.push(renderMathNode(mathLines.join('\n'), true));
        continue;
      }

      const images = imageLineNodes(line);
      if (images) {
        index += 1;
        while (index < lines.length) {
          if (!lines[index].trim() && imageLineNodes(lines[index + 1] || '')) {
            index += 1;
            continue;
          }
          const nextImages = imageLineNodes(lines[index]);
          if (!nextImages) {
            break;
          }
          images.push(...nextImages);
          index += 1;
        }
        blocks.push(
          h(
            'div',
            {class: 'mp-chat-image-grid', 'data-count': String(images.length)},
            ...images,
          ),
        );
        continue;
      }

      const fence = /^\s*```\s*([^\s`]*)\s*$/.exec(line);
      if (fence) {
        const body: string[] = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          body.push(lines[index++]);
        }
        const complete = index < lines.length;
        if (index < lines.length) {
          index += 1;
        }
        const lang = fence[1] || '';
        if (lang.toLowerCase() === 'openui') {
          blocks.push(h('section', {
            class: 'mp-openui-block',
            'data-openui-source': body.join('\n'),
            'data-openui-complete': String(complete),
          }, h('pre', {}, h('code', {}, body.join('\n')))));
          continue;
        }
        const attrs: Record<string, string> = lang
          ? {class: `language-${lang}`}
          : {};
        const card = h('div', {class: 'mp-chat-code'});
        if (lang) {
          card.setAttribute('data-lang', lang);
        }
        const head = h('div', {class: 'mp-chat-code-head'});
        append(head, h('span', {class: 'mp-chat-code-lang'}, lang));
        const copyAttrs: Record<string, string> = {
          type: 'button',
          class: 'mp-chat-action mp-chat-code-copy',
          'aria-label': '复制代码',
          'data-mp-chat-act': 'copy',
          'data-mp-chat-copy': body.join('\n'),
        };
        append(head, h('button', copyAttrs, codeCopyIcon()));
        append(card, head);
        append(card, h('pre', {}, h('code', attrs, body.join('\n'))));
        blocks.push(card);
        continue;
      }

      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        blocks.push(h(`h${heading[1].length}`, {}, ...inlineNodes(heading[2])));
        index += 1;
        continue;
      }

      if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        blocks.push(h('hr'));
        index += 1;
        continue;
      }

      if (/^\s{0,3}>\s?/.test(line)) {
        const quoted: string[] = [];
        while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
          quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
          index += 1;
        }
        blocks.push(h('blockquote', {}, ...renderBlocks(quoted)));
        continue;
      }

      if (line.includes('|') && isTableDivider(lines[index + 1] || '')) {
        const headers = splitTableRow(line);
        index += 2;
        const rows: string[][] = [];
        while (
          index < lines.length &&
          lines[index].includes('|') &&
          lines[index].trim()
        ) {
          rows.push(splitTableRow(lines[index++]));
        }
        const thead = h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...headers.map(cell => h('th', {}, ...inlineNodes(cell))),
          ),
        );
        const tbody = h(
          'tbody',
          {},
          ...rows.map(row =>
            h(
              'tr',
              {},
              ...headers.map((_header, cellIndex) =>
                h('td', {}, ...inlineNodes(row[cellIndex] || '')),
              ),
            ),
          ),
        );
        blocks.push(h('table', {}, thead, tbody));
        continue;
      }

      const listMatch = /^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(line);
      if (listMatch) {
        const ordered = /^\d/.test(listMatch[1]);
        const list = h(ordered ? 'ol' : 'ul');
        while (index < lines.length) {
          const item = /^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(lines[index]);
          if (!item || /^\d/.test(item[1]) !== ordered) {
            break;
          }
          let content = item[2];
          const li = h('li');
          const task = /^\[([ xX])\]\s+(.+)$/.exec(content);
          if (task) {
            const attrs: Record<string, string> = {
              type: 'checkbox',
              disabled: 'true',
            };
            if (task[1].toLowerCase() === 'x') {
              attrs.checked = 'true';
            }
            append(li, h('input', attrs));
            content = task[2];
          }
          for (const child of inlineNodes(content)) {
            append(li, child);
          }
          append(list, li);
          index += 1;
        }
        blocks.push(list);
        continue;
      }

      const paragraph: string[] = [line.trim()];
      index += 1;
      while (index < lines.length && !isBlockStart(lines, index)) {
        paragraph.push(lines[index++].trim());
      }
      const p = h('p');
      paragraph.forEach((part, partIndex) => {
        if (partIndex) {
          append(p, h('br'));
        }
        for (const child of inlineNodes(part)) {
          append(p, child);
        }
      });
      blocks.push(p);
    }
    return blocks;
  }

  function render(markdown: unknown): MdNode {
    const root = h('div', {class: 'mp-chat-markdown'});
    const lines = String(markdown || '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    const blocks = renderBlocks(lines);
    blocks.forEach((block, blockIndex) => {
      block.setAttribute('data-block-index', String(blockIndex));
      append(root, block);
    });
    return root;
  }

  return {
    render,
    __test: {inlineNodes, safeHref, safeImageSource, splitTableRow},
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatMarkdown;
}
