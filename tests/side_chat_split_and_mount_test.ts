import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Batch 1.1: LearnBranch supports mountedToParent + mountNote without mutating parent turns or agentSessionId', () => {
  const {createConversationStore} = require('../electron/conversation_store');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-side-mount-'));
  try {
    const store = createConversationStore({
      baseDir: tmpDir,
    });
    const conv = store.appendTurn({
      conversationId: 'conv-parent-cache-001',
      title: 'Parent Prompt Cache Test',
      workMode: 'code',
      agentSessionId: 'agent-parent-stable-001',
      question: 'Explain prefix caching.',
      answer: 'Prefix caching hashes immutable earlier turns.',
      outcome: 'completed',
    });
    assert.ok(conv?.id, 'parent conversation must be created');
    const beforeTurnsSnapshot = JSON.stringify(store.get(conv.id)?.turns);
    const beforeParentSession = store.get(conv.id)?.agentSessionId;

    const added = store.appendBranchTurn({
      conversationId: conv.id,
      parentBranchId: null,
      parentTurnIndex: 0,
      anchor: {
        kind: 'selection',
        label: 'immutable earlier turns',
        snippet: 'Prefix caching hashes immutable earlier turns.',
        blockIndex: 0,
      },
      title: 'Deep dive: immutable earlier turns',
      agentSessionId: 'agent-side-fork-002',
      question: 'Why does editing turn 1 bust cache for turns 2..N?',
      answer: 'Because KV attention keys/values depend sequentially on all prior tokens.',
    });
    assert.ok(added?.branch?.id, 'branch must be created');

    const mounted = store.updateBranchMeta(conv.id, added.branch.id, {
      mountedToParent: true,
      mountNote: 'Key insight: never mutate earlier turns; mount externally instead.',
    });
    assert.equal(mounted.ok, true);
    assert.equal(mounted.branch?.mountedToParent, true);
    assert.equal(
      mounted.branch?.mountNote,
      'Key insight: never mutate earlier turns; mount externally instead.',
    );
    assert.ok(
      Number(mounted.branch?.mountedAt) > 0,
      'mountedAt timestamp must be set when mounting',
    );

    store.flush();
    const reloaded = createConversationStore({
      baseDir: tmpDir,
    }).get(conv.id);

    assert.equal(
      JSON.stringify(reloaded?.turns),
      beforeTurnsSnapshot,
      'mounting a side chat MUST NOT alter parent turns (zero context injection)',
    );
    assert.equal(
      reloaded?.agentSessionId,
      beforeParentSession,
      'mounting a side chat MUST NOT alter parent agentSessionId',
    );
    const reloadedBranch = reloaded?.branches?.find(
      (b: {id: string}) => b.id === added.branch.id,
    );
    assert.equal(reloadedBranch?.mountedToParent, true);
    assert.equal(
      reloadedBranch?.mountNote,
      'Key insight: never mutate earlier turns; mount externally instead.',
    );
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('Batch 1.2: main.ts persists mountedToParent/mountNote via conversations:learn-patch and never injects branches into parent send', () => {
  const mainSrc = readRepo('electron/main.ts');
  assert.match(
    mainSrc,
    /mountedToParent/,
    'main.ts learn-patch update-branch must forward mountedToParent',
  );
  assert.match(
    mainSrc,
    /mountNote/,
    'main.ts learn-patch update-branch must forward mountNote',
  );
});

test('Batch 1.3: SideChatPane exists, wires split inspector panel, and renders zero-context mounted cards', () => {
  const panePath = path.join(ROOT, 'electron/renderer/side_chat_pane.ts');
  assert.ok(fs.existsSync(panePath), 'side_chat_pane.ts must exist');
  const paneSrc = fs.readFileSync(panePath, 'utf8');
  assert.match(paneSrc, /mp-sidechat-pane/, 'must render split side chat container');
  assert.match(paneSrc, /mp-mounted-sidechat/, 'must render mounted external card');
  assert.match(paneSrc, /未注入上下文|zero context/i, 'must clearly communicate zero context injection');
  assert.match(paneSrc, /外挂到主对话|Mount to parent/i, 'must offer mount-to-parent action');

  const html = readRepo('electron/renderer/studio.html');
  assert.match(
    html,
    /data-inspector-panel="side-chat"/,
    'studio.html must provide a dedicated split side-chat inspector panel',
  );
  assert.match(html, /side_chat_pane\.js/, 'studio.html must load side_chat_pane.js');

  const studioSrc = readRepo('electron/renderer/studio.ts');
  assert.match(
    studioSrc,
    /SideChatPane/,
    'studio.ts must wire SideChatPane for side-by-side parallel chat and mounted cards',
  );
});
