import assert from 'node:assert/strict';
import test from 'node:test';
const chat = require('../electron/renderer/chat_view');
const markdown = require('../electron/renderer/chat_markdown');

test('Markdown images expose the shared viewer action to mouse and keyboard', () => {
  const rendered = markdown.render(
    '![Photo](https://example.test/photo.jpg)',
  ).outerHTML;
  assert(rendered.includes('data-mp-chat-act="view-image"'));
  assert(rendered.includes('tabindex="0"'));
});

test('legacy runtime footers do not duplicate or pollute the final response', () => {
  const final = '核对完成，两处操作已有证据。';
  const rendered = chat
    .assistantTurnNode(
      {
        answer: `${final}\n\n任务尚未全部完成：\nBash 的目标：已执行，待核对`,
        trajectory: [{kind: 'message', text: final}],
      },
      'legacy-audit',
    )
    .map((node: {outerHTML: string}) => node.outerHTML)
    .join('');
  assert.equal(rendered.replace(/<[^>]*>/g, '').split(final).length - 1, 1);
  assert(
    !rendered.includes('Bash 的目标') && !rendered.includes('任务尚未全部完成'),
  );
});

test('specific unfinished work and quoted examples remain visible', () => {
  for (const answer of [
    '任务尚未全部完成：\n尚未保存第二份文件。',
    '```text\n任务尚未全部完成：\nBash 的目标：已执行，待核对\n```',
  ]) {
    const rendered = chat
      .assistantTurnNode({answer})
      .map((node: {outerHTML: string}) => node.outerHTML)
      .join('');
    assert(rendered.includes('任务尚未全部完成'));
  }
});
