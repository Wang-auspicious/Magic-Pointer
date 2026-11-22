import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

test('W3-Red: chat_tool_summary supports zh-CN localization while keeping en default intact', () => {
  const toolSummary = require('../electron/renderer/chat_tool_summary');
  const calls = [
    {category: 'glob', key: 'g1', canLinkFile: false},
    {category: 'grep', key: 'g2', canLinkFile: false},
    {category: 'bash', key: 'b1', canLinkFile: false},
    {
      category: 'read',
      key: 'src/cds_icons.css',
      filePath: 'src/cds_icons.css',
      canLinkFile: true,
    },
  ];

  const enParts = toolSummary.summarizeToolCalls(calls, 'en');
  assert.equal(
    toolSummary.summaryText(enParts, 'en'),
    'Found files, searched code, ran a command, read cds_icons.css',
  );
  assert.doesNotMatch(toolSummary.summaryText(enParts, 'en'), /[\u4e00-\u9fff]/);

  const zhParts = toolSummary.summarizeToolCalls(calls, 'zh-CN');
  const zhText = toolSummary.summaryText(zhParts, 'zh-CN');
  assert.match(zhText, /查找了|搜索了|运行了|执行了|读取了/);
  assert.doesNotMatch(
    zhText,
    /\b(?:Found|Searched|Ran|Read|more action)\b/i,
    `zh-CN tool group summary must not leak English verbs: "${zhText}"`,
  );
});

test('W3-Red: ChatView strictly separates en and zh-CN tool rows and strips CJK/regex clutter in en mode', () => {
  const ChatView = require('../electron/renderer/chat_view');
  const prevLang = (globalThis as Record<string, unknown>).getStudioLanguage;
  try {
    // Under en: zero CJK leak from model descriptions, clean human search patterns
    (globalThis as Record<string, unknown>).getStudioLanguage = () => 'en';

    const bashCjkDesc = ChatView.toolRowModel(
      'Bash',
      JSON.stringify({description: '列出字体目录', command: 'ls electron/renderer/assets/fonts'}),
      {text: 'done'},
    );
    assert.equal(bashCjkDesc.title, 'Ran');
    assert.doesNotMatch(
      bashCjkDesc.summary,
      /[\u4e00-\u9fff]/,
      'English mode must not leak Chinese bash description into tool row',
    );
    assert.match(bashCjkDesc.summary, /ls electron/);

    const grepCjkDesc = ChatView.toolRowModel(
      'Grep',
      JSON.stringify({description: '找字体文件', pattern: '@font-face|font-family|src:|url\\('}),
      {text: 'done'},
    );
    assert.equal(grepCjkDesc.title, 'Searched');
    assert.doesNotMatch(grepCjkDesc.summary, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(
      grepCjkDesc.summary,
      /\\\(/,
      `Search pattern must clean raw regex escapes, got "${grepCjkDesc.summary}"`,
    );

    // Under zh-CN: 100% Chinese tool titles & running verbs
    (globalThis as Record<string, unknown>).getStudioLanguage = () => 'zh-CN';
    const zhRunningRead = ChatView.toolRowModel('read', JSON.stringify({path: 'renderer/cds_icons.css'}));
    const zhDoneGrep = ChatView.toolRowModel(
      'Grep',
      JSON.stringify({description: '找字体文件', pattern: 'woff2'}),
      {text: 'done'},
    );
    const zhDoneBash = ChatView.toolRowModel(
      'Bash',
      JSON.stringify({description: '列出字体目录', command: 'ls'}),
      {text: 'done'},
    );
    assert.match(zhRunningRead.title, /正在读取/);
    assert.doesNotMatch(zhDoneGrep.title, /^Searched$/i, 'zh-CN grep title must be Chinese');
    assert.doesNotMatch(zhDoneBash.title, /^Ran$/i, 'zh-CN bash title must be Chinese');
    assert.equal(zhDoneGrep.summary, '找字体文件');
    assert.equal(zhDoneBash.summary, '列出字体目录');

    const zhGroupLabel = ChatView.__test.toolGroupLabel([
      {name: 'Grep', argsRaw: JSON.stringify({pattern: 'foo'}), callId: '1', result: {text: 'ok'}},
      {name: 'Bash', argsRaw: JSON.stringify({command: 'ls'}), callId: '2', result: {text: 'ok'}},
    ]) as string;
    assert.doesNotMatch(
      zhGroupLabel,
      /\b(?:Searched|Ran|Read|Found)\b/i,
      `zh-CN group header must not mix English verbs: "${zhGroupLabel}"`,
    );
  } finally {
    (globalThis as Record<string, unknown>).getStudioLanguage = prevLang;
  }
});

test('W3-Red: Claude Desktop muted gray styling applies to both single and nested tool summaries (not black --mp-text)', () => {
  const chatCss = fs.readFileSync(
    path.join(ROOT, 'electron/renderer/chat_styles.css'),
    'utf8',
  );
  assert.doesNotMatch(
    chatCss,
    /\.mp-chat-tool\s*>\s*\.mp-chat-disclosure\s*>\s*\.mp-chat-row\s+\.mp-chat-summary\s*\{\s*color:\s*var\(--mp-text\)\s*;\s*\}/,
    'Nested tool summaries must use muted gray, not high-contrast --mp-text',
  );
  assert.doesNotMatch(
    chatCss,
    /\.mp-chat-tool-group\[data-single='true'\]\s*>\s*\.mp-chat-tool-group-header\s+\.mp-chat-summary\s*\{\s*color:\s*var\(--mp-text\)\s*;\s*\}/,
    'Single tool group summaries must use muted gray, not high-contrast --mp-text',
  );
});
