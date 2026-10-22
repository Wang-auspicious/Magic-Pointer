import assert from 'node:assert/strict';
import test from 'node:test';

const chat = require('../electron/renderer/chat_view');

function edit(name = 'Write', callId = 'write') {
  return {
    kind: 'tool',
    name,
    callId,
    text: JSON.stringify({
      path: 'src/main.ts',
      content: 'saved\n',
      old_string: 'old',
      new_string: 'saved',
    }),
    result: JSON.stringify({
      path: 'src/main.ts',
      absolutePath: 'D:/work/src/main.ts',
      created: false,
      diffStat: {added: 1, removed: 1},
      turnDiffStat: {added: 1, removed: 1},
    }),
  };
}

function render(trajectory: any[], artifacts: any[] = []) {
  return chat.assistantTurnNode({
    conversationId: 'footer-visibility',
    answer: 'Saved.',
    artifacts,
    trajectory,
    request: {executionWorkspaceRoot: 'D:/work'},
  })[0].outerHTML as string;
}

const message = {kind: 'message', text: 'Next step.'};
const read = {
  kind: 'tool',
  name: 'Read',
  callId: 'read',
  text: JSON.stringify({path: 'src/main.ts'}),
  result: 'old\n',
};

test('a sole independent edit row omits its duplicate footer and retains its real file opener', () => {
  for (const name of [
    'Write',
    'write_file',
    'write',
    'Edit',
    'edit_file',
    'edit',
  ]) {
    const html = render([edit(name)]);
    assert.match(html, /data-single="true"/, name);
    assert.doesNotMatch(html, /class="mp-chat-files"/, name);
    assert.match(
      html,
      /class="mp-chat-diff-path"[^>]*data-mp-chat-act="open-file"/,
    );
    assert.match(html, /data-file-absolute-path="D:\/work\/src\/main.ts"/);
    assert.match(html, /mp-chat-diff-add">\+1/);
    assert.match(html, /mp-chat-diff-del">−1/);
  }
});

test('an edit inside a mixed or thinking group retains the footer', () => {
  for (const prefix of [read, {kind: 'think', text: 'Considering the edit.'}]) {
    assert.match(render([prefix, edit()]), /class="mp-chat-files"/);
  }
});

test('only contributing edit runs matter, and separate edits to one file still retain the summary', () => {
  assert.doesNotMatch(render([read, message, edit()]), /class="mp-chat-files"/);
  assert.match(
    render([edit(), message, edit('Edit', 'edit')]),
    /class="mp-chat-files"/,
  );
  assert.match(render([edit(), read]), /class="mp-chat-files"/);
});

test('an Artifact keeps its footer alongside a sole independent edit row', () => {
  const html = render(
    [edit()],
    [{artifactId: 'draft', name: 'Draft', path: 'src/main.ts'}],
  );
  assert.match(html, /class="mp-chat-files"/);
  assert.match(html, /data-mp-chat-act="open-artifact"/);
});

test('Patch and Rewind keep file navigation when their independent row has no file path', () => {
  for (const name of ['Patch', 'Rewind']) {
    const html = render([
      {
        kind: 'tool',
        name,
        callId: name,
        text: '{}',
        result: JSON.stringify({
          fileChanges: [
            {
              path: 'src/main.ts',
              absolutePath: 'D:/work/src/main.ts',
              added: 1,
              removed: 1,
            },
          ],
        }),
      },
    ]);
    assert.match(html, /class="mp-chat-files"/, name);
    assert.match(html, /data-file-path="src\/main.ts"/);
  }
});

test('a second run changing the same file prevents suppression even with an unrelated final row', () => {
  const html = render([
    edit(),
    message,
    {
      kind: 'tool',
      name: 'Patch',
      callId: 'patch',
      text: '{}',
      result: JSON.stringify({
        fileChanges: [{path: 'src/main.ts', added: 2, removed: 1}],
      }),
    },
    message,
    read,
  ]);
  assert.match(html, /class="mp-chat-files"/);
});

test('auxiliary records and invalid artifacts do not create a false need for a footer', () => {
  const record = {...edit(), callId: undefined};
  assert.doesNotMatch(
    render([{kind: 'usage', totalTokens: 20}, record]),
    /class="mp-chat-files"/,
  );
  assert.doesNotMatch(render([record], [{}]), /class="mp-chat-files"/);
});

test('undoing and then editing again retains the earlier contributing runs', () => {
  const undone = {
    ...edit('Write', 'undo'),
    result: JSON.stringify({path: 'src/main.ts', unchanged: true}),
  };
  assert.match(
    render([edit(), message, undone, message, edit('Edit', 'again')]),
    /class="mp-chat-files"/,
  );
});
