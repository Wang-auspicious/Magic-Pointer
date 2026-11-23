import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (!node || typeof node !== 'object') {
    return '';
  }
  const anyNode = node as {textContent?: string; children?: unknown[]};
  return (
    (anyNode.textContent || '') +
    (anyNode.children || []).map(collectText).join('')
  );
}

function findNodes(
  root: unknown,
  predicate: (node: Record<string, unknown>) => boolean,
  out: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  if (!root || typeof root !== 'object') {
    return out;
  }
  const rec = root as Record<string, unknown>;
  if (predicate(rec)) {
    out.push(rec);
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      findNodes(child, predicate, out);
    }
  }
  return out;
}

function attrOf(node: Record<string, unknown>, key: string): string {
  const attrs = node.attrs as Record<string, string> | undefined;
  return String(attrs?.[key] || '');
}

test('Phase 3.1: Inspector split pane allows free drag from 300px to 72% viewport with 50/50 default', () => {
  const {clampInspectorWidth} = require(
    '../electron/renderer/studio_inspector_state',
  );
  assert.equal(clampInspectorWidth(300, 1200), 300);
  assert.equal(
    clampInspectorWidth(860, 1400),
    860,
    'Wide drag up to 72% viewport must not be capped at 760px',
  );
  assert.equal(
    clampInspectorWidth(undefined, 1280),
    640,
    'Default split width must be 50/50',
  );
});

test('Phase 3.1-3.2: Side Chat routes to free-resizable full-height right split pane and sidebar projects stay in Main Chat', () => {
  const studioSrc = readRepo('electron/renderer/studio.ts');
  const layoutCss = readRepo('electron/renderer/studio_layout.css');

  assert.doesNotMatch(
    studioSrc,
    /\?\s*'416px'/,
    'Background tasks must not lock inspector width to 416px',
  );
  assert.match(
    studioSrc,
    /resizeHandle\.hidden\s*=\s*false/,
    'Resize handle must stay active whenever inspector is open',
  );
  assert.match(
    studioSrc,
    /openSideChatSurface[\s\S]{0,400}setInspector\(true,\s*'side-chat'\)/,
    'openSideChatSurface must unify all modes into #project-inspector side-chat',
  );
  assert.match(
    studioSrc,
    /const directKey = projectToggle\.dataset\.projectDirectOpen[\s\S]{0,1000}show\('chat'\)/,
    'Clicking a sidebar project must bind the project inside main chat view',
  );
  assert.match(
    layoutCss,
    /\.mp-inspector\s*\{[\s\S]{0,300}margin:\s*0;/,
    'Right split pane must be a flush full-height panel rather than an inset card',
  );
});

test('Phase 3.1: SideChatPane renders图5-style collapsible brief card with Show less/more and back chevron header', () => {
  const created: Array<{
    tagName: string;
    className: string;
    textContent: string;
    hidden: boolean;
    disabled: boolean;
    dataset: Record<string, string>;
    style: Record<string, string>;
    attributes: Record<string, string>;
    children: any[];
    listeners: Record<string, Array<(ev?: any) => void>>;
    setAttribute: (k: string, v: string) => void;
    appendChild: (c: any) => any;
    append: (...items: any[]) => void;
    replaceChildren: (...items: any[]) => void;
    addEventListener: (t: string, cb: (ev?: any) => void) => void;
    click: () => void;
    querySelector: (s: string) => any;
    querySelectorAll: (s: string) => any[];
    rows?: number;
    type?: string;
    placeholder?: string;
    title?: string;
    scrollTop?: number;
    scrollHeight?: number;
    value?: string;
  }> = [];

  function makeEl(tag: string) {
    const el: any = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      hidden: false,
      disabled: false,
      dataset: {},
      style: {},
      attributes: {},
      children: [],
      listeners: {},
      scrollTop: 0,
      scrollHeight: 100,
      setAttribute(k: string, v: string) {
        el.attributes[k] = String(v);
        if (k === 'class') el.className = String(v);
      },
      getAttribute(k: string) {
        return el.attributes[k] ?? null;
      },
      appendChild(c: any) {
        c.parentElement = el;
        el.children.push(c);
        return c;
      },
      append(...items: any[]) {
        for (const item of items) {
          if (typeof item === 'string') {
            const t = makeEl('#TEXT');
            t.textContent = item;
            el.appendChild(t);
          } else {
            el.appendChild(item);
          }
        }
      },
      replaceChildren(...items: any[]) {
        el.children = [];
        el.append(...items);
      },
      addEventListener(t: string, cb: (ev?: any) => void) {
        el.listeners[t] = el.listeners[t] || [];
        el.listeners[t].push(cb);
      },
      click() {
        for (const cb of el.listeners.click || []) {
          cb({type: 'click', target: el, preventDefault() {}, stopPropagation() {}});
        }
      },
      querySelector(s: string) {
        return el.querySelectorAll(s)[0] || null;
      },
      querySelectorAll(s: string) {
        const out: any[] = [];
        const walk = (curr: any) => {
          for (const child of curr.children || []) {
            if (s.startsWith('.') && String(child.className || '').split(/\s+/).includes(s.slice(1))) {
              out.push(child);
            }
            walk(child);
          }
        };
        walk(el);
        return out;
      },
    };
    created.push(el);
    return el;
  }

  const document = {
    documentElement: {lang: 'en', dataset: {theme: 'light'}},
    createElement: (tag: string) => makeEl(tag),
    createTextNode: (t: string) => {
      const n = makeEl('#TEXT');
      n.textContent = t;
      return n;
    },
  };
  const compiled = ts.transpileModule(readRepo('electron/renderer/side_chat_pane.ts'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None},
  }).outputText;
  const ctx: Record<string, unknown> = {
    window: undefined,
    document,
    globalThis: undefined,
    module: {exports: {}},
    console,
    setTimeout,
    clearTimeout,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.runInNewContext(compiled, ctx, {filename: 'side_chat_pane.ts'});

  const SideChatPane = ctx.SideChatPane as any;
  const host = makeEl('div');
  const longQuote = Array.from({length: 12}, (_, i) => `Line ${i + 1}: detail context`).join('\n');
  SideChatPane.openBranch('b1');
  SideChatPane.renderPane(
    host,
    {
      id: 'conv-1',
      branches: [
        {
          id: 'b1',
          title: 'Batch 1: Selection & History',
          parentTurnIndex: 0,
          anchor: {label: 'Batch 1', snippet: longQuote},
          turns: [{question: 'Start', answer: 'Checked **items** cleanly.'}],
        },
      ],
    },
    {
      onSend: async () => {},
      onToggleMount: async () => {},
      onBack: () => {},
    },
  );

  const toggle = host.querySelector('.mp-sidechat-brief-toggle');
  assert.ok(toggle, 'Long brief card must render Show less / Show more toggle');
  const backBtn = host.querySelector('.mp-sidechat-back-btn');
  assert.ok(backBtn, 'SideChatPane header must render < back/title button');
});

test('Phase 4: studio_workflow_panel groups phases + tabular metrics and ChatView renders compact 图6 Workflow card & clickable tasks pill', () => {
  const {groupWorkflowTasks} = require('../electron/renderer/studio_workflow_panel');
  const blocks = groupWorkflowTasks([
    {
      id: 'wf-run12345-chips-a1',
      parentCallId: 'workflow-run1234567890',
      description: '[workflow-step chips] [phase Task4] chips-policy',
      status: 'running',
      stepCount: 3,
      currentTool: 'Read',
      summary: '',
      readonly: true,
      steps: [],
      startedAt: 1000,
      completedAt: 0,
      elapsedMs: 43000,
      modelUsage: {totalTokens: 39500},
    },
    {
      id: 'wf-run12345-cards-a1',
      parentCallId: 'workflow-run1234567890',
      description: '[workflow-step cards] [phase Task4] result-cards',
      status: 'completed',
      stepCount: 8,
      currentTool: '',
      summary: 'Done',
      readonly: true,
      steps: [],
      startedAt: 1050,
      completedAt: 45000,
      elapsedMs: 44000,
      modelUsage: {totalTokens: 54800},
    },
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].steps[0].toolUses, 3);
  assert.equal(blocks[0].steps[0].elapsedMs, 43000);
  assert.ok(Array.isArray(blocks[0].phases) && blocks[0].phases.length >= 1);
  assert.equal(blocks[0].phases[0].title, 'Task4');

  const ChatView = require('../electron/renderer/chat_view');
  const turnStatusNode = ChatView.turnStatusNode as (
    label: string,
    opts: Record<string, unknown>,
  ) => Record<string, unknown>;
  const statusEl = turnStatusNode('Running tools…', {
    meta: '35m 15s · 287.4k tokens',
    tasksText: '1 running task',
  });
  const tasksBtn = findNodes(
    statusEl,
    n => attrOf(n, 'data-mp-chat-act') === 'open-tasks',
  );
  assert.equal(
    tasksBtn.length,
    1,
    'Active running tasks indicator must be clickable to open Background tasks',
  );

  const wfCard = ChatView.__test.workflowCardNode({
    name: 'Workflow.run',
    title: 'Workflow.run',
    summary: '',
    output: JSON.stringify({
      runId: 'run12345',
      title: 'pointerstage-tasks-4-5-6',
      status: 'running',
      elapsedMs: 45000,
      tokens: 150000,
      steps: [
        {id: 's1', title: 's1', status: 'succeeded'},
        {id: 's2', title: 's2', status: 'running'},
        {id: 's3', title: 's3', status: 'pending'},
      ],
    }),
  });
  assert.ok(wfCard);
  assert.equal(attrOf(wfCard, 'data-mp-chat-act'), 'open-workflow');
  const text = collectText(wfCard);
  assert.match(text, /pointerstage-tasks-4-5-6/);
  assert.match(text, /Workflow/);
  assert.ok(findNodes(wfCard, n => String(n.attrs && (n.attrs as Record<string, string>).class || '').includes('mp-wf-square')).length >= 3);
});
