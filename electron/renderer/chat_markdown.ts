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
      '<span class="cds-icon mp-learn-icon" data-size="sm" data-glyph="&#xE015;" ' +
      'style="font-size:14px;--cds-opsz:16;--cds-wght:533.3;" aria-hidden="true"></span>'
    );
  }

  function renderMathNode(tex: string, displayMode: boolean): MdNode {
    const cleaned = String(tex || '')
      .trim()
      .replace(/\^\s*\\\*/g, '^*')
      .replace(/\{\s*\\\*\s*\}/g, '{*}');
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

  function decodeFileHref(raw: string): string {
    const stripped = raw
      .trim()
      .replace(/^file:\/\//i, '')
      .replace(/#.*$/, '');
    let decoded = stripped;
    try {
      decoded = decodeURIComponent(stripped);
    } catch {
      decoded = stripped;
    }
    if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) {
      decoded = decoded.slice(1);
    }
    return decoded;
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

  const FILE_EXT_RE =
    /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|ps1|bat|cmd|css|scss|less|html|htm|xml|json|yaml|yml|toml|ini|md|mdx|txt|sql|vue|svelte|graphql|proto|lock|env|cfg|conf|log)$/i;

  function looksLikeFilePathCode(raw: string): boolean {
    const trimmed = raw.trim();
    if (
      !trimmed ||
      trimmed.length > 220 ||
      /[\s=<>|"'`]/.test(trimmed) ||
      /^https?:\/\//i.test(trimmed)
    ) {
      return false;
    }
    const stripped = trimmed.replace(/:\d+(?:-\d+)?(?::\d+)?$/, '');
    if (!FILE_EXT_RE.test(stripped)) {
      return false;
    }
    return /[\\/]/.test(stripped) || /:\d+/.test(trimmed);
  }

  function firstInline(text: string): InlineMatch | null {
    const candidates: InlineMatch[] = [];
    const add = (match: RegExpExecArray | null, nodes: MdChild[]) => {
      if (match) {
        candidates.push({index: match.index, length: match[0].length, nodes});
      }
    };

    let match = /`([^`\n]+)`/.exec(text);
    if (match) {
      const codeText = match[1];
      const isFile = looksLikeFilePathCode(codeText);
      add(match, [
        h(
          'code',
          isFile
            ? {
                class: 'mp-chat-file-pill',
                'data-mp-file-ref': codeText.trim(),
                role: 'button',
                tabindex: '0',
                title: codeText.trim(),
              }
            : {},
          codeText,
        ),
      ]);
    }

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
    const inlineDollarRe =
      /(?<!\\)\$(?!\s|\$)((?:\\.|[^$\\\n])+?)(?<!\s)\$/g;
    while ((match = inlineDollarRe.exec(text))) {
      const inner = match[1].trim();
      if (!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(inner)) {
        add(match, [renderMathNode(match[1], false)]);
        break;
      }
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
      const target = match[2].trim();
      if (/^artifact:([^\s#?]+)/i.test(target)) {
        const artifactId = target.replace(/^artifact:/i, '').split(/[?#]/)[0].trim();
        add(match, [
          h(
            'button',
            {
              type: 'button',
              class: 'mp-chat-artifact-link',
              'data-mp-chat-act': 'open-artifact',
              'data-artifact-id': artifactId,
              title: target,
            },
            ...inlineNodes(match[1]),
          ),
        ]);
      } else if (/^file:\/\//i.test(target)) {
        const filePath = decodeFileHref(target);
        add(match, [
          h(
            'button',
            {
              type: 'button',
              class: 'mp-chat-artifact-link mp-chat-file-link',
              'data-mp-chat-act': 'open-file',
              'data-file-path': filePath,
              'data-file-absolute-path': filePath,
              title: filePath,
            },
            ...inlineNodes(match[1]),
          ),
        ]);
      } else {
        const href = safeHref(target);
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

  function extractVisualTitle(rawCode: string, fallback: string): string {
    const titleMatch =
      /<title[^>]*>([^<]{1,80})<\/title>/i.exec(rawCode) ||
      /<h[12][^>]*>([^<]{1,80})<\/h[12]>/i.exec(rawCode) ||
      /aria-label=["']([^"']{1,60})["']/i.exec(rawCode);
    return titleMatch ? titleMatch[1].trim() : fallback;
  }

  function wrapSvgFragmentForPreview(rawCode: string): string {
    return (
      '<div class="mp-svg-stage">' +
      '<svg class="mp-svg-auto-fit" xmlns="http://www.w3.org/2000/svg" ' +
      'style="color:var(--accent,#d97757)" fill="currentColor">' +
      rawCode.trim() +
      '</svg></div>'
    );
  }

  function classifyVisualFence(
    lang: string,
    rawCode: string,
  ): {kind: 'html' | 'svg' | 'svg-snippet'; title: string; src: string; rawSource?: string} | null {
    const normalizedLang = lang.trim().toLowerCase();
    const trimmed = rawCode.trim();
    if (!trimmed) {
      return null;
    }
    if ((normalizedLang === 'svg' || normalizedLang === 'xml') && /<svg\b/i.test(trimmed)) {
      return {
        kind: 'svg',
        title: extractVisualTitle(trimmed, 'SVG 图解'),
        src: trimmed,
        rawSource: trimmed,
      };
    }
    const isSvgPrimitiveSnippet =
      (normalizedLang === 'html' || normalizedLang === 'svg' || normalizedLang === 'xml') &&
      !/<svg\b|<html\b|<!doctype\b/i.test(trimmed) &&
      /^\s*(?:<(?:path|circle|ellipse|rect|polygon|polyline|line|g)\b[\s\S]*?>\s*)+$/i.test(
        trimmed,
      ) &&
      /\b(?:d|points|cx|cy|rx|ry|x1|x2|width|height)=/i.test(trimmed);
    if (isSvgPrimitiveSnippet) {
      return {
        kind: 'svg-snippet',
        title: 'SVG 图形预览',
        src: wrapSvgFragmentForPreview(trimmed),
        rawSource: trimmed,
      };
    }
    if (normalizedLang === 'html') {
      const hasFullOrCanvasOrSvg = /(<!doctype\s+html|<html\b|<svg\b|<canvas\b)/i.test(
        trimmed,
      );
      const hasRichInteractive =
        /(<style\b|<script\b|<input\b|<button\b)/i.test(trimmed) &&
        /(<div\b|<section\b|<main\b|<figure\b|<svg\b|<canvas\b|<button\b|<input\b|<table\b)/i.test(
          trimmed,
        );
      const hasInlineStyledBlock =
        /<(?:div|section|figure)\b[^>]*\bstyle=["'][^"']{24,}["']/i.test(trimmed);
      if (hasFullOrCanvasOrSvg || hasRichInteractive || hasInlineStyledBlock) {
        return {
          kind: 'html',
          title: extractVisualTitle(trimmed, '交互式可视化'),
          src: trimmed,
          rawSource: trimmed,
        };
      }
    }
    return null;
  }

  function isBlockStart(lines: string[], index: number): boolean {
    const line = lines[index] || '';
    return (
      /^\s*$/.test(line) ||
      /^\s*```/.test(line) ||
      /^\s*:::card\b/i.test(line) ||
      /^\s*:::prereq\b/i.test(line) ||
      /^\s*:::lab\b/i.test(line) ||
      /^\s*:::checkin\b/i.test(line) ||
      /^\s*:::(?:ui|widget)\b/i.test(line) ||
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

      // Intelligence UI live sandboxed widget: :::ui [Title]\n<html>...\n:::
      const uiMatch = /^\s*:::(?:ui|widget)\b(?:\s+(.*))?$/i.exec(line);
      if (uiMatch) {
        const uiTitle = (uiMatch[1] || '').trim() || '交互式认知微件';
        const uiLines: string[] = [];
        index += 1;
        while (index < lines.length && !/^\s*:::\s*$/.test(lines[index])) {
          uiLines.push(lines[index++]);
        }
        const complete = index < lines.length && /^\s*:::\s*$/.test(lines[index]);
        if (complete) {
          index += 1;
        }
        const rawSrc = uiLines.join('\n').trim();
        blocks.push(
          h(
            'section',
            {
              class: 'mp-iui-card',
              'data-iui-complete': complete ? 'true' : 'false',
              'data-iui-title': uiTitle,
              'data-iui-src': complete ? rawSrc : '',
            },
            complete ? '正在挂载交互微件…' : '正在构建 Intelligence UI 微件…',
          ),
        );
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

      // Inline pedagogical understanding check-in block: :::checkin\n...\n:::
      if (/^\s*:::checkin\b/i.test(line)) {
        const checkinLines: string[] = [];
        index += 1;
        while (index < lines.length && !/^\s*:::\s*$/.test(lines[index])) {
          checkinLines.push(lines[index++]);
        }
        const complete = index < lines.length && /^\s*:::\s*$/.test(lines[index]);
        if (complete) {
          index += 1;
        }
        const rawSpec = checkinLines.join('\n').trim();
        blocks.push(
          h(
            'section',
            {
              class: 'mp-checkin-host',
              'data-checkin-complete': complete ? 'true' : 'false',
              'data-checkin-raw': rawSpec,
            },
            complete ? '正在加载思考节点…' : '正在组织理解校验卡…',
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
        const rawCode = body.join('\n');
        if (lang.toLowerCase() === 'openui') {
          blocks.push(h('section', {
            class: 'mp-openui-block',
            'data-openui-source': rawCode,
            'data-openui-complete': String(complete),
          }, h('pre', {}, h('code', {}, rawCode))));
          continue;
        }
        const visual = classifyVisualFence(lang, rawCode);
        if (visual) {
          const cardAttrs: Record<string, string> = {
            class: 'mp-iui-card',
            'data-iui-complete': complete ? 'true' : 'false',
            'data-iui-kind': visual.kind,
            'data-iui-title': visual.title,
            'data-iui-src': complete ? visual.src : '',
            'data-iui-allow-source': 'true',
          };
          if (complete && visual.rawSource && visual.rawSource !== visual.src) {
            cardAttrs['data-iui-raw-source'] = visual.rawSource;
          }
          blocks.push(
            h(
              'section',
              cardAttrs,
              complete ? '正在挂载交互视图…' : '正在生成交互可视化…',
            ),
          );
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
          'data-mp-chat-copy': rawCode,
        };
        append(head, h('button', copyAttrs, codeCopyIcon()));
        append(card, head);
        const codeNode = h('code', attrs);
        const highlighter = (
          globalThis as typeof globalThis & {
            ChatHighlight?: {
              highlight: (
                code: string,
                language: string,
              ) => Array<Array<{text: string; token: string}>>;
              languageOf?: (language: string) => string;
            };
          }
        ).ChatHighlight;
        const resolvedLang =
          lang && highlighter?.languageOf ? highlighter.languageOf(lang) : 'plain';
        if (highlighter && resolvedLang !== 'plain') {
          const highlightedLines = highlighter.highlight(rawCode, resolvedLang);
          highlightedLines.forEach((spans, lineIdx) => {
            for (const span of spans) {
              if (!span.text) {
                continue;
              }
              if (span.token === 'plain') {
                append(codeNode, span.text);
              } else {
                append(
                  codeNode,
                  h('span', {class: `mp-chat-tok-${span.token}`}, span.text),
                );
              }
            }
            if (lineIdx + 1 < highlightedLines.length) {
              append(codeNode, '\n');
            }
          });
        } else {
          append(codeNode, rawCode);
        }
        append(card, h('pre', {}, codeNode));
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
        blocks.push(
          h('div', {class: 'mp-chat-table-scroll'}, h('table', {}, thead, tbody)),
        );
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

  const TOUR_POINT_RE =
    /\[POINT:\s*(\d{1,5})\s*,\s*(\d{1,5})(?:\s*:\s*([^:\]]+?))?(?:\s*:\s*screen(\d+))?\s*\]/gi;
  const TOUR_ANY_TAG_RE =
    /\[(?:POINT:\s*\d{1,5}\s*,\s*\d{1,5}(?:\s*:\s*[^:\]]+?)?(?:\s*:\s*screen\d+)?|CIRCLE:\s*\d{1,5}\s*,\s*\d{1,5}\s*,\s*\d{1,5}(?:\s*:\s*[^\]]+)?|ARROW:\s*\d{1,5}\s*,\s*\d{1,5}\s*->\s*\d{1,5}\s*,\s*\d{1,5}|LABEL:\s*\d{1,5}\s*,\s*\d{1,5}\s*:\s*[^\]]+)\]/gi;

  interface InlineTourStep {
    x: number;
    y: number;
    screen: number;
    label: string;
    sentence: string;
    normalized: boolean;
  }

  function extractInlineTourSteps(source: string): InlineTourStep[] {
    if (!source.includes('[POINT:')) {
      return [];
    }
    const matches = Array.from(source.matchAll(TOUR_POINT_RE));
    if (!matches.length) {
      return [];
    }
    const steps: InlineTourStep[] = [];
    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i];
      const x = Number(m[1]);
      const y = Number(m[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }
      const label = (m[3] || '').trim() || `步骤 ${steps.length + 1}`;
      const screen = m[4] ? Math.max(1, Number(m[4]) || 1) : 1;
      const startAfter = (m.index ?? 0) + m[0].length;
      const nextStart =
        i + 1 < matches.length ? (matches[i + 1].index ?? source.length) : source.length;
      const sentence = source
        .slice(startAfter, nextStart)
        .replace(TOUR_ANY_TAG_RE, '')
        .split(/\r?\n/)[0]
        .trim()
        .slice(0, 140);
      steps.push({
        x,
        y,
        screen,
        label,
        sentence,
        normalized: x <= 1000 && y <= 1000,
      });
    }
    return steps;
  }

  function currentMarkdownLocale(): 'en' | 'zh-CN' {
    if (typeof (globalThis as {getStudioLanguage?: () => string}).getStudioLanguage === 'function') {
      return (globalThis as {getStudioLanguage: () => string}).getStudioLanguage() === 'zh-CN'
        ? 'zh-CN'
        : 'en';
    }
    if (DOC?.documentElement?.lang === 'zh-CN') {
      return 'zh-CN';
    }
    return 'en';
  }

  function buildGuidedTourCard(steps: InlineTourStep[]): MdNode {
    const isZh = currentMarkdownLocale() === 'zh-CN';
    const card = h('section', {
      class: 'mp-tour-card',
      'aria-label': isZh ? '屏幕指点导览' : 'Guided screen tour',
    });
    const head = h('header', {class: 'mp-tour-card-head'});
    append(
      head,
      h(
        'span',
        {class: 'mp-tour-card-title'},
        isZh ? `屏幕指点导览 · ${steps.length} 步` : `Guided Screen Tour · ${steps.length} steps`,
      ),
    );
    const controls = h('div', {class: 'mp-tour-card-controls'});
    append(
      controls,
      h(
        'button',
        {
          type: 'button',
          class: 'mp-tour-ctrl-btn',
          'data-tour-act': 'live-teach',
          title: isZh
            ? '打开始终置顶的桌面悬浮带练条（下一步 / 帮我点这步 / 退出）'
            : 'Open floating desktop coach bar (Next / Click for me / Exit)',
        },
        isZh ? '悬浮带练' : 'Floating guide',
      ),
    );
    append(
      controls,
      h(
        'button',
        {
          type: 'button',
          class: 'mp-tour-ctrl-btn',
          'data-tour-act': 'autopilot',
          title: isZh
            ? '直接启动桌面 Computer Use 自动代为执行这些步骤'
            : 'Run these steps directly using Computer Use Autopilot',
        },
        isZh ? 'AI 代操作' : 'Run with Computer Use',
      ),
    );
    append(
      controls,
      h(
        'button',
        {
          type: 'button',
          class: 'mp-tour-ctrl-btn',
          'data-tour-act': 'clear',
          title: isZh ? '隐藏屏幕光标' : 'Hide screen cursor',
        },
        isZh ? '隐藏光标' : 'Hide cursor',
      ),
    );
    append(head, controls);
    append(card, head);

    const list = h('ol', {class: 'mp-tour-step-list'});
    steps.forEach((step, idx) => {
      const btn = h(
        'button',
        {
          type: 'button',
          class: 'mp-tour-step',
          'data-tour-act': 'point',
          'data-tour-index': String(idx),
          'data-tour-x': String(step.x),
          'data-tour-y': String(step.y),
          'data-tour-screen': String(step.screen),
          'data-tour-normalized': step.normalized ? 'true' : 'false',
          'data-tour-label': step.label,
          'data-tour-caption': step.label || step.sentence,
        },
        h('span', {class: 'mp-tour-step-num'}, String(idx + 1)),
        h('span', {class: 'mp-tour-step-label'}, step.label),
        step.sentence
          ? h('span', {class: 'mp-tour-step-desc'}, step.sentence)
          : null,
      );
      append(list, h('li', {}, btn));
    });
    append(card, list);
    return card;
  }

  function render(markdown: unknown): MdNode {
    const root = h('div', {class: 'mp-chat-markdown'});
    const raw = String(markdown || '').replace(/\r\n?/g, '\n');
    const tourSteps = extractInlineTourSteps(raw);
    const cleaned = tourSteps.length || /\[(?:CIRCLE|ARROW|LABEL):/i.test(raw)
      ? raw.replace(TOUR_ANY_TAG_RE, '').replace(/[ \t]{2,}/g, ' ')
      : raw;
    const lines = cleaned.split('\n');
    const blocks = renderBlocks(lines);
    blocks.forEach((block, blockIndex) => {
      block.setAttribute('data-block-index', String(blockIndex));
      append(root, block);
    });
    if (tourSteps.length) {
      append(root, buildGuidedTourCard(tourSteps));
    }
    return root;
  }

  return {
    render,
    __test: {inlineNodes, safeHref, safeImageSource, splitTableRow},
  };
})();

if (typeof globalThis !== 'undefined' && !(globalThis as Record<string, unknown>).ChatMarkdown) {
  (globalThis as Record<string, unknown>).ChatMarkdown = ChatMarkdown;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatMarkdown;
}
