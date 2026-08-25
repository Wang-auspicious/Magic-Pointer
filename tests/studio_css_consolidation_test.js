'use strict';

/* 四代 CSS 合并的一致性契约:
   1) studio_system.css 必须等于重算结果(--check 等价的进程内断言);
   2) 合并产物的"每作用域 × 每选择器 × 最终声明表"必须与原始 8 文件逐一相等;
   3) studio.html 只加载 studio_system.css + sv.css,且 sv.css 在后。 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildConsolidated, parseCssItems } = require('../scripts/consolidate_studio_css');

const RENDERER = path.resolve(__dirname, '..', 'electron', 'renderer');
const SOURCES = ['oreo_tokens.css', 'oreo.css', 'cards.css', 'dsh_tokens.css', 'dsh_chat.css', 'studio.css', 'dsh_web.css', 'magic_studio.css'];

/* ---- 1) 再生成一致 ---- */
const sources = SOURCES.map((name) => ({ name, text: fs.readFileSync(path.join(RENDERER, name), 'utf8') }));
const regenerated = buildConsolidated(sources);
const committed = fs.readFileSync(path.join(RENDERER, 'studio_system.css'), 'utf8');
assert.strictEqual(regenerated, committed, 'studio_system.css must equal regeneration');

/* ---- 2) 终态等价 ---- */
function flattenEffective(items) {
  // 对样式条目做"最终声明表"提取:同选择器多规则时,按序做属性级 last-wins 投影。
  // 作用域键 = 从根到该层的 @media 参数路径(\u0001 连接)。
  const result = new Map();
  function walk(list, pathKey) {
    const perSelector = new Map();
    const keyframes = new Map();
    for (const item of list) {
      if (item.kind === 'comment') continue;
      if (item.kind === 'at' && item.children) {
        walk(item.children, `${pathKey}\u0001@${item.name} ${item.params}`);
        continue;
      }
      if (item.kind === 'at') {
        if (/keyframes$/.test(item.name)) keyframes.set(`${item.name} ${item.params}`, String(item.body).replace(/\s+/g, ' ').trim());
        else keyframes.set(`@${item.name} ${item.params}`, String(item.body).replace(/\s+/g, ' ').trim());
        continue;
      }
      const selKey = item.selector.replace(/\s+/g, ' ');
      const map = perSelector.get(selKey) || new Map();
      for (const decl of item.decls) map.set(decl.prop, decl.value);
      perSelector.set(selKey, map);
    }
    result.set(pathKey, { perSelector, keyframes });
  }
  walk(items, '');
  return result;
}

const originals = [];
for (const source of sources) originals.push(...parseCssItems(source.text));
const originalFlat = flattenEffective(originals);
const mergedFlat = flattenEffective(parseCssItems(committed));

/* 每个作用域、每个选择器:合并后的最终声明表 == 原始级联投影 */
for (const [scope, { perSelector }] of originalFlat) {
  const mergedScope = mergedFlat.get(scope);
  assert(mergedScope, `scope missing in output: ${scope || '(root)'}`);
  for (const [selKey, projected] of perSelector) {
    const got = mergedScope.perSelector.get(selKey);
    assert(got, `selector missing in output @${scope || 'root'}: ${selKey}`);
    const wantText = [...projected].map(([p, v]) => `${p}:${v}`).sort().join(';');
    const gotText = [...got].map(([p, v]) => `${p}:${v}`).sort().join(';');
    assert.strictEqual(gotText, wantText, `final declaration drift @${scope || 'root'} :: ${selKey}\n  want ${wantText}\n  got  ${gotText}`);
  }
}
for (const [scope] of mergedFlat) {
  assert(originalFlat.has(scope), `output invented a scope: ${scope || '(root)'}`);
}

/* ---- 3) 加载清单收敛 ---- */
const html = fs.readFileSync(path.join(RENDERER, 'studio.html'), 'utf8');
for (const name of SOURCES) {
  assert(!html.includes(`href="${name}`), `studio.html must no longer link ${name}`);
}
assert(html.includes('href="studio_system.css'));
assert(html.includes('href="sv.css'));
assert(html.indexOf('studio_system.css') < html.indexOf('sv.css'), 'sv.css stays last so ports can override tokens');

console.log('studio_css_consolidation ok');
