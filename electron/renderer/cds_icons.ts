'use strict';


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
  unpin: 0xe0bf,
  box: 0xe020,
  trash: 0xe101,
  'arrow-down': 0xe009,
  'arrow-out': 0xe00e,
  archive: 0xe008,
  'view-all': 0xe015,
  'group-sort': 0xe070,
  sort: 0xe0e3,
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
  'code-send': 0xe00f,
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
  home: 0xe08a,
  'layout-list': 0xe09c,
  'layout-grid': 0xe084,
  calendar: 0xe024,
  document: 0xe06c,
  folder: 0xe072,
  'more-horizontal': 0xe061,
  settings: 0xe0d6,
  laptop: 0xe093,
  sunrise: 0xe0f0,
  mailbox: 0xe0a5,
  checklist: 0xe03f,
  lightbulb: 0xe097,
  binoculars: 0xe01c,
  user: 0xe104,
  slides: 0xe0e2,
  image: 0xe08c,
  help: 0xe088,
  globe: 0xe082,
  info: 0xe08f,
  scroll: 0xe0d2,
  keyboard: 0xe092,
  chart: 0xe02f,
});

const SIZES: readonly string[] = Object.freeze(['large', 'small', 'micro']);
const ANIMATION_AXES: Readonly<Record<string, string>> = Object.freeze({
  artifacts: 'ANIM', customize: 'ANIM', projects: 'ANIM', design: 'ANIM',
  'attach-design': 'ANIM', code: 'ANIM ANM2', lightbulb: 'ANIM',
});

function codepoint(name: unknown): number | null {
  if (typeof name !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(GLYPHS, name)) return null;
  const value = GLYPHS[name];
  return typeof value === 'number' ? value : null;
}

function html(name: unknown, size: unknown = 'large'): string {
  const value = codepoint(name);
  if (value === null) return '';
  const resolved = SIZES.includes(size as string) ? (size as string) : 'large';
  const axes = typeof name === 'string' ? ANIMATION_AXES[name] : '';
  return `<span class="cds-icon" data-size="${resolved}"${axes ? ` data-cds-anim="${axes}"` : ''} aria-hidden="true" data-glyph="&#x${value.toString(16).toUpperCase()};"></span>`;
}

function names(): string[] {
  return Object.keys(GLYPHS).sort();
}

const CdsIcons = { GLYPHS, codepoint, html, names };
if (typeof module !== 'undefined' && module.exports) module.exports = CdsIcons;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { CdsIcons?: typeof CdsIcons }).CdsIcons = CdsIcons;
}
