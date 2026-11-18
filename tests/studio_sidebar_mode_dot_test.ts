import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const htmlSource = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const themeTokensSource = fs.readFileSync(
  'electron/renderer/theme_tokens.css',
  'utf8',
);
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile(
  'studio.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const node = ast.statements.find(
  entry =>
    ts.isFunctionDeclaration(entry) && entry.name?.text === 'conversationNode',
);
assert.ok(node, 'conversationNode');
const code = ts.transpileModule(node.getText(ast), {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
}).outputText;
const libraryCode = ['conversation_state'].map(
  name =>
    ts.transpileModule(
      fs.readFileSync(`electron/renderer/${name}.ts`, 'utf8'),
      {compilerOptions: {target: ts.ScriptTarget.ES2022}},
    ).outputText,
);

class Element {
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: Element[] = [];
  parentElement: Element | null = null;
  textContent = '';
  title = '';
  constructor(readonly tagName = 'div') {}
  get className() {
    return this.attrs.class || '';
  }
  set className(value: string) {
    this.attrs.class = value;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
    if (name.startsWith('data-')) {
      this.dataset[
        name
          .slice(5)
          .replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())
      ] = value;
    }
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  append(...nodes: Element[]) {
    for (const n of nodes) {
      n.parentElement = this;
      this.children.push(n);
    }
  }
  appendChild(n: Element) {
    this.append(n);
    return n;
  }
  querySelector(selector: string): Element | null {
    const wanted = selector.replace(/^\./, '');
    for (const child of this.children) {
      if (child.className.split(' ').includes(wanted)) {
        return child;
      }
      const hit = child.querySelector(selector);
      if (hit) {
        return hit;
      }
    }
    return null;
  }
  set innerHTML(value: string) {
    this.textContent = value.replace(/<[^>]*>/g, '');
  }
  addEventListener() {}
}

function countMatching(root: Element, predicate: (el: Element) => boolean): number {
  let count = 0;
  for (const child of root.children) {
    if (predicate(child)) {
      count += 1;
    }
    count += countMatching(child, predicate);
  }
  return count;
}

function fixture(overrides: {
  busy?: boolean;
  activeId?: string | null;
  unread?: boolean;
} = {}) {
  const document: any = new Element('document');
  document.createElement = (tag: string) => new Element(tag);
  const context = vm.createContext({
    module: {exports: {}},
    document,
    CdsIcons: {html: () => ''},
    ConversationState: {derive: () => 'idle', label: (s: string) => s},
    studioComposerBusy: overrides.busy ?? false,
    activeConversationId: overrides.activeId ?? null,
    studioT: (id: string) => id,
    icon: () => '',
    studioLibraries: {
      preferences: {sidebar: {metadata: false}},
      sessionUnread: () => Boolean(overrides.unread),
    },
    buildSessionMenu: () => new Element('span'),
  });
  vm.runInContext(libraryCode.join('\n'), context);
  vm.runInContext(code, context);
  return context;
}

test('session rows omit leading .side-dot and keep title + single trailing .side-actions', () => {
  const context = fixture();
  for (const workMode of ['learn', 'work', 'code'] as const) {
    const row = context.conversationNode({
      id: `chat-${workMode}`,
      title: 'Task',
      workMode,
    });
    assert.equal(row.dataset.workMode, workMode);
    assert.equal(
      countMatching(row, el => el.className.split(' ').includes('side-dot')),
      0,
      'must not create any .side-dot element',
    );
    assert.equal(row.children.length, 2, 'row contains only [title, actions]');
    assert.ok(row.children[0].className.split(' ').includes('side-title'));
    assert.ok(row.children[1].className.split(' ').includes('side-actions'));
    assert.ok(row.children[1].querySelector('.side-ellipsis'));
    assert.equal(
      countMatching(
        row.children[1],
        el =>
          el.className.split(' ').includes('status-dot') ||
          el.className.split(' ').includes('side-unread'),
      ),
      0,
      'idle read row renders no status dot in .side-actions',
    );
  }
});

test('sessions without a stored mode default to code', () => {
  const context = fixture();
  const row = context.conversationNode({id: 'legacy', title: 'Old'});
  assert.equal(row.dataset.workMode, 'code');
  assert.equal(row.children.length, 2);
  assert.ok(row.children[0].className.split(' ').includes('side-title'));
});

test('active, awaiting, failed, or unread sessions render at most ONE trailing status dot inside .side-actions', () => {
  const runningRow = fixture({busy: true, activeId: 'run-1'}).conversationNode({
    id: 'run-1',
    title: 'Running',
  });
  assert.equal(runningRow.dataset.status, 'running');
  assert.equal(
    countMatching(
      runningRow,
      el =>
        el.className.split(' ').includes('status-dot') ||
        el.className.split(' ').includes('side-unread'),
    ),
    1,
  );
  assert.ok(runningRow.children[1].querySelector('.status-dot'));
  assert.ok(runningRow.children[1].querySelector('.side-ellipsis'));

  const awaitingRow = fixture({unread: true}).conversationNode({
    id: 'wait-1',
    title: 'Awaiting',
    lastPendingInputKind: 'approval',
  });
  assert.equal(awaitingRow.dataset.status, 'awaiting');
  assert.equal(
    countMatching(
      awaitingRow,
      el =>
        el.className.split(' ').includes('status-dot') ||
        el.className.split(' ').includes('side-unread'),
    ),
    1,
    'awaiting + unread collapses into a single status dot in .side-actions',
  );

  const errorRow = fixture().conversationNode({
    id: 'err-1',
    title: 'Failed',
    failed: true,
    lastFailed: true,
  });
  assert.equal(errorRow.dataset.status, 'error');
  assert.equal(
    countMatching(
      errorRow,
      el =>
        el.className.split(' ').includes('status-dot') ||
        el.className.split(' ').includes('side-unread'),
    ),
    1,
  );

  const unreadRow = fixture({unread: true}).conversationNode({
    id: 'unread-1',
    title: 'Done',
  });
  assert.equal(unreadRow.dataset.status, 'ready');
  assert.equal(
    countMatching(
      unreadRow,
      el =>
        el.className.split(' ').includes('status-dot') ||
        el.className.split(' ').includes('side-unread'),
    ),
    1,
  );
});

test('renderSidebar passes workMode through to conversationNode', () => {
  assert.match(
    source,
    /function conversationNode\(\s*c:\s*\{[^}]*workMode\?:\s*'learn'\s*\|\s*'work'\s*\|\s*'code'/,
  );
});

test('studio.html loads text_saliency & stream_smoother before chat_view/learn_tree/studio and exposes #chat-skim-toggle', () => {
  assert.match(htmlSource, /href="text_saliency\.css(?:\?[^"]*)?"/);
  const smootherIdx = htmlSource.indexOf('stream_smoother.js');
  const saliencyIdx = htmlSource.indexOf('text_saliency.js');
  const chatViewIdx = htmlSource.indexOf('chat_view.js');
  const learnTreeIdx = htmlSource.indexOf('learn_tree.js');
  const studioIdx = htmlSource.indexOf('studio.js');
  assert.ok(smootherIdx > 0, 'stream_smoother.js included');
  assert.ok(saliencyIdx > 0, 'text_saliency.js included');
  assert.ok(smootherIdx < chatViewIdx, 'stream_smoother loads before chat_view');
  assert.ok(saliencyIdx < chatViewIdx, 'text_saliency loads before chat_view');
  assert.ok(saliencyIdx < learnTreeIdx && learnTreeIdx < studioIdx);
  assert.match(
    htmlSource,
    /class="mpw-header-actions"[\s\S]*?id="chat-skim-toggle"/,
  );
});

test('studio.ts wires tickStatus during pending turns and runs TextSaliency.apply after LearnTree.mountConversation', () => {
  assert.match(source, /tickStatus/);
  assert.match(source, /setSelectionPaused/);
  for (const fnName of ['openConversation', 'refreshOpenConversation']) {
    const fnStart = source.indexOf(`function ${fnName}(`);
    assert.ok(fnStart >= 0, `${fnName} exists`);
    const nextFn = source.indexOf('\nfunction ', fnStart + 20);
    const body = source.slice(fnStart, nextFn > fnStart ? nextFn : fnStart + 4000);
    const mountIdx = body.indexOf('LearnTree.mountConversation');
    const saliencyIdx = body.search(/applySkimSaliency|TextSaliency\.apply/);
    assert.ok(mountIdx >= 0, `${fnName} mounts LearnTree`);
    assert.ok(
      saliencyIdx > mountIdx,
      `${fnName} must apply TextSaliency AFTER LearnTree.mountConversation`,
    );
  }
});

test('theme_tokens.css overrides --cds-font-sans at light/dark selector specificity and renderPendingBody avoids pinning elapsedMs', () => {
  assert.match(
    themeTokensSource,
    /:root\[data-theme="light"\][\s\S]*?--cds-font-sans:\s*"anthropic-sans"/,
  );
  assert.match(
    themeTokensSource,
    /:root\[data-theme="dark"\][\s\S]*?--cds-font-sans:\s*"anthropic-sans"/,
  );
  const fnStart = source.indexOf('function renderPendingBody(');
  assert.ok(fnStart >= 0, 'renderPendingBody exists');
  const nextFn = source.indexOf('\nfunction ', fnStart + 20);
  const body = source.slice(fnStart, nextFn > fnStart ? nextFn : fnStart + 2000);
  assert.match(body, /\bstartedAt\b/);
  assert.doesNotMatch(
    body,
    /\belapsedMs\b/,
    'renderPendingBody must not pin elapsedMs between progress events',
  );
});

console.log('studio_sidebar_mode_dot_test done');
