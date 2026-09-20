const assert = require('node:assert/strict');
const { createArtifactRuntime } = require('../electron/artifact_runtime');
const { createArtifactEditor } = require('../electron/renderer/artifact_editor');
async function main() {
  const calls: any[] = [];
  const runtime = createArtifactRuntime({ conversationStore: { get: () => ({ agentSessionId: 'session' }) }, runBridge: async (payload: any) => { calls.push(payload); return { ok: true, result: { status: 'succeeded', verified: true } }; } });
  const payload = { conversationId: 'c', artifactId: 'a', revision: 1 };
  assert.equal((await runtime.undo(payload)).ok, false, 'undo requires an explicit user decision');
  await runtime.undo({ ...payload, confirmed: true });
  assert.deepEqual(calls[0], { action: 'undo', sessionId: 'session', artifactId: 'a', revision: 1, confirmed: true });
  const editor = createArtifactEditor({ read: async () => ({ ok: true, artifact: { artifactId: 'a', revision: 1, content: 'draft', undoAvailable: true } }), undo: runtime.undo });
  await editor.select('c', 'a');
  assert.equal(editor.state().undoAvailable, true);
  await editor.undo(true);
  assert.equal(editor.state().undoAvailable, false, 'a successful undo cannot be submitted twice');
  assert.equal(editor.state().applyResult.undone, true);
  console.log('artifact_undo_ui_contract_test: passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
