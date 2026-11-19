import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Batch 2.1: CSS separates Learn vs Code header actions, inspector tabs, and Git composer chrome', () => {
  const css =
    readRepo('electron/renderer/chat_styles.css') +
    '\n' +
    readRepo('electron/renderer/studio_layout.css');
  assert.match(
    css,
    /\[data-product-mode="walker"\][^{]*#chat-skim-toggle/,
    'Code mode must hide Learn-only #chat-skim-toggle from header',
  );
  assert.match(
    css,
    /\[data-product-mode="walker"\][^{]*#chat-learn-toggle/,
    'Code mode must hide Learn-only #chat-learn-toggle from header',
  );
  assert.match(
    css,
    /\[data-product-mode="design"\][^{]*#composer-git-context/,
    'Learn mode must hide Git branch/worktree composer chrome',
  );
  assert.match(
    css,
    /\[data-product-mode="design"\][^{]*\[data-inspector-tab="changes"\]/,
    'Learn mode must hide Git Changes inspector tab',
  );
});

test('Batch 2.2: Learn mode reconciles inspector tab on switch and avoids rigid 3-mode radio clutter', () => {
  const html = readRepo('electron/renderer/studio.html');
  assert.doesNotMatch(
    html,
    /id="learn-stance-bar"/,
    'Learn mode must not show rigid 3-mode radio buttons above composer',
  );
  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.match(
    studioSrc,
    /activeInspectorTab\s*===\s*'learn'/,
    'setProductMode must reconcile inspector tab when switching between Learn and Code',
  );
});

test('Batch 2.3: agent.ts differentiates CODE_HARNESS_PROMPT vs LEARN_HARNESS_PROMPT distinctly', () => {
  const agentSrc = readRepo('electron/runtime/agent.ts');
  assert.match(
    agentSrc,
    /const\s+CODE_HARNESS_PROMPT\s*=/,
    'agent.ts must define a dedicated CODE_HARNESS_PROMPT distinct from LEARN_HARNESS_PROMPT',
  );
  assert.match(
    agentSrc,
    /const\s+LEARN_HARNESS_PROMPT\s*=/,
    'agent.ts must keep dedicated LEARN_HARNESS_PROMPT',
  );
});
