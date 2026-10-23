import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const chat = require('../electron/renderer/chat_view');

function nodes(root: any, name: string): any[] {
  if (typeof root?.getAttribute !== 'function') return [];
  return [
    ...(root.getAttribute('class')?.split(' ').includes(name) ? [root] : []),
    ...root.children.flatMap((child: any) => nodes(child, name)),
  ];
}

function call(id: string, name = 'Edit') {
  return {
    kind: 'tool',
    callId: id,
    name,
    text: JSON.stringify({
      path: 'src/main.ts',
      old_string: 'old',
      new_string: 'new',
    }),
    result: JSON.stringify({absolutePath: 'D:/origin/src/main.ts'}),
    presentation: {
      kind: 'file_diff',
      beforePath: `D:/snap/${id}-before`,
      afterPath: `D:/snap/${id}-after`,
    },
  };
}

function render(trajectory: any[]) {
  return chat.assistantTurnNode({
    conversationId: 'file-navigation',
    turnIndex: 0,
    answer: 'Saved.',
    request: {executionWorkspaceRoot: 'D:/origin'},
    trajectory,
  })[0];
}

test('single and nested file metadata are actual independent file actions', () => {
  for (const trajectory of [
    [call('one')],
    [call('read', 'Read'), call('one')],
  ]) {
    const root = render(trajectory);
    const links = nodes(root, 'mp-chat-tool-file');
    assert.ok(links.length > 0);
    const link = links.find(node => node.getAttribute('data-file-open-diff'));
    assert.ok(link);
    assert.equal(link.tagName, 'button');
    assert.equal(link.getAttribute('data-mp-chat-act'), 'open-file');
    assert.equal(
      link.getAttribute('data-file-absolute-path'),
      'D:/origin/src/main.ts',
    );
    assert.deepEqual(JSON.parse(link.getAttribute('data-file-open-diff')), {
      beforePath: 'D:/snap/one-before',
      afterPath: 'D:/snap/one-after',
    });
  }
});

test('coalesced file metadata opens the complete saved run without changing individual snapshots', () => {
  const root = render([call('one'), call('two')]);
  const title = nodes(root, 'mp-chat-tool-group-title')[0];
  const link = nodes(title, 'mp-chat-tool-file')[0];
  assert.ok(link);
  assert.deepEqual(JSON.parse(link.getAttribute('data-file-open-diff')), {
    beforePath: 'D:/snap/one-before',
    afterPath: 'D:/snap/two-after',
  });
  const results = nodes(root, 'mp-chat-coalesced-result');
  assert.match(results[0].outerHTML, /one-before/);
  assert.match(results[1].outerHTML, /two-before/);
});

test('Read JSON is content and cannot replace the saved file target', () => {
  const model = chat.toolRowModel(
    'Read',
    JSON.stringify({path: 'config.json'}),
    {
      text: JSON.stringify({absolutePath: 'D:/wrong/secrets.txt'}),
    },
    'read',
    'D:/origin',
  );
  assert.equal(model.fileTarget, 'D:/origin/config.json');
  const row = chat.toolRowNode(model);
  const link = nodes(row, 'mp-chat-tool-file')[0];
  assert.ok(link);
  assert.equal(link.getAttribute('data-file-open-diff'), null);
});

test('pending, failed and missing historical diffs use the actual file instead of another version', () => {
  for (const entry of [
    {...call('pending'), result: undefined, state: 'running'},
    {...call('failed'), result: 'Disk full', isError: true},
    {...call('old'), presentation: undefined},
  ]) {
    const root = render([entry]);
    const link = nodes(
      nodes(root, 'mp-chat-tool-group-title')[0],
      'mp-chat-tool-file',
    )[0];
    assert.ok(link);
    assert.equal(link.getAttribute('data-file-open-diff'), null);
    assert.equal(
      link.getAttribute('data-file-absolute-path'),
      'D:/origin/src/main.ts',
    );
  }
});

test('the settled mixed summary uses the saved edit span and incomplete coalesced history does not invent a span', () => {
  const root = render([call('read', 'Read'), call('one'), call('two')]);
  const link = nodes(root, 'mp-chat-group-file')[0];
  assert.deepEqual(JSON.parse(link.getAttribute('data-file-open-diff')), {
    beforePath: 'D:/snap/one-before',
    afterPath: 'D:/snap/two-after',
  });
  const incomplete = render([
    {...call('one'), presentation: undefined},
    call('two'),
  ]);
  const title = nodes(incomplete, 'mp-chat-tool-group-title')[0];
  assert.equal(
    nodes(title, 'mp-chat-tool-file')[0].getAttribute('data-file-open-diff'),
    null,
  );
});

test('file buttons retain native keyboard activation and do not toggle their parent row', () => {
  const handlers = new Map<string, (event: any) => void>();
  let toggles = 0;
  let prevented = 0;
  const context = vm.createContext({
    DOC: {},
    host: {
      addEventListener: (name: string, listener: any) =>
        handlers.set(name, listener),
    },
    rememberGroupToggle() {},
    toggleDisclosure: () => toggles++,
  });
  vm.runInContext(`(${chat.bindDelegation.toString()})(host)`, context);
  for (const key of ['Enter', ' ']) {
    handlers.get('keydown')!({
      key,
      target: {
        closest: (selector: string) =>
          selector === 'button, a, input, textarea, select'
            ? {}
            : selector.includes('.mp-chat-row')
              ? {dataset: {mpChatAct: 'toggle'}}
              : null,
      },
      preventDefault: () => prevented++,
    });
  }
  assert.equal(toggles, 0);
  assert.equal(prevented, 0);
});
