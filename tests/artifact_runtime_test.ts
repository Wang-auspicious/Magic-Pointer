const assert = require('node:assert');
const { createArtifactRuntime } = require('../electron/artifact_runtime');

const bridgeCalls: Record<string, unknown>[] = [];
const runtime = createArtifactRuntime({
  conversationStore: {
    get(id: string) {
      return id === 'conversation-1'
        ? { id, agentSessionId: 'agent-studio-conv-0123456789abcdef0123456789abcdef' }
        : undefined;
    },
  },
  runBridge: async (payload: Record<string, unknown>) => {
    bridgeCalls.push(payload);
    return { ok: true, artifact: { artifactId: payload.artifactId, revision: 2 } };
  },
});

(async () => {
  await runtime.read({ conversationId: 'conversation-1', artifactId: 'artifact-1' });
  await runtime.edit({
    conversationId: 'conversation-1',
    artifactId: 'artifact-1',
    expectedRevision: 1,
    content: 'edited',
    patchPayload: { patchId: 'patch-1' },
  });
  await runtime.accept({ conversationId: 'conversation-1', artifactId: 'artifact-1', revision: 2 });
  await runtime.apply({ conversationId: 'conversation-1', artifactId: 'artifact-1', revision: 2 });

  assert.deepStrictEqual(bridgeCalls.map((call) => call.action), ['read', 'edit', 'accept', 'apply']);
  assert.ok(bridgeCalls.every((call) => (
    call.sessionId === 'agent-studio-conv-0123456789abcdef0123456789abcdef'
  )));
  assert.strictEqual(bridgeCalls[1].expectedRevision, 1);
  assert.strictEqual(bridgeCalls[1].content, 'edited');
  assert.deepStrictEqual(bridgeCalls[1].patchPayload, { patchId: 'patch-1' });

  const missing = await runtime.read({ conversationId: 'missing', artifactId: 'artifact-1' });
  assert.deepStrictEqual(missing, { ok: false, error: 'conversation_not_found' });
  assert.strictEqual(bridgeCalls.length, 4);

  const invalid = await runtime.apply({
    conversationId: 'conversation-1',
    artifactId: 'artifact-1',
    revision: '2',
  });
  assert.deepStrictEqual(invalid, { ok: false, error: 'artifact_revision_invalid' });
  assert.strictEqual(bridgeCalls.length, 4);

  console.log('artifact runtime test ok');
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
