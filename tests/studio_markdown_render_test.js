'use strict';

const assert = require('node:assert');
const DshMarkdown = require('../electron/renderer/dsh_markdown');

const html = (value) => value.outerHTML;

const rendered = html(DshMarkdown.render([
  '# 标题',
  '',
  '这是 **加粗**、*斜体*、~~删除~~ 与 `inline()`。',
  '',
  '- 第一项',
  '- [x] 已完成',
  '',
  '> 引用内容',
  '',
  '| 名称 | 状态 |',
  '| --- | --- |',
  '| Markdown | 可用 |',
  '',
  '```pwsh',
  'Get-Process',
  '```',
  '',
  '[OpenAI](https://openai.com)',
].join('\n')));

assert(rendered.includes('<h1>标题</h1>'), 'ATX headings must become structural headings');
assert(rendered.includes('<strong>加粗</strong>'), 'strong emphasis must render');
assert(rendered.includes('<em>斜体</em>'), 'emphasis must render');
assert(rendered.includes('<del>删除</del>'), 'strikethrough must render');
assert(rendered.includes('<code>inline()</code>'), 'inline code must render');
assert(rendered.includes('<ul>'), 'unordered lists must render');
assert(rendered.includes('type="checkbox"'), 'task items must render as disabled checkboxes');
assert(rendered.includes('<blockquote>'), 'block quotes must render');
assert(rendered.includes('<table>'), 'GFM tables must render');
assert(rendered.includes('<pre><code class="language-pwsh">Get-Process</code></pre>'),
  'fenced code must keep its language and literal body');
assert(rendered.includes('href="https://openai.com"'), 'safe links must remain links');
assert(!rendered.includes('**加粗**'), 'Markdown punctuation must not leak as plain text');

const unsafe = html(DshMarkdown.render([
  '<img src=x onerror=alert(1)>',
  '',
  '[bad](javascript:alert(1))',
].join('\n')));
assert(!unsafe.includes('<img'), 'raw HTML must be rendered as text, not active markup');
assert(!unsafe.includes('href="javascript:'), 'unsafe URL schemes must never become anchors');
assert(unsafe.includes('&lt;img'), 'raw HTML text must remain visible and escaped');

console.log('studio markdown render test ok');
