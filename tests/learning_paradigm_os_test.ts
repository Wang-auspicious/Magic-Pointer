import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Paradigm A: Learn removes rigid 3-button stance bar and uses human-paced anti-slop mentor prompt', () => {
  const html = readRepo('electron/renderer/studio.html');
  assert.doesNotMatch(
    html,
    /id="learn-stance-bar"/,
    'rigid 3-mode radio bar (#learn-stance-bar) must be removed in favor of natural human-paced dialogue',
  );

  const agentSrc = readRepo('electron/runtime/agent.ts');
  assert.match(
    agentSrc,
    /短回合|3~6\s*句|禁止.*一、二、三|反八股/,
    'LEARN_HARNESS_PROMPT must enforce short natural turns and ban robotic 1-2-3 walls of text',
  );
  assert.match(
    agentSrc,
    /隐状态|底层直觉|思辨/,
    'LEARN_HARNESS_PROMPT must focus on hidden-state mental models and critical thinking',
  );
  assert.match(
    agentSrc,
    /:::ui/,
    'LEARN_HARNESS_PROMPT must teach the model when and how to emit :::ui Intelligence UI widgets',
  );
});

test('Paradigm B: Intelligence UI engine renders sandboxed :::ui interactive widgets safely', () => {
  const iuiPath = path.join(ROOT, 'electron/renderer/intelligence_ui.ts');
  assert.ok(fs.existsSync(iuiPath), 'intelligence_ui.ts must exist');
  const iuiSrc = fs.readFileSync(iuiPath, 'utf8');
  assert.match(iuiSrc, /sandbox/, 'Intelligence UI must isolate widget execution inside a sandboxed iframe');
  assert.match(iuiSrc, /iui_sandbox\.html/, 'Intelligence UI must load dedicated file:// sandbox host');
  const sandboxHtml = readRepo('electron/renderer/iui_sandbox.html');
  assert.match(sandboxHtml, /Content-Security-Policy/, 'iui_sandbox.html must set strict CSP');
  assert.match(iuiSrc, /mp-iui-resize|postMessage/, 'Intelligence UI must support auto-resize and mentor feedback postMessage');

  const mdSrc = readRepo('electron/renderer/chat_markdown.ts');
  assert.match(
    mdSrc,
    /mp-iui-card/,
    'chat_markdown.ts must parse :::ui / :::widget fences into .mp-iui-card containers',
  );

  const html = readRepo('electron/renderer/studio.html');
  assert.match(html, /intelligence_ui\.js/, 'studio.html must load intelligence_ui.js');
});

test('Paradigm C: KnowledgeVault parses Obsidian [[wikilinks]], backlinks, #tags, todos, and exports notes cleanly', () => {
  const {
    scanKnowledgeVault,
    saveVaultNote,
    toggleVaultTodo,
  } = require('../electron/knowledge_vault');
  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-obsidian-vault-'));
  try {
    saveVaultNote(tmpVault, {
      title: 'Attention 为什么不能 Q 乘 Q',
      folder: 'AI-Learn',
      tags: ['transformer', 'attention'],
      source: 'Magic Pointer Learn',
      body: [
        '因为 $Q Q^T$ 是对称矩阵，导致 [[位置编码]] 与词序方向性全部塌缩。',
        '',
        '- [ ] 用交互微件验证 RoPE 旋转矩阵',
        '- [x] 理解对称点积的局限',
      ].join('\n'),
    });
    saveVaultNote(tmpVault, {
      title: '位置编码',
      folder: 'AI-Learn',
      tags: ['transformer', 'rope'],
      source: 'X 收藏 · @karpathy',
      body: 'RoPE 通过复平面旋转把相对位置注入内积，关联 [[Attention 为什么不能 Q 乘 Q]]。',
    });

    const overview = scanKnowledgeVault(tmpVault);
    assert.equal(overview.notes.length, 2, 'must index both Obsidian notes');
    assert.ok(overview.tags.some((t: {tag: string}) => t.tag === 'transformer'));
    assert.equal(overview.todos.length, 2, 'must extract checkbox todos');
    assert.equal(overview.todos.filter((t: {done: boolean}) => !t.done).length, 1);

    const posNote = overview.notes.find((n: {title: string}) => n.title === '位置编码');
    assert.ok(posNote, 'must find linked note');
    assert.ok(
      posNote.backlinks.includes('Attention 为什么不能 Q 乘 Q'),
      'must compute bidirectional [[wikilink]] backlinks',
    );

    const openTodo = overview.todos.find((t: {done: boolean}) => !t.done);
    const toggled = toggleVaultTodo(tmpVault, openTodo.filePath, openTodo.lineIndex, true);
    assert.equal(toggled.ok, true);
    const after = scanKnowledgeVault(tmpVault);
    assert.equal(
      after.todos.filter((t: {done: boolean}) => !t.done).length,
      0,
      'toggling todo must persist [x] to the Obsidian markdown file',
    );
  } finally {
    fs.rmSync(tmpVault, {recursive: true, force: true});
  }
});

test('Paradigm C wiring: main.ts, preload.ts, studio.html wire Vault IPC and embedded Notion/X/RedBook browser bar', () => {
  const mainSrc = readRepo('electron/main.ts');
  assert.match(mainSrc, /vault:overview/, 'main.ts must expose vault:overview IPC');
  assert.match(mainSrc, /vault:save-note/, 'main.ts must expose vault:save-note IPC');
  assert.match(mainSrc, /vault:toggle-todo/, 'main.ts must expose vault:toggle-todo IPC');

  const preloadSrc = readRepo('electron/preload.ts');
  assert.match(preloadSrc, /vault:\s*\{/, 'preload.ts must expose vault bridge');

  const html = readRepo('electron/renderer/studio.html');
  assert.match(html, /data-inspector-tab="vault"/, 'right workspace must expose Obsidian Vault tab');
  assert.match(html, /notion\.so/i, 'embedded browser panel must offer one-click Notion launch');
  assert.match(html, /xiaohongshu\.com/i, 'embedded browser panel must offer one-click RedBook launch');
});
