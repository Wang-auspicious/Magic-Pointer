import assert from 'node:assert/strict';
import test from 'node:test';

const chat = require('../electron/renderer/chat_view');

function write(path: string) {
  return {
    kind: 'tool',
    name: 'Write',
    text: JSON.stringify({path, content: 'export const value = 1;\n'}),
    result: JSON.stringify({path, message: 'Wrote 24 bytes'}),
  };
}

function card(trajectory: unknown[], artifacts: unknown[] = []): string {
  const rendered = chat
    .assistantTurnNode({
      answer: 'Saved.',
      trajectory: [
        {kind: 'tool', name: 'Read', text: '{}', result: 'Read context.'},
        ...trajectory,
      ],
      artifacts,
      conversationId: 'files',
    })
    .map((node: {outerHTML: string}) => node.outerHTML)
    .join('');
  return rendered.slice(rendered.indexOf('<div class="mp-chat-files">'));
}

test('a draft title cannot hide unrelated files sharing its basename', () => {
  const html = card(
    [write('client/index.ts'), write('server/index.ts')],
    [{artifactId: 'draft', name: 'index.ts'}],
  );
  assert.match(html, /data-file-path="client\/index.ts"/);
  assert.match(html, /data-file-path="server\/index.ts"/);
  assert.match(
    html,
    /class="mp-chat-file-row"[^>]*data-mp-chat-act="open-artifact"/,
  );
});

test('an artifact with the same explicit file path replaces only that file row', () => {
  const html = card(
    [write('client/index.ts'), write('server/index.ts')],
    [{artifactId: 'draft', name: 'index.ts', path: 'client/index.ts'}],
  );
  assert.doesNotMatch(html, /data-file-path="client\/index.ts"/);
  assert.match(html, /data-file-path="server\/index.ts"/);
  assert.match(
    html,
    /class="mp-chat-file-row"[^>]*data-mp-chat-act="open-artifact"/,
  );
});

test('different path separators identify one written file and keep its actual open target', () => {
  const html = card([write('client\\index.ts'), write('client/index.ts')]);
  assert.equal((html.match(/data-mp-chat-act="open-file"/g) || []).length, 1);
  assert.match(html, /data-file-path="client\/index.ts"/);
  assert.doesNotMatch(html, /Show 1 more file/);
});

test('failed or unfinished writes cannot create delivered file rows', () => {
  const html = card([
    {...write('failed.ts'), isError: true},
    {...write('pending.ts'), result: undefined},
    write('saved.ts'),
  ]);
  assert.match(html, /data-file-path="saved.ts"/);
  assert.doesNotMatch(html, /data-file-path="(?:failed|pending)\.ts"/);
});

test('a single file keeps its actual edit operation without an extra footer header', () => {
  const html = card([
    {
      kind: 'tool',
      name: 'Edit',
      text: JSON.stringify({
        path: 'index.ts',
        old_string: 'old',
        new_string: 'new',
      }),
      result: 'done',
    },
  ]);
  assert.match(html, /data-file-change="edited"/);
  assert.doesNotMatch(html, /mp-chat-files-head/);
});

test('a write receipt distinguishes overwriting an existing file from creating a new one', () => {
  const existing = {
    ...write('existing.ts'),
    result: JSON.stringify({path: 'existing.ts', created: false}),
  };
  assert.match(card([existing]), /data-file-change="edited"/);
  assert.match(
    card([write('new.ts'), existing]),
    /mp-chat-files-title">Edited 2 files</,
  );
});

test('a file created and then edited in one turn is counted once as a created file', () => {
  const html = card([
    write('index.ts'),
    {
      kind: 'tool',
      name: 'Edit',
      text: JSON.stringify({
        path: 'index.ts',
        old_string: '1',
        new_string: '2',
      }),
      result: 'done',
    },
  ]);
  assert.match(html, /data-file-change="created"/);
  assert.doesNotMatch(html, /mp-chat-files-head/);
  assert.equal((html.match(/data-mp-chat-act="open-file"/g) || []).length, 1);
});

test('an artifact path keeps the actual file net statistics and an unknown statistic stays hidden', () => {
  const html = card(
    [
      {
        ...write('index.ts'),
        result: JSON.stringify({
          created: false,
          diffStat: {added: 1, removed: 1},
          turnDiffStat: {added: 3, removed: 2},
        }),
      },
    ],
    [{artifactId: 'draft', name: 'index.ts', path: 'index.ts', added: 999}],
  );
  assert.match(html, /mp-chat-diff-add">\+3</);
  assert.match(html, /mp-chat-diff-del">−2</);
  assert.doesNotMatch(html, /\+999/);
  const unknown = card([
    {
      ...write('large.ts'),
      result: JSON.stringify({
        created: false,
        diffStat: null,
        turnDiffStat: null,
      }),
    },
  ]);
  assert.doesNotMatch(unknown, /mp-chat-diff-(?:add|del)/);
  assert.equal(
    chat.toolRowModel(
      'Write',
      JSON.stringify({path: 'large.ts', content: 'one\ntwo\n'}),
      {text: JSON.stringify({diffStat: null})},
    ).diffStat,
    null,
  );
});

test('legacy file records without a known turn baseline do not invent net statistics', () => {
  assert.doesNotMatch(card([write('legacy.ts')]), /mp-chat-diff-(?:add|del)/);
});
