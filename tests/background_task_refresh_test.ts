import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup() {
  const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
  const ast = ts.createSourceFile(
    'studio.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = [
    'refreshBackgroundAgentTasks',
    'scheduleBackgroundAgentRefresh',
    'childActive',
  ];
  const nodes = ast.statements.filter(
    node =>
      (ts.isFunctionDeclaration(node) &&
        names.includes(node.name?.text || '')) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          value => value.name.getText(ast) === 'backgroundAgentRefreshInFlight',
        )),
  );
  const pending: Array<{id: string; resolve(value: unknown): void}> = [];
  const timers: Array<() => void> = [];
  const snapshots = new Map();
  const context = {
    Map,
    Set,
    activeConversationId: '',
    backgroundAgentSnapshots: snapshots,
    backgroundAgentRefreshTimer: null,
    document: {hidden: false},
    renderProjectTasks() {},
    currentSubagentTasks: () => [{status: 'running'}],
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    Data: {
      subagents: ({conversationId}: {conversationId: string}) =>
        new Promise(resolve => pending.push({id: conversationId, resolve})),
    },
  };
  const code = ts.transpileModule(
    nodes.map(node => node.getText(ast)).join('\n'),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}},
  ).outputText;
  const api = vm.runInNewContext(
    `${code}\n({refresh:refreshBackgroundAgentTasks,schedule:scheduleBackgroundAgentRefresh})`,
    context,
  );
  return {context, api, pending, timers, snapshots};
}

test('switching A to B to A cannot dispatch a second refresh for A or accept an older snapshot last', async () => {
  const {api, pending, snapshots} = setup();
  const a = api.refresh('a');
  const b = api.refresh('b');
  const again = api.refresh('a');
  const dispatched = pending.map(item => item.id);
  pending.forEach((item, index) =>
    item.resolve({ok: true, tasks: [{id: item.id, revision: index}]}),
  );
  await Promise.all([a, b, again]);
  assert.deepEqual(dispatched, ['a', 'b']);
  assert.equal(snapshots.get('a')[0].revision, 0);
});

test('an old conversation request does not suspend polling the active conversation', async () => {
  const {api, context, pending, timers} = setup();
  const old = api.refresh('old');
  context.activeConversationId = 'current';
  api.schedule();
  const scheduled = timers.length;
  pending[0].resolve({ok: true, tasks: []});
  await old;
  assert.equal(scheduled, 1);
});
