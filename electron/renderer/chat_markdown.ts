/* exported ChatMarkdown */

const ChatMarkdown = (() => {
  interface ShimNode {
    tagName: string;
    attrs: Record<string, string>;
    children: (string | ShimNode)[];
    setAttribute(key: string, value: string): void;
    appendChild(child: string | ShimNode): unknown;
    readonly outerHTML: string;
  }

  type MdNode = Element | ShimNode;
  type MdChild = string | number | MdNode | null | undefined | false;

  const DOC = typeof document !== 'undefined' ? document : null;
  const VOID_TAGS = new Set(['br', 'hr', 'input', 'img']);
  const ESCAPES: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  };

  function shimNode(tag: string): ShimNode {
    const node: ShimNode = {
      tagName: tag,
      attrs: {},
      children: [],
      setAttribute(key, value) { node.attrs[key] = String(value); },
      appendChild(child) { node.children.push(child); return child; },
      get outerHTML() {
        const attr = Object.entries(node.attrs)
          .map(([key, value]) => ` ${key}="${value.replace(/[&<>"]/g, (ch) => ESCAPES[ch])}"`)
          .join('');
        if (VOID_TAGS.has(tag)) return `<${tag}${attr}>`;
        const body = node.children.map((child) => typeof child === 'string'
          ? child.replace(/[&<>"']/g, (ch) => ESCAPES[ch])
          : child.outerHTML).join('');
        return `<${tag}${attr}>${body}</${tag}>`;
      },
    };
    return node;
  }

  function append(parent: MdNode, child: MdChild): void {
    if (child === null || child === undefined || child === false) return;
    if (DOC) {
      (parent as Element).appendChild(
        typeof child === 'string' || typeof child === 'number'
          ? DOC.createTextNode(String(child))
          : child as Node,
      );
      return;
    }
    (parent as ShimNode).appendChild(
      typeof child === 'string' || typeof child === 'number' ? String(child) : child as ShimNode,
    );
  }

  function h(tag: string, attrs: Record<string, string> = {}, ...children: MdChild[]): MdNode {
    const node = DOC ? DOC.createElement(tag) : shimNode(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    for (const child of children.flat()) append(node, child);
    return node;
  }

  function safeHref(raw: string): string | null {
    const value = raw.trim();
    if (/^(https?:|mailto:)/i.test(value)) return value;
    return null;
  }

  function safeImageSource(raw: string): string | null {
    const value = raw.trim();
    if (/^(https?:\/\/|file:\/\/)/i.test(value)) return value;
    if (/^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
    if (/^(?:[a-z]:[\\/]|\/)/i.test(value)) {
      const slashed = value.replace(/\\/g, '/');
      return encodeURI(slashed.startsWith('/') ? `file://${slashed}` : `file:///${slashed}`);
    }
    return null;
  }

  function codeCopyIcon(): MdChild {
    const icons = typeof ChatIcons !== 'undefined'
      ? ChatIcons
      : (typeof require === 'function' ? require('./chat_icons') : null);
    const node = icons ? icons.node('copy', 14) : null;
    return node as unknown as MdChild;
  }

  type InlineMatch = { index: number; length: number; nodes: MdChild[] };

  function firstInline(text: string): InlineMatch | null {
    const candidates: InlineMatch[] = [];
    const add = (match: RegExpExecArray | null, nodes: MdChild[]) => {
      if (match) candidates.push({ index: match.index, length: match[0].length, nodes });
    };

    let match = /`([^`\n]+)`/.exec(text);
    add(match, match ? [h('code', {}, match[1])] : []);

    match = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"([^"\n]*)")?\)/.exec(text);
    if (match) {
      const src = safeImageSource(match[2] || match[3]);
      const attrs: Record<string, string> = { class: 'mp-chat-image', src: src || '', alt: match[1], loading: 'lazy', decoding: 'async' };
      if (match[4]) attrs.title = match[4];
      add(match, src ? [h('img', attrs)] : [match[0]]);
    }

    match = /\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/.exec(text);
    if (match) {
      const href = safeHref(match[2]);
      add(match, href
        ? [h('a', { href, target: '_blank', rel: 'noreferrer' }, ...inlineNodes(match[1]))]
        : [match[1], ` (${match[2]})`]);
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

    candidates.sort((left, right) => left.index - right.index || right.length - left.length);
    return candidates[0] || null;
  }

  function inlineNodes(text: string): MdChild[] {
    const out: MdChild[] = [];
    let rest = String(text || '');
    while (rest) {
      const match = firstInline(rest);
      if (!match) { out.push(rest); break; }
      if (match.index > 0) out.push(rest.slice(0, match.index));
      out.push(...match.nodes);
      rest = rest.slice(match.index + match.length);
    }
    return out;
  }

  function splitTableRow(line: string): string[] {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  }

  function imageLineNodes(line: string): MdNode[] | null {
    if (!line.trim().startsWith('![')) return null;
    const nodes = inlineNodes(line.trim());
    if (nodes.some(node => typeof node === 'string' ? Boolean(node.trim()) : !node || typeof node === 'number' || node.tagName.toLowerCase() !== 'img')) return null;
    const images = nodes.filter(node => typeof node !== 'string') as MdNode[];
    return images.length ? images : null;
  }

  function isTableDivider(line: string): boolean {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isBlockStart(lines: string[], index: number): boolean {
    const line = lines[index] || '';
    return /^\s*$/.test(line)
      || /^\s*```/.test(line)
      || /^\s{0,3}#{1,6}\s+/.test(line)
      || /^\s{0,3}>\s?/.test(line)
      || /^\s{0,3}(?:[-+*]|\d+[.)])\s+/.test(line)
      || /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
      || (line.includes('|') && isTableDivider(lines[index + 1] || ''));
  }

  function renderBlocks(lines: string[]): MdNode[] {
    const blocks: MdNode[] = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }

      const images = imageLineNodes(line);
      if (images) {
        index += 1;
        while (index < lines.length) {
          if (!lines[index].trim() && imageLineNodes(lines[index + 1] || '')) { index += 1; continue; }
          const nextImages = imageLineNodes(lines[index]);
          if (!nextImages) break;
          images.push(...nextImages); index += 1;
        }
        blocks.push(h('div', { class: 'mp-chat-image-grid', 'data-count': String(images.length) }, ...images));
        continue;
      }

      const fence = /^\s*```\s*([^\s`]*)\s*$/.exec(line);
      if (fence) {
        const body: string[] = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) body.push(lines[index++]);
        if (index < lines.length) index += 1;
        const lang = fence[1] || '';
        const attrs: Record<string, string> = lang ? { class: `language-${lang}` } : {};
        const card = h('div', { class: 'mp-chat-code' });
        if (lang) card.setAttribute('data-lang', lang);
        const head = h('div', { class: 'mp-chat-code-head' });
        append(head, h('span', { class: 'mp-chat-code-lang' }, lang));
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
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          rows.push(splitTableRow(lines[index++]));
        }
        const thead = h('thead', {}, h('tr', {}, ...headers.map((cell) => h('th', {}, ...inlineNodes(cell)))));
        const tbody = h('tbody', {}, ...rows.map((row) => h('tr', {},
          ...headers.map((_header, cellIndex) => h('td', {}, ...inlineNodes(row[cellIndex] || ''))),
        )));
        blocks.push(h('table', {}, thead, tbody));
        continue;
      }

      const listMatch = /^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(line);
      if (listMatch) {
        const ordered = /^\d/.test(listMatch[1]);
        const list = h(ordered ? 'ol' : 'ul');
        while (index < lines.length) {
          const item = /^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(lines[index]);
          if (!item || /^\d/.test(item[1]) !== ordered) break;
          let content = item[2];
          const li = h('li');
          const task = /^\[([ xX])\]\s+(.+)$/.exec(content);
          if (task) {
            const attrs: Record<string, string> = { type: 'checkbox', disabled: 'true' };
            if (task[1].toLowerCase() === 'x') attrs.checked = 'true';
            append(li, h('input', attrs));
            content = task[2];
          }
          for (const child of inlineNodes(content)) append(li, child);
          append(list, li);
          index += 1;
        }
        blocks.push(list);
        continue;
      }

      const paragraph: string[] = [line.trim()];
      index += 1;
      while (index < lines.length && !isBlockStart(lines, index)) paragraph.push(lines[index++].trim());
      const p = h('p');
      paragraph.forEach((part, partIndex) => {
        if (partIndex) append(p, h('br'));
        for (const child of inlineNodes(part)) append(p, child);
      });
      blocks.push(p);
    }
    return blocks;
  }

  function render(markdown: unknown): MdNode {
    const root = h('div', { class: 'mp-chat-markdown' });
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    for (const block of renderBlocks(lines)) append(root, block);
    return root;
  }

  return { render, __test: { inlineNodes, safeHref, safeImageSource, splitTableRow } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChatMarkdown;
