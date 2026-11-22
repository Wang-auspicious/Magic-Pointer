import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function findNodes(
  root: any,
  predicate: (node: any) => boolean,
  out: any[] = [],
): any[] {
  if (!root || typeof root !== 'object') {
    return out;
  }
  if (predicate(root)) {
    out.push(root);
  }
  const children = Array.isArray(root.childNodes)
    ? root.childNodes
    : Array.isArray(root.children)
      ? root.children
      : [];
  for (const child of children) {
    findNodes(child, predicate, out);
  }
  return out;
}

function nodeText(root: any): string {
  if (typeof root === 'string' || typeof root === 'number') {
    return String(root);
  }
  if (!root || typeof root !== 'object') {
    return '';
  }
  if (typeof root.textContent === 'string' && root.textContent) {
    return root.textContent;
  }
  const children = Array.isArray(root.childNodes)
    ? root.childNodes
    : Array.isArray(root.children)
      ? root.children
      : [];
  return children.map(nodeText).join('');
}

const isTag = (n: any, name: string) =>
  String(n?.tagName || '').toUpperCase() === name.toUpperCase();

const attrOf = (n: any, key: string): string | null => {
  if (typeof n?.getAttribute === 'function') {
    return n.getAttribute(key);
  }
  if (n?.attrs && Object.prototype.hasOwnProperty.call(n.attrs, key)) {
    return String(n.attrs[key]);
  }
  return null;
};

test('W5-Red: learn_voice.ts embeds /paper-xray 5 thinking dimensions, diagram palette, and Artifact.create guidance', () => {
  const {
    CORE_LEARN_SYSTEM,
    buildLearnVoicePrompt,
  } = require('../electron/runtime/learn_voice');

  assert.match(CORE_LEARN_SYSTEM, /瓶颈|为什么必须这么设计|why/i);
  assert.match(CORE_LEARN_SYSTEM, /手算小例子|具体小例子/);
  assert.match(CORE_LEARN_SYSTEM, /会踩什么坑|失效|diagnostic|排查/i);
  assert.match(CORE_LEARN_SYSTEM, /已证明|推断|怀疑/);
  for (const token of ['--in', '--out', '--op', '--norm', '--loss', '--alt', '--param', '--wire']) {
    assert.ok(
      CORE_LEARN_SYSTEM.includes(token),
      `CORE_LEARN_SYSTEM must specify /paper-xray semantic diagram token ${token}`,
    );
  }
  assert.match(CORE_LEARN_SYSTEM, /one-figure-one-idea|一图一义/);
  assert.match(CORE_LEARN_SYSTEM, /Artifact\.create/);
  assert.match(CORE_LEARN_SYSTEM, /artifact:/);

  const built = buildLearnVoicePrompt({
    topicText: '帮我精读 Attention Is All You Need 这篇论文并画张架构图',
    hasSelection: false,
    localDate: '2026-11-20',
    platform: 'win32',
  });
  assert.match(built, /--in/);
  assert.match(built, /Artifact\.create/);
});

test('W5-Red: artifacts.ts & agent_services.ts support multi-type artifacts (markdown/html/svg/code/diagram/csv) with language & filename', async () => {
  const {ToolRegistry} = require('../electron/runtime/tools');
  const {
    registerArtifactTools,
    projectArtifacts,
    latestTurnArtifactSummaries,
  } = require('../electron/runtime/artifacts');
  const {initialToolNames} = require('../electron/runtime/agent_services');

  const learnTools = initialToolNames({workMode: 'learn', workspace: ''});
  for (const required of ['Artifact.create', 'Artifact.read', 'Artifact.update']) {
    assert.ok(
      learnTools.includes(required),
      `learn initialToolNames must include ${required}`,
    );
  }
  const codeTools = initialToolNames({workMode: 'code', workspace: os.tmpdir()});
  for (const required of ['Artifact.create', 'Artifact.read', 'Artifact.update']) {
    assert.ok(
      codeTools.includes(required),
      `code initialToolNames must include ${required}`,
    );
  }

  const events: Array<{type: string; seq: number; data: Record<string, any>}> = [];
  const session = {
    id: 'art-test-session',
    events,
    async append(type: string, data: Record<string, unknown>) {
      events.push({type, seq: events.length + 1, data: data as Record<string, any>});
    },
  };
  const registry = new ToolRegistry();
  registerArtifactTools(registry, session);

  const cases = [
    {title: 'Transformer Notes', kind: 'markdown', filename: 'notes.md', content: '# Notes\nBody'},
    {title: 'Attention Heatmap', kind: 'html', filename: 'attn.html', content: '<div>ok</div>'},
    {title: 'Residual Diagram', kind: 'svg', filename: 'res.svg', content: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'},
    {title: 'Rotary Embedding', kind: 'code', language: 'python', filename: 'rope.py', content: 'def rope(x): return x'},
    {title: 'Architecture Flow', kind: 'diagram', filename: 'arch.svg', content: '<svg viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>'},
    {title: 'Ablation Table', kind: 'csv', filename: 'ablation.csv', content: 'layer,acc\n1,0.91\n'},
    {title: 'Plain Summary', kind: 'text', content: 'summary'},
  ];

  const createdIds: string[] = [];
  for (const item of cases) {
    const res = await registry.execute({
      id: `call-${item.kind}`,
      name: 'Artifact.create',
      arguments: item,
    });
    assert.equal(res.is_error, false, `Artifact.create(${item.kind}) must succeed: ${res.value}`);
    const draft = res.value as Record<string, any>;
    assert.equal(draft.kind, item.kind);
    if (item.language) {
      assert.equal(draft.language, item.language);
    }
    if (item.filename) {
      assert.equal(draft.filename, item.filename);
    }
    createdIds.push(draft.artifactId);
  }

  const upd = await registry.execute({
    id: 'call-upd',
    name: 'Artifact.update',
    arguments: {
      artifact_id: createdIds[3],
      expected_revision: 1,
      content: 'def rope(x, dim=64): return x',
      kind: 'code',
      language: 'python',
      filename: 'rope_v2.py',
    },
  });
  assert.equal(upd.is_error, false);
  const updated = upd.value as Record<string, any>;
  assert.equal(updated.filename, 'rope_v2.py');
  assert.equal(updated.language, 'python');

  const projected = projectArtifacts(events);
  assert.equal(projected.length, cases.length);
  const summaries = latestTurnArtifactSummaries(events);
  assert.equal(summaries.length, cases.length);
  assert.equal(summaries[3].filename, 'rope_v2.py');
  assert.equal(summaries[3].language, 'python');
});

test('W5-Red: chat_markdown.ts renders artifact: and file:// links as clickable Claude blue-underlined buttons', () => {
  const ChatMarkdown = require('../electron/renderer/chat_markdown');
  const rendered = ChatMarkdown.render(
    [
      'See [Paper X-Ray](artifact:art-123), [notes.md](file:///C:/tmp/notes%20v1.md#L10-L20), and [web](https://example.com).',
    ].join('\n'),
  );

  const buttons = findNodes(rendered, n => isTag(n, 'BUTTON'));
  const artBtn = buttons.find(
    b => attrOf(b, 'data-mp-chat-act') === 'open-artifact',
  );
  assert.ok(artBtn, 'artifact: link must render as clickable open-artifact button');
  assert.match(artBtn.className || attrOf(artBtn, 'class') || '', /mp-chat-artifact-link/);
  assert.equal(attrOf(artBtn, 'data-artifact-id'), 'art-123');

  const fileBtn = buttons.find(
    b => attrOf(b, 'data-mp-chat-act') === 'open-file',
  );
  assert.ok(fileBtn, 'file:// link must render as clickable open-file button');
  assert.match(fileBtn.className || attrOf(fileBtn, 'class') || '', /mp-chat-artifact-link/);
  assert.equal(attrOf(fileBtn, 'data-file-path'), 'C:/tmp/notes v1.md');
  assert.equal(attrOf(fileBtn, 'data-file-absolute-path'), 'C:/tmp/notes v1.md');

  const links = findNodes(rendered, n => isTag(n, 'A'));
  assert.equal(links.length, 1, 'https:// link must stay a standard anchor');
  assert.equal(attrOf(links[0], 'href'), 'https://example.com');

  const css = fs.readFileSync(path.join(ROOT, 'electron/renderer/chat_styles.css'), 'utf8');
  assert.match(css, /\.mp-chat-artifact-link\b/);
  assert.match(css, /text-decoration:\s*underline/);
});

test('W5-Red: chat_view.ts renders ALL turn artifacts as sleek .mp-artifact-card items with kind badges', () => {
  const ChatView = require('../electron/renderer/chat_view');
  const card = ChatView.artifactCardNode(
    [
      {
        artifactId: 'art-1',
        kind: 'markdown',
        title: 'Paper X-Ray: FlashAttention',
        filename: 'flash_attention.md',
        revision: 1,
      },
      {
        artifactId: 'art-2',
        kind: 'svg',
        title: 'Tiling Dataflow Diagram',
        filename: 'tiling.svg',
        revision: 1,
      },
      {
        artifactId: 'art-3',
        kind: 'code',
        language: 'python',
        title: 'Online Softmax Reference',
        filename: 'softmax.py',
        revision: 2,
      },
    ],
    'conv-w5',
  );

  assert.ok(card, 'artifactCardNode must return a card');
  const openButtons = findNodes(
    card,
    n =>
      isTag(n, 'BUTTON') &&
      n.getAttribute?.('data-mp-chat-act') === 'open-artifact' &&
      Boolean(n.getAttribute?.('data-artifact-id')),
  );
  const renderedIds = new Set(openButtons.map(b => b.getAttribute('data-artifact-id')));
  assert.deepEqual([...renderedIds].sort(), ['art-1', 'art-2', 'art-3']);

  const badges = findNodes(card, n =>
    String(n.className || attrOf(n, 'class') || '').includes('mp-artifact-kind-badge'),
  );
  const badgeTexts = badges.map(b => nodeText(b).toUpperCase());
  assert.ok(badgeTexts.includes('MD'));
  assert.ok(badgeTexts.includes('SVG'));
  assert.ok(badgeTexts.includes('PYTHON'));
  assert.ok(badges.some(b => attrOf(b, 'data-kind') === 'code'));

  const cards = findNodes(card, n =>
    String(n.className || n.getAttribute?.('class') || '').includes('mp-artifact-card'),
  );
  assert.ok(cards.length >= 3, 'Each artifact must render as a sleek .mp-artifact-card item');

  const css = fs.readFileSync(path.join(ROOT, 'electron/renderer/chat_styles.css'), 'utf8');
  assert.match(css, /\.mp-artifact-card\b/);
  assert.match(css, /\.mp-artifact-kind-badge\b/);
});

test('W5-Red: studio split preview panel wires multi-type Artifact controls, preserves editor IDs, and handles mp:open-inline-artifact', () => {
  const html = fs.readFileSync(path.join(ROOT, 'electron/renderer/studio.html'), 'utf8');
  for (const requiredId of [
    'artifact-switcher-list',
    'artifact-mode-preview',
    'artifact-mode-source',
    'artifact-preview-host',
    'artifact-copy-btn',
    'artifact-download-btn',
    'artifact-save-vault-btn',
    'artifact-svg-bg-toggle',
    // Preserved legacy editor & patch controls:
    'artifact-editor-content',
    'artifact-patch-changes',
    'artifact-editor-save',
    'artifact-editor-accept',
    'artifact-editor-apply',
    'artifact-editor-undo',
    'artifact-version-select',
    'artifact-version-restore',
  ]) {
    assert.ok(
      html.includes(`id="${requiredId}"`),
      `studio.html must contain #${requiredId}`,
    );
  }

  const editorSrc = fs.readFileSync(path.join(ROOT, 'electron/renderer/artifact_editor.ts'), 'utf8');
  assert.match(editorSrc, /\bfilename\b/);
  assert.match(editorSrc, /\blanguage\b/);

  const studioSrc = fs.readFileSync(path.join(ROOT, 'electron/renderer/studio.ts'), 'utf8');
  assert.match(studioSrc, /mp:open-inline-artifact/);
  assert.match(studioSrc, /artifact-preview-host/);
  assert.match(studioSrc, /artifact-svg-bg-toggle/);
  assert.match(studioSrc, /iui_sandbox\.html/);

  const css = fs.readFileSync(path.join(ROOT, 'electron/renderer/studio_artifacts.css'), 'utf8');
  assert.match(css, /mp-artifact-preview-host|artifact-preview-host/);
  assert.match(css, /mp-artifact-mode-switch|mp-artifact-switcher/);
});
