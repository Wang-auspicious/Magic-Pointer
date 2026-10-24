import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

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

function fixture() {
  const document: any = new Element('document');
  document.createElement = (tag: string) => new Element(tag);
  const context = vm.createContext({
    module: {exports: {}},
    document,
    CdsIcons: {html: () => ''},
    ConversationState: {derive: () => 'idle', label: () => ''},
    studioComposerBusy: false,
    activeConversationId: null,
    studioT: (id: string) => id,
    icon: () => '',
    studioLibraries: {
      preferences: {sidebar: {metadata: false}},
      sessionUnread: () => false,
    },
    buildSessionMenu: () => new Element('span'),
  });
  vm.runInContext(libraryCode.join('\n'), context);
  vm.runInContext(code, context);
  return context;
}

test('session rows carry a leading mode dot colored by workMode', () => {
  const context = fixture();
  for (const workMode of ['work', 'code'] as const) {
    const row = context.conversationNode({
      id: `chat-${workMode}`,
      title: 'Task',
      workMode,
    });
    assert.equal(row.dataset.workMode, workMode);
    const dot = row.children[0];
    assert.equal(dot.className, 'side-dot');
    // The dot leads the row: the title never renders before it.
    const title = row.querySelector('.side-title');
    assert.ok(title, 'side-title present');
    assert.ok(row.children.indexOf(title) > row.children.indexOf(dot));
  }
});

test('sessions without a stored mode default to code', () => {
  const context = fixture();
  const row = context.conversationNode({id: 'legacy', title: 'Old'});
  assert.equal(row.dataset.workMode, 'code');
  assert.ok(row.children[0].className.split(' ').includes('side-dot'));
});

test('renderSidebar passes workMode through to conversationNode', () => {
  // Source-level assertion: the summary type feeding conversationNode in
  // renderSidebar carries workMode (MagicPointerConversationSummary extends
  // MagicPointerConversationInfo which declares it), so the inline parameter
  // type must not drop the field.
  assert.match(
    source,
    /function conversationNode\(\s*c:\s*\{[^}]*workMode\?:\s*'work'\s*\|\s*'code'/,
  );
});

console.log('studio_sidebar_mode_dot_test done');
