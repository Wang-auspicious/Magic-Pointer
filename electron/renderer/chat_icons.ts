/* exported ChatIcons */

const ChatIcons = (() => {
  interface ShimNode {
    tagName: string;
    attrs: Record<string, string>;
    children: ShimNode[];
    setAttribute(key: string, value: string): void;
    appendChild(child: ShimNode): unknown;
    readonly outerHTML: string;
  }
  type IconNode = Element | ShimNode;

  const DOC = typeof document !== 'undefined' ? document : null;
  const ESC: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  };

  function shim(tag: string): ShimNode {
    const value: ShimNode = {
      tagName: tag,
      attrs: {},
      children: [],
      setAttribute(key, attr) {
        value.attrs[key] = String(attr);
      },
      appendChild(child) {
        value.children.push(child);
        return child;
      },
      get outerHTML() {
        const attrs = Object.entries(value.attrs)
          .map(
            ([key, attr]) =>
              ` ${key}="${attr.replace(/[&<>"]/g, char => ESC[char])}"`,
          )
          .join('');
        return `<${tag}${attrs}>${value.children.map(child => child.outerHTML).join('')}</${tag}>`;
      },
    };
    return value;
  }

  /**
   * Claude Desktop 4.23118 Anthropicons-Variable Unicode codepoints.
   * Keep in sync with `electron/renderer/cds_icons.ts`.
   */
  const GLYPHS: Readonly<Record<string, number>> = {
    copy: 0xe056, // Copy
    check: 0xe03b, // Check
    edit: 0xe064, // Edit
    branch: 0xe078, // GitBranch
    retry: 0xe11d, // ArrowClockwise
    chev: 0xe027, // CaretDown
    search: 0xe0d3, // Search
    send: 0xe013, // ArrowUp
    return: 0xe00f, // ArrowReturn
    think: 0xe068, // ExtendedThinking
    browse: 0xe01f, // BookText
    code: 0xe048, // Code
    api: 0xe051, // CommandLinePrompt
    sparkle: 0xe018, // Atom
  };

  function opticalSpec(size: number): {
    dataSize: 'xs' | 'sm' | 'md';
    opsz: number;
    wght: number;
  } {
    if (size <= 12) {
      return {dataSize: 'xs', opsz: 12, wght: 577.8};
    }
    if (size <= 16) {
      return {dataSize: 'sm', opsz: 16, wght: 533.3};
    }
    return {dataSize: 'md', opsz: 20, wght: 433.3};
  }

  function node(name: string, size = 16): IconNode {
    const code = GLYPHS[name] ?? GLYPHS.sparkle;
    const px = Number.isFinite(size) && size > 0 ? size : 16;
    const {dataSize, opsz, wght} = opticalSpec(px);
    const el = DOC ? DOC.createElement('span') : shim('span');
    el.setAttribute('class', 'cds-icon');
    el.setAttribute('data-size', dataSize);
    el.setAttribute('data-icon', name);
    el.setAttribute('data-glyph', String.fromCodePoint(code));
    el.setAttribute(
      'style',
      `font-size:${px}px;--cds-opsz:${opsz};--cds-wght:${wght};`,
    );
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  return {node};
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChatIcons;
}
