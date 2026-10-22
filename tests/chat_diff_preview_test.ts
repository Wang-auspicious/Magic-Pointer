import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

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
  result?: {text: string; isError?: boolean},
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
