const assert = require('node:assert');
const { createArtifactEditor, retargetFigmaPatch } = require('../electron/renderer/artifact_editor');

const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
let artifact: any = {
  artifactId: 'artifact-1',
  revision: 1,
  content: 'draft one',
  kind: 'document_patch',
  state: 'generated',
  acceptedRevision: null,
  patchPayload: { artifactId: 'artifact-1', artifactRevision: 1, operations: [] },
};

const client = {
  async read(payload: Record<string, unknown>) {
    calls.push({ action: 'read', payload });
    return { ok: true, artifact: { ...artifact } };
  },
  async edit(payload: Record<string, unknown>) {
    calls.push({ action: 'edit', payload });
    artifact = {
      ...artifact,
      revision: 2,
      content: String(payload.content),
      state: 'edited',
      patchPayload: {
        ...(payload.patchPayload as Record<string, unknown>),
        artifactRevision: 2,
      },
    };
    return { ok: true, artifact: { ...artifact } };
  },
  async accept(payload: Record<string, unknown>) {
    calls.push({ action: 'accept', payload });
    artifact = { ...artifact, state: 'approved', acceptedRevision: artifact.revision };
    return { ok: true, artifact: { ...artifact } };
  },
  async apply(payload: Record<string, unknown>) {
    calls.push({ action: 'apply', payload });
    return {
      ok: true,
      result: { status: 'succeeded', artifactRevision: payload.revision, verified: true },
    };
  },
};

(async () => {
  const editor = createArtifactEditor(client);
  await editor.select('conversation-1', 'artifact-1');
  editor.updateContent('draft two');
  assert.strictEqual(editor.state().dirty, true);
  await editor.save();
  assert.strictEqual(editor.state().revision, 2);
  assert.strictEqual(editor.state().dirty, false);
  await editor.accept();
  assert.strictEqual(editor.state().acceptedRevision, 2);
  await editor.apply();
  assert.strictEqual(editor.state().applyResult.artifactRevision, 2);
  assert.deepStrictEqual(calls.map((item) => item.action), ['read', 'edit', 'accept', 'apply']);
  assert.strictEqual(calls[1].payload.expectedRevision, 1);
  assert.strictEqual(calls[2].payload.revision, 2);
  assert.strictEqual(calls[3].payload.revision, 2);

  const failing = createArtifactEditor({
    ...client,
    async edit() { return { ok: false, error: 'disk_failed' }; },
  });
  await failing.select('conversation-1', 'artifact-1');
  failing.updateContent('not saved');
  const failedSave = await failing.save();
  assert.strictEqual(failedSave.ok, false);
  assert.strictEqual(failing.state().dirty, true);
  assert.strictEqual(failing.state().status, 'error');
  assert.strictEqual(failing.state().content, 'not saved');

  const retargeted = retargetFigmaPatch({
    patchId: 'patch-1',
    artifactId: 'artifact-1',
    artifactRevision: 2,
    references: [{
      referenceId: 'ref-target',
      sourceId: 'source:figma:document-a',
      locator: { kind: 'figma-node', value: { nodeId: 'old', documentSessionId: 'document-a' } },
      role: 'target',
    }],
    operations: [{
      operationId: 'op-size',
      operation: 'set_figma_size',
      referenceId: 'ref-target',
      sourceId: 'source:figma:document-a',
      locator: { kind: 'figma-node', value: { nodeId: 'old', documentSessionId: 'document-a' } },
      before: { width: 10, height: 20 },
      after: { width: 30, height: 40 },
    }],
  }, 0, {
    id: 'new',
    type: 'FRAME',
    name: 'Chosen frame',
    width: 120,
    height: 80,
  });
  assert.deepStrictEqual(retargeted.references[0].locator.value, {
    nodeId: 'new',
    documentSessionId: 'document-a',
  });
  assert.deepStrictEqual(retargeted.operations[0].locator.value, {
    nodeId: 'new',
    documentSessionId: 'document-a',
  });
  assert.deepStrictEqual(retargeted.operations[0].before, { width: 120, height: 80 });

  const textRetargeted = retargetFigmaPatch({
    ...retargeted,
    references: retargeted.references,
    operations: [{
      ...retargeted.operations[0],
      operation: 'replace_text',
      before: 'Old',
      after: 'New',
    }],
  }, 0, { id: 'text-new', type: 'TEXT', characters: 'Whole label' });
  assert.strictEqual(textRetargeted.operations[0].before, 'Whole label');
  assert.deepStrictEqual(textRetargeted.operations[0].locator.value, {
    nodeId: 'text-new',
    documentSessionId: 'document-a',
    textStart: 0,
    textEnd: 11,
  });

  console.log('artifact editor test ok');
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
