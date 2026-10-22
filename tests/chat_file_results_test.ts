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
      trajectory,
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

test('edited files use the reference edit label instead of claiming creation', () => {
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
  assert.match(html, /mp-chat-files-title">Edited a file</);
});

test('a write receipt distinguishes overwriting an existing file from creating a new one', () => {
  const existing = {
    ...write('existing.ts'),
    result: JSON.stringify({path: 'existing.ts', created: false}),
  };
  assert.match(card([existing]), /mp-chat-files-title">Edited a file</);
  assert.match(
    card([write('new.ts'), existing]),
    /mp-chat-files-title">Edited a file, created a file</,
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
  assert.match(html, /mp-chat-files-title">Created a file</);
  assert.equal((html.match(/data-mp-chat-act="open-file"/g) || []).length, 1);
});
