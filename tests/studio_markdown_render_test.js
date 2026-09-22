'use strict';

const assert = require('node:assert');
const ChatMarkdown = require('../electron/renderer/chat_markdown');

const html = (value) => value.outerHTML;

const rendered = html(ChatMarkdown.render([
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
assert(rendered.includes('data-lang="pwsh"'), 'fenced code must expose its language on the card');
assert(rendered.includes('mp-chat-code-lang">pwsh</span>'), 'language label must be visible text');
assert(/mp-chat-code-copy[^>]*data-mp-chat-act="copy"/.test(rendered), 'code card must carry the shared copy action');
assert(rendered.includes('data-mp-chat-copy="Get-Process"'), 'copy button must carry the literal code body');
assert(rendered.includes('<code class="language-pwsh">Get-Process</code>'),
  'fenced code must keep its language class and literal body');
assert(rendered.includes('href="https://openai.com"'), 'safe links must remain links');
assert(!rendered.includes('**加粗**'), 'Markdown punctuation must not leak as plain text');

const unsafe = html(ChatMarkdown.render([
  '<img src=x onerror=alert(1)>',
  '',
  '[bad](javascript:alert(1))',
].join('\n')));
assert(!unsafe.includes('<img'), 'raw HTML must be rendered as text, not active markup');
assert(!unsafe.includes('href="javascript:'), 'unsafe URL schemes must never become anchors');
assert(unsafe.includes('&lt;img'), 'raw HTML text must remain visible and escaped');

const quoted = html(ChatMarkdown.render(['```py', 'print("hi")', '```'].join('\n')));
assert(quoted.includes('data-mp-chat-copy="print(&quot;hi&quot;)"'),
  'copy payload must escape double quotes so the attribute stays intact');

const images = html(ChatMarkdown.render([
  '![Source photo](https://example.com/photo.png "Original photo")',
  '',
  '![Local capture](<D:\\Project Files\\capture.png>)',
  '![Inline pixel](data:image/png;base64,aGVsbG8=)',
  '',
  'This is an inline image ![chart](http://localhost:8080/chart.png), with its original source.',
].join('\n')));
assert(images.includes('<img'), 'Markdown images must become actual image nodes');
assert(images.includes('src="https://example.com/photo.png"'), 'remote image sources must be preserved');
assert(images.includes('alt="Source photo"'), 'image alternative text must be preserved');
assert(images.includes('title="Original photo"'), 'image titles must remain metadata');
assert(images.includes('src="file:///D:/Project%20Files/capture.png"'), 'supported local paths with spaces must become file URLs');
assert(images.includes('src="data:image/png;base64,aGVsbG8="'), 'image data URLs must retain their supplied payload');
assert(images.includes('class="mp-chat-image-grid"'), 'consecutive actual images must share a gallery');
assert(images.includes('src="http://localhost:8080/chart.png"'), 'HTTP image URLs must work alongside HTTPS');
assert(!images.includes('</img>'), 'the shim must preserve the image void-element contract');
const unsafeImages = html(ChatMarkdown.render('![bad](javascript:run) ![html](data:text/html;base64,aGVsbG8=)'));
assert(!unsafeImages.includes('<img'), 'non-image executable URL schemes must remain literal text');
assert(html(ChatMarkdown.render('`![literal](https://example.com/a.png)`')).includes('<code>![literal]'), 'inline code must keep image syntax literal');
assert(html(ChatMarkdown.render('![balanced](https://example.com/a(2).png)')).includes('src="https://example.com/a(2).png"'), 'ordinary parenthesized filenames must retain their full source');

console.log('studio markdown render test ok');
