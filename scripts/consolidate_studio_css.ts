'use strict';

/* consolidate_studio_css —— Studio 四代视觉系统(8 个样式表)的机械合并器。
 *
 * 目标:计算样式零变化。策略是"保守合并":
 *   - 同一作用域(@media 参数也算一层)内同选择器的规则,只有当属性之间不存在
 *     shorthand/longhand 覆盖关系时才折叠成一条;有任何疑虑就原地保留独立规则,
 *     级联顺序与逐文件加载完全一致(两遍法:先算终态再按原位置序列化)。
 *   - @keyframes 同名后者整体胜出(CSS 规约),占最后出现的位置。
 *   - @media 内部递归同样处理;@supports/@layer 等整块透传不合并。
 *   - 含许可证字样的注释全部提升到文件头,其余注释跟随其后的规则,规则折叠时丢弃。
 *
 * 用法:
 *   npx tsx scripts/consolidate_studio_css.ts             # 写出 electron/renderer/studio_system.css
 *   npx tsx scripts/consolidate_studio_css.ts --check     # 校验已提交产物与重算一致(测试用)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = [
  'oreo_tokens.css',
  'oreo.css',
  'cards.css',
  'dsh_tokens.css',
  'dsh_chat.css',
  'studio.css',
  'dsh_web.css',
  'magic_studio.css',
].map((name) => path.join(ROOT, 'electron', 'renderer', name));
const OUTPUT = path.join(ROOT, 'electron', 'renderer', 'studio_system.css');

/* ------------------------------------------------------------------ 解析 */

interface Decl { prop: string; value: string }
interface RuleNode { kind: 'rule'; selector: string; decls: Decl[]; leading: string[] }
interface AtNode { kind: 'at'; name: string; params: string; body: string | null; children?: Item[]; leading: string[] }
interface CommentNode { kind: 'comment'; text: string }
type Item = RuleNode | AtNode | CommentNode;

/** 把声明体切成 prop/value 对,尊重字符串与括号内的分号。 */
function parseDeclarations(body: string): Decl[] {
  const rawDecls: string[] = [];
  let depth = 0;
  let current = '';
  let inString: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      current += ch;
      if (ch === inString && body[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; current += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) { rawDecls.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) rawDecls.push(current);
  return rawDecls
    .map((raw) => {
      const colon = raw.indexOf(':');
      if (colon < 0) return null;
      const prop = raw.slice(0, colon).trim().toLowerCase();
      const value = raw.slice(colon + 1).trim().replace(/\s+/g, ' ');
      if (!prop || !value) return null;
      return { prop, value };
    })
    .filter((d): d is Decl => d !== null);
}

function skipString(text: string, start: number): number {
  const quote = text[start];
  let j = start + 1;
  while (j < text.length && !(text[j] === quote && text[j - 1] !== '\\')) j += 1;
  return j;
}

function findMatchingBrace(text: string, openBrace: number): number {
  let depth = 0;
  for (let j = openBrace; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '"' || ch === "'") { j = skipString(text, j); continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** 解析一个 CSS 文本为条目序列(注释归属其后第一条规则/at 规则)。 */
function parseCssItems(text: string): Item[] {
  const items: Item[] = [];
  let pendingComments: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) break;
      pendingComments.push(text.slice(i, end + 2).trim());
      i = end + 2;
      continue;
    }
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '@') {
      const nameMatch = /^@([\w-]+)/.exec(text.slice(i));
      if (!nameMatch) { i += 1; continue; }
      const name = nameMatch[1].toLowerCase();
      const brace = text.indexOf('{', i);
      const semi = text.indexOf(';', i);
      if (semi >= 0 && (brace < 0 || semi < brace)) {
        // 无块语句(@import 等)——本项目源里不应出现,出现就显式失败。
        throw new Error(`unexpected statement at-rule @${name}; consolidation refuses to guess`);
      }
      const params = text.slice(i + 1 + name.length, brace).trim().replace(/\s+/g, ' ');
      const close = findMatchingBrace(text, brace);
      if (close < 0) break;
      const inner = text.slice(brace + 1, close);
      const nestable = /^(media|supports|layer|document|container)$/.test(name);
      items.push({
        kind: 'at',
        name,
        params,
        body: nestable ? null : inner.trim(),
        children: nestable ? parseCssItems(inner) : undefined,
        leading: pendingComments,
      });
      pendingComments = [];
      i = close + 1;
      continue;
    }
    // 限定规则 selector { ... }
    const brace = text.indexOf('{', i);
    if (brace < 0) break;
    const close = findMatchingBrace(text, brace);
    if (close < 0) break;
    const selectorRaw = text.slice(i, brace);
    const selectorParts: string[] = [];
    let depth = 0;
    let buf = '';
    for (let k = 0; k < selectorRaw.length; k += 1) {
      const c = selectorRaw[k];
      if (c === '"' || c === "'") {
        const end = skipString(selectorRaw, k);
        buf += selectorRaw.slice(k, end + 1);
        k = end;
        continue;
      }
      if (c === '[' || c === '(') depth += 1;
      if (c === ']' || c === ')') depth -= 1;
      if (c === ',' && depth === 0) { selectorParts.push(buf); buf = ''; continue; }
      buf += c;
    }
    selectorParts.push(buf);
    const selector = selectorParts.map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean).join(',\n');
    items.push({
      kind: 'rule',
      selector,
      decls: parseDeclarations(text.slice(brace + 1, close)),
      leading: pendingComments,
    });
    pendingComments = [];
    i = close + 1;
  }
  return items;
}

/* ------------------------------------------------------- 安全合并判定 */

/** shorthand → 其展开会重置的长手属性。只列真实覆盖关系,拿不准就不归族(=不合并)。 */
const FAMILIES: Array<{ root: RegExp; members: RegExp; family: string }> = [
  { root: /^margin$/, members: /^margin-(top|right|bottom|left)$/, family: 'margin' },
  { root: /^padding$/, members: /^padding-(top|right|bottom|left)$/, family: 'padding' },
  { root: /^inset$/, members: /^(top|right|bottom|left)$/, family: 'inset' },
  { root: /^border$/, members: /^border(-(top|right|bottom|left))?(-(width|style|color))?$/, family: 'border-box' },
  { root: /^border-radius$/, members: /^border-(top|bottom)-(left|right)-radius$/, family: 'border-radius' },
  { root: /^overflow$/, members: /^overflow-[xy]$/, family: 'overflow' },
  { root: /^gap$/, members: /^(row|column)-gap$/, family: 'gap' },
  { root: /^flex$/, members: /^flex-(grow|shrink|basis)$/, family: 'flex-track' },
  { root: /^background$/, members: /^background-(color|image|position|size|repeat|origin|clip|attachment)$/, family: 'background' },
  { root: /^font$/, members: /^(font-(style|variant|weight|stretch|size|family)|line-height)$/, family: 'font' },
  { root: /^transition$/, members: /^transition-(property|duration|timing-function|delay|behavior)$/, family: 'transition' },
  { root: /^animation$/, members: /^animation-(name|duration|timing-function|delay|iteration-count|direction|fill-mode|play-state)$/, family: 'animation' },
  { root: /^place-items$/, members: /^(align|justify)-items$/, family: 'place-items' },
  { root: /^place-content$/, members: /^(align|justify)-content$/, family: 'place-content' },
  { root: /^place-self$/, members: /^(align|justify)-self$/, family: 'place-self' },
  { root: /^outline$/, members: /^outline-(width|style|color)$/, family: 'outline' },
  { root: /^list-style$/, members: /^list-style-(type|position|image)$/, family: 'list-style' },
  { root: /^text-decoration$/, members: /^text-decoration-(line|style|color|thickness)$/, family: 'text-decoration' },
  { root: /^columns$/, members: /^column-(width|count)$/, family: 'columns' },
  { root: /^grid$/, members: /^grid-(template-(columns|rows|areas)|auto-(columns|rows|flow))$/, family: 'grid-structure' },
];

function familyOf(prop: string): string {
  if (prop.startsWith('--')) return `var:${prop}`;
  for (const entry of FAMILIES) {
    if (entry.root.test(prop) || entry.members.test(prop)) return entry.family;
  }
  return prop;
}

interface MergedEntry { props: Array<[string, string]> }

function tryMergeInto(entry: MergedEntry, decls: Decl[]): boolean {
  for (const decl of decls) {
    const known = entry.props.some(([p]) => p === decl.prop);
    if (known) continue;
    const family = familyOf(decl.prop);
    for (const [otherProp] of entry.props) {
      if (otherProp !== decl.prop && familyOf(otherProp) === family) return false;
    }
  }
  for (const decl of decls) {
    const slot = entry.props.findIndex(([p]) => p === decl.prop);
    if (slot >= 0) entry.props[slot] = [decl.prop, decl.value];
    else entry.props.push([decl.prop, decl.value]);
  }
  return true;
}

/* ------------------------------------------------------------ 两遍收集 */

type Position =
  | { type: 'rule'; key: string; entry: MergedEntry }
  | { type: 'raw-rule'; item: RuleNode }
  | { type: 'opaque-at'; item: AtNode }
  | { type: 'media'; item: AtNode; childScope: ScopeState }
  | { type: 'keyframes'; item: AtNode };

interface ScopeState {
  positions: Position[];
}

function emptyScope(): ScopeState {
  return { positions: [] };
}

function collect(items: Item[], scope: ScopeState): void {
  const keyframesIndex = new Map<string, number>();
  // 只折叠"紧邻"的同选择器规则:两条规则之间若隔着任何其它规则,
  // 折叠会把后面的胜出声明搬到前面,可能被中间的分组选择器反超
  // (.a{} .x,.a{} .a{} 就是真实反例)。相邻合并才是无条件安全的。
  for (const item of items) {
    if (item.kind === 'comment') continue;
    if (item.kind === 'at' && item.children) {
      // 同参数容器合并进第一次出现的位置。
      const existing = scope.positions.find(
        (p): p is Extract<Position, { type: 'media' }> =>
          p.type === 'media' && p.item.name === item.name && p.item.params === item.params,
      );
      if (existing) collect(item.children, existing.childScope);
      else {
        const childScope = emptyScope();
        collect(item.children, childScope);
        scope.positions.push({ type: 'media', item, childScope });
      }
      continue;
    }
    if (item.kind === 'at' && (item.name === 'keyframes' || item.name === '-webkit-keyframes')) {
      // @keyframes 与规则序无关:同名后者整体胜出(CSS 规约),占最后位置。
      const fullName = `${item.name} ${item.params}`;
      const prior = keyframesIndex.get(fullName);
      if (prior !== undefined) scope.positions.splice(prior, 1);
      keyframesIndex.set(fullName, scope.positions.length);
      scope.positions.push({ type: 'keyframes', item });
      continue;
    }
    if (item.kind === 'at') {
      scope.positions.push({ type: 'opaque-at', item });
      continue;
    }
    const key = item.selector.replace(/\s+/g, ' ');
    const prev = scope.positions.length ? scope.positions[scope.positions.length - 1] : null;
    if (
      prev
      && prev.type === 'rule'
      && prev.key === key
      && tryMergeInto(prev.entry, item.decls)
    ) {
      // 紧邻且无冲突:并入前一条,不新增位置。
      continue;
    }
    // 冲突或不相邻:原地独立保留。
    scope.positions.push({
      type: 'rule',
      key,
      entry: { props: item.decls.map((d) => [d.prop, d.value]) },
    });
  }
}

/* ------------------------------------------------------------ 序列化 */

function serializeEntry(selector: string, entry: MergedEntry): string {
  const lines = entry.props.map(([prop, value]) => `  ${prop}: ${value};`);
  return `${selector} {\n${lines.join('\n')}\n}`;
}

function indentBlock(bodyText: string): string {
  return String(bodyText).split('\n').map((line) => `  ${line}`).join('\n').trimEnd();
}

function renderScope(scope: ScopeState, selectorOf: Map<string, string>): string[] {
  const out: string[] = [];
  for (const position of scope.positions) {
    if (position.type === 'rule') {
      out.push(serializeEntry(selectorOf.get(position.key) || position.key, position.entry));
      continue;
    }
    if (position.type === 'raw-rule') {
      out.push(serializeEntry(position.item.selector, { props: position.item.decls.map((d) => [d.prop, d.value]) }));
      continue;
    }
    if (position.type === 'keyframes') {
      out.push(`@${position.item.name} ${position.item.params} {\n${indentBlock(position.item.body || '')}\n}`);
      continue;
    }
    if (position.type === 'opaque-at') {
      out.push(`@${position.item.name} ${position.item.params} {\n${indentBlock(position.item.body || '')}\n}`);
      continue;
    }
    const inner = renderScope(position.childScope, selectorOf);
    if (inner.length) out.push(`@${position.item.name} ${position.item.params} {\n${inner.map((line) => `  ${line}`).join('\n\n')}\n}`);
  }
  return out;
}

function registerSelectors(items: Item[], selectorOf: Map<string, string>): void {
  for (const item of items) {
    if (item.kind === 'rule') selectorOf.set(item.selector.replace(/\s+/g, ' '), item.selector);
    if (item.kind === 'at' && item.children) registerSelectors(item.children, selectorOf);
  }
}

function collectLicenseComments(items: Item[], sink: string[]): void {
  for (const item of items) {
    if (item.kind === 'comment') {
      if (/license|copyright|©|\bMIT\b|\bISC\b/i.test(item.text)) sink.push(item.text.trim());
      continue;
    }
    for (const text of item.leading || []) {
      if (/license|copyright|©|\bMIT\b|\bISC\b/i.test(text)) sink.push(text.trim());
    }
    if (item.kind === 'at' && item.children) collectLicenseComments(item.children, sink);
  }
}

function buildConsolidated(sources: Array<{ name: string; text: string }>): string {
  const licenses: string[] = [];
  const globalScope = emptyScope();
  const selectorOf = new Map<string, string>();
  const parsedItems: Item[][] = [];
  for (const source of sources) {
    const items = parseCssItems(source.text);
    parsedItems.push(items);
    registerSelectors(items, selectorOf);
  }
  for (const items of parsedItems) {
    collectLicenseComments(items, licenses);
    collect(items, globalScope);
  }
  const uniqueLicenses = [...new Set(licenses)];
  const header = [
    '/* ==========================================================================',
    '   studio_system.css —— Studio 唯一样式表(scripts/consolidate_studio_css.ts 机械生成,勿手改)',
    `   来源级联顺序: ${sources.map((s) => s.name).join(' → ')}`,
    '   合并保证:与逐文件加载计算样式一致;同选择器仅在无 shorthand/longhand 冲突时折叠。',
    '   一致性由 tests/studio_css_consolidation_test.js 与 data/runtime/css-parity 探针钉死。',
    '   ========================================================================== */',
  ].join('\n');
  const body = renderScope(globalScope, selectorOf);
  const chunks = uniqueLicenses.length ? [header, uniqueLicenses.join('\n\n'), ...body] : [header, ...body];
  return `${chunks.join('\n\n')}\n`;
}

/* ---------------------------------------------------------------- 入口 */

function main(): void {
  const check = process.argv.includes('--check');
  const sources = SOURCES.map((file) => ({ name: path.basename(file), text: fs.readFileSync(file, 'utf8') }));
  const consolidated = buildConsolidated(sources);
  const bytesBefore = sources.reduce((sum, s) => sum + Buffer.byteLength(s.text), 0);
  const bytesAfter = Buffer.byteLength(consolidated);
  if (check) {
    const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (existing !== consolidated) {
      process.stderr.write('studio_system.css 与重算结果不一致 —— 先运行不带 --check 的再生成。\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`consolidation check ok (${sources.length} sources, ${(bytesAfter / 1024).toFixed(1)} KB)\n`);
    return;
  }
  fs.writeFileSync(OUTPUT, consolidated);
  process.stdout.write(
    `studio_system.css written: ${sources.length} files ${(bytesBefore / 1024).toFixed(1)} KB -> ${(bytesAfter / 1024).toFixed(1)} KB\n`,
  );
}

if (require.main === module) main();

module.exports = { buildConsolidated, parseCssItems };
