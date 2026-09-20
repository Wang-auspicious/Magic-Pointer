const assert = require('node:assert/strict');
const { createArtifactEditor } = require('../electron/renderer/artifact_editor');
async function main() {
  const artifact = { artifactId: 'a', revision: 1, content: 'draft', patchPayload: { operations: [{ after: 'old' }] } };
  let finishSave: (response: any) => void = () => {};
  const editor = createArtifactEditor({
    read: async () => ({ ok: true, artifact }),
    edit: () => new Promise((resolve) => { finishSave = resolve; }),
    accept: async () => ({ ok: true, artifact }),
  });
  await editor.select('c', 'a');
  editor.updatePatchPayload({ operations: [{ after: 'first edit' }] });
  editor.updateContent('temporary');
  editor.updateContent('draft');
  assert.equal(editor.state().dirty, true, 'restoring text must not discard a pending patch edit');
  assert.equal((await editor.accept()).error, 'save_required_before_accept');
  const saving = editor.save();
  editor.updatePatchPayload({ operations: [{ after: 'newer edit' }] });
  finishSave({ ok: true, artifact: { ...artifact, revision: 2, patchPayload: { operations: [{ after: 'first edit' }] } } });
  await saving;
  assert.equal(editor.state().patchPayload.operations[0].after, 'newer edit');
  assert.equal(editor.state().dirty, true, 'edits made during save remain unsaved');
  console.log('artifact_editor_unsaved_patch_test: passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
