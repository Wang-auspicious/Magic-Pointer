'use strict';

// Artifact version list + rollback: revisions seen in-session carry content
// and can be restored through the normal edit path; anything else refuses
// instead of guessing.

const assert = require('node:assert/strict');
const {
  createArtifactEditor,
} = require('../electron/renderer/artifact_editor');

const calls = [];
let artifact = {
  artifactId: 'artifact-1',
  revision: 1,
  content: 'draft one',
  kind: 'text',
  state: 'generated',
  acceptedRevision: null,
  patchPayload: null,
};

const client = {
  async read() {
    calls.push({action: 'read'});
    return {ok: true, artifact: {...artifact}};
  },
  async edit(payload) {
    calls.push({action: 'edit', payload});
    artifact = {
      ...artifact,
      revision: artifact.revision + 1,
      content: String(payload.content),
    };
    return {ok: true, artifact: {...artifact}};
  },
  async accept() {
    return {ok: true, artifact: {...artifact}};
  },
  async apply() {
    return {ok: true, result: {status: 'succeeded'}};
  },
};

(async () => {
  const editor = createArtifactEditor(client);
  await editor.select('conversation-1', 'artifact-1');
  editor.updateContent('draft two');
  await editor.save();
  assert.equal(editor.state().revision, 2);
  const seen = editor.versions().map(v => v.revision);
  assert.ok(seen.includes(1), 'revision 1 content was cached on read');
  assert.ok(
    editor.versions().find(v => v.revision === 1)?.hasContent === true,
  );

  // Restoring the older revision re-sends its cached content as a new edit.
  const restored = await editor.restoreVersion(1);
  assert.equal(restored.ok, true);
  const lastEdit = calls.filter(c => c.action === 'edit').pop();
  assert.equal(lastEdit.payload.content, 'draft one');
  assert.equal(lastEdit.payload.expectedRevision, 2);

  // Unknown revisions refuse; the current revision is a no-op.
  const missing = await editor.restoreVersion(99);
  assert.equal(missing.ok, false);
  const same = await editor.restoreVersion(editor.state().revision);
  assert.equal(same.ok, true);
  assert.equal(
    calls.filter(c => c.action === 'edit').length,
    2,
    'no-op restore must not send another edit',
  );

  // Dirty editors must save first instead of silently discarding edits.
  editor.updateContent('unsaved work');
  const dirty = await editor.restoreVersion(1);
  assert.equal(dirty.ok, false);

  console.log('artifact editor versions test ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
