import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {lineChangeStat} from '../electron/line_change_stat';

const chat = require('../electron/renderer/chat_view');

test('later shared IO rules do not override the reference diff typography', () => {
  const styles = fs
    .readFileSync(
      path.join(__dirname, '../electron/renderer/chat_styles.css'),
      'utf8',
    )
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = new Map<string, string>();
  // These are the flat, equal-specificity class rules for this element. Keep
  // source order so an earlier correct declaration cannot mask a later reset.
  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].split(',').some(selector => selector.trim() === '.mp-chat-diff')) {
      continue;
    }
    for (const declaration of match[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon !== -1) {
        declarations.set(
          declaration.slice(0, colon).trim(),
          declaration.slice(colon + 1).trim(),
        );
      }
    }
  }
  assert.equal(
    declarations.get('font-family'),
    'var(--cds-font-mono, var(--mp-font-mono))',
  );
  assert.equal(declarations.get('font-size'), 'var(--cds-font-size-code, 12px)');
  assert.equal(declarations.get('line-height'), 'var(--cds-leading-code, 17px)');
});

function row(
  name: string,
  args: Record<string, unknown>,
  result?: {text: string; isError?: boolean; interrupted?: boolean},
) {
  return chat.toolRowNode(chat.toolRowModel(name, JSON.stringify(args), result))
    .outerHTML as string;
}

test('an edit preview retains both sides and the tail beyond forty removed lines', () => {
  const oldText = Array.from({length: 120}, (_, i) => `old ${i}`).join('\n');
  const html = row('Edit', {
    path: 'file.txt',
    old_string: oldText,
    new_string: 'actual new tail',
  });
  assert.ok(html.includes('- old 119'));
  assert.ok(html.includes('+ actual new tail'));
  assert.doesNotMatch(html, /mp-chat-diff-more/);
});

test('a blank-line-heavy write stays complete with a bounded number of rendered nodes', () => {
  const html = row('Write', {
    path: 'file.txt',
    content: 'start\n' + '\n'.repeat(12000) + 'end',
  });
  assert.ok(html.includes('+ end'));
  assert.ok((html.match(/class="mp-chat-diff-line"/g) || []).length <= 2);
  assert.match(html, /class="mp-chat-diff"[^>]*tabindex="0"[^>]*role="group"/);
});

test('batch edits preview each supplied replacement without discarding later edits', () => {
  const html = row('Edit', {
    path: 'file.txt',
    edits: [
      {old_string: 'first old', new_string: 'first new'},
      {old_string: 'second old', new_string: 'second new'},
    ],
  });
  for (const text of [
    '- first old',
    '+ first new',
    '- second old',
    '+ second new',
  ]) {
    assert.ok(html.includes(text), text);
  }
});

test('a failed edit keeps its error instead of rendering the requested changes as completed content', () => {
  const html = row(
    'Edit',
    {path: 'file.txt', old_string: 'original', new_string: 'unapplied'},
    {text: 'Read file.txt before editing it', isError: true},
  );
  assert.ok(html.includes('Read file.txt before editing it'));
  assert.doesNotMatch(html, /class="mp-chat-diff"/);
  assert.doesNotMatch(html, /class="mp-chat-diff-stat"/);
});

test('retained edit lines render once as neutral context', () => {
  const args = {
    path: 'file.txt',
    old_string: 'first\nold\nmiddle\nlast\n',
    new_string: 'first\nnew\nmiddle\nlast\n',
  };
  const view = chat.__test.deriveDiff('Edit', JSON.stringify(args));
  assert.deepEqual(view.blocks, [
    {kind: 'context', text: 'first\n'},
    {kind: 'del', text: 'old\n'},
    {kind: 'add', text: 'new\n'},
    {kind: 'context', text: 'middle\nlast\n'},
  ]);
  const html = row('Edit', args);
  assert.match(html, /data-kind="context"> {2}first/);
  assert.doesNotMatch(html, /[-+] first|[-+] middle|[-+] last/);
  assert.deepEqual(
    chat.toolRowModel('Edit', JSON.stringify(args)).diffStat,
    {added: 1, removed: 1},
  );
});

test('CRLF and interior context preserve both complete sides', () => {
  const view = chat.__test.deriveDiff(
    'Edit',
    JSON.stringify({
      path: 'file.txt',
      old_string: 'old first\r\nshared\r\nold last\r\n',
      new_string: 'new first\nshared\nnew last\n',
    }),
  );
  assert.deepEqual(view.blocks, [
    {kind: 'del', text: 'old first\n'},
    {kind: 'add', text: 'new first\n'},
    {kind: 'context', text: 'shared\n'},
    {kind: 'del', text: 'old last\n'},
    {kind: 'add', text: 'new last\n'},
  ]);
});

test('costly comparisons retain both full texts with a notice', () => {
  const lines = Array.from({length: 700}, (_, i) => `unique ${i}\n`);
  const args = {
    path: 'file.txt',
    old_string: lines.join(''),
    new_string: [...lines].reverse().join(''),
  };
  const view = chat.__test.deriveDiff('Edit', JSON.stringify(args));
  assert.equal(view.blocks[0].kind, 'notice');
  assert.equal(view.blocks[1].text, args.old_string);
  assert.equal(view.blocks[2].text, args.new_string);
  const html = row('Edit', args);
  assert.match(html, /mp-chat-diff-notice/);
  assert.ok(html.includes('− unique 699'));
  assert.ok(html.includes('+ unique 0'));
  assert.equal((html.match(/mp-chat-diff-side/g) || []).length, 2);
  assert.match(html, /role="group" aria-label="Removed text"/);
  assert.match(html, /role="group" aria-label="Added text"/);
  assert.equal(chat.toolRowModel('Edit', JSON.stringify(args)).diffStat, null);
});

test('duplicate and empty lines reconstruct shortest changes', () => {
  const values = ['', '\n', 'A', 'A\nB', 'A\nA\n', 'B\nA\n', 'A\nB\nA\n'];
  for (const before of values) {
    for (const after of values) {
      const blocks: Array<{kind: string; text: string}> =
        chat.__test.deriveDiff(
          'Edit',
          JSON.stringify({
            path: 'file.txt',
            old_string: before,
            new_string: after,
          }),
        )?.blocks || [];
      const reconstruct = (side: string) =>
        blocks
          .filter(block => block.kind === side || block.kind === 'context')
          .map(block => block.text)
          .join('');
      assert.equal(reconstruct('del'), before);
      assert.equal(reconstruct('add'), after);
      const changedLines = (side: string) =>
        blocks
          .filter(block => block.kind === side)
          .reduce(
            (count, block) =>
              count + (block.text.match(/[^\n]*\n|[^\n]+$/g)?.length || 0),
            0,
          );
      assert.deepEqual(
        {added: changedLines('add'), removed: changedLines('del')},
        lineChangeStat(before, after),
      );
    }
  }
});

test('a successful file preview does not append raw receipt fields', () => {
  for (const [name, args] of [
    ['Write', {path: 'file.txt', content: 'written content\n'}],
    ['Edit', {path: 'file.txt', old_string: 'old', new_string: 'new'}],
  ] as const) {
    const result = {
      text: JSON.stringify({
        path: 'file.txt',
        absolutePath: 'D:/project/file.txt',
        checkpointId: 'internal-checkpoint',
        diffStat: {added: 1, removed: name === 'Edit' ? 1 : 0},
      }),
    };
    const model = chat.toolRowModel(name, JSON.stringify(args), result);
    assert.ok(model.output.includes('internal-checkpoint'));
    const html = chat.toolRowNode(model).outerHTML;
    assert.match(html, /class="mp-chat-diff"/);
    assert.doesNotMatch(html, /mp-chat-tool-output|internal-checkpoint|absolutePath/);
    assert.match(html, /mp-chat-diff-add">\+1/);
  }
});

test('stopped and failed edits retain their actual result details', () => {
  const args = {path: 'file.txt', old_string: 'old', new_string: 'new'};
  for (const result of [
    {text: 'Interrupted before applying the edit', interrupted: true},
    {text: 'Permission denied writing file.txt', isError: true},
  ]) {
    assert.ok(row('Edit', args, result).includes(result.text));
  }
});
