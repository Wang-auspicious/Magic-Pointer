'use strict';

/* Anthropicons 的码位表。Claude 的界面图标是可变字体的字形，没有 SVG 可抄，
   所以认一个图标只能靠码位。表是从 参考claude设计/scraped/icons/manifest.json
   的 icons[] 里逐条抄下来的，只收 kind:"font" 的条目：svg / svg-decorative-skipped
   那几条是一次性插画，字体里根本没有对应字形，收进来会让调用方拿到一个
   渲染成豆腐块的名字。
   new-chat 与 attach 同为 U+E001 不是笔误：Claude 里新建对话和添加文件
   本来就是同一个字形，两个名字都有人用，所以留两个键。
   三个字号档位的字重（large 433.3 / small 533.3 / micro 577.8）属于 CSS 的
   事——码位不随字号变，这里就不带尺寸信息。 */

const GLYPHS: Readonly<Record<string, number>> = Object.freeze({
  'sidebar-panel': 0xe0dd,
  scheduled: 0xe043,
  design: 0xe0b8,
  'new-chat': 0xe001,
  projects: 0xe0c9,
  artifacts: 0xe017,
  code: 0xe048,
  customize: 0xe100,
  'chevron-section': 0xe02a,
  'pinned-star': 0xe0bd,
  'view-all': 0xe015,
  'group-sort': 0xe070,
  'import-memory': 0xe0a8,
  dismiss: 0xe10f,
  'customize-suggestion': 0xe086,
  'row-more': 0xe062,
  'account-chevron': 0xe027,
  'get-apps': 0xe063,
  search: 0xe0d3,
  notice: 0xe08f,
  attach: 0xe001,
  'composer-aux1': 0xe037,
  'composer-aux2': 0xe0f1,
  send: 0xe013,
  dictate: 0xe0ab,
  'mode-write': 0xe064,
  'mode-learn': 0xe083,
  'mode-life': 0xe04c,
  'mode-auto': 0xe097,
  check: 0xe03b,
  external: 0xe08f,
  'attach-file': 0xe019,
  'attach-screenshot': 0xe025,
  'attach-skills': 0xe0d2,
  'attach-connector': 0xe055,
  'attach-design': 0xe0b8,
  'attach-plugins': 0xe0c5,
  'attach-websearch': 0xe082,
});

const SIZES: readonly string[] = Object.freeze(['large', 'small', 'micro']);

// 名字来自调用方，可能是任意输入：逐层退让到 null / 'large'，
// 好过让一个拼错的图标名在渲染中途抛异常、把整块界面带走。
function codepoint(name: unknown): number | null {
  if (typeof name !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(GLYPHS, name)) return null;
  const value = GLYPHS[name];
  return typeof value === 'number' ? value : null;
}

// 码位写成数字实体而不是原字符：源文件里放 PUA 私用区字符，
// 编辑器、diff、lint 和任何一次复制粘贴都会把它吃掉或替换掉。
function html(name: unknown, size: unknown = 'large'): string {
  const value = codepoint(name);
  if (value === null) return '';
  const resolved = SIZES.includes(size as string) ? (size as string) : 'large';
  // 字形挂在 data-glyph 上、由 CSS 的 ::before 取出，而不是当文本节点放进去。
  // 文本节点会进 textContent：菜单行的可读文本会变成长度含一个私有区字符的
  // 「No folder」，按文本找行的代码和读屏都会跟着错。生成内容不计入
  // textContent，所以用它承载装饰。
  return `<span class="cds-icon" data-size="${resolved}" aria-hidden="true" data-glyph="&#x${value.toString(16).toUpperCase()};"></span>`;
}

function names(): string[] {
  return Object.keys(GLYPHS).sort();
}

const CdsIcons = { GLYPHS, codepoint, html, names };
if (typeof module !== 'undefined' && module.exports) module.exports = CdsIcons;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { CdsIcons?: typeof CdsIcons }).CdsIcons = CdsIcons;
}
