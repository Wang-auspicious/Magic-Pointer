import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventSession} from '../electron/runtime/session';
import {
  createArtifact,
  patchArtifact,
  handleArtifact,
} from '../electron/runtime/artifacts';
const {createArtifactEditor} = require('../electron/renderer/artifact_editor');

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), 'mp-artifact-versions-'));
  try {
    const sessionId = `agent-${randomUUID()}`;
    const session = await EventSession.open(directory, sessionId);
    const draft = await createArtifact(session, 'draft one', 'Original title');
    await patchArtifact(session, draft.artifactId, 1, 'draft two', {
      title: 'Revised title',
    });
    const invoke = (action: string, payload: Record<string, unknown>) =>
      handleArtifact({...payload, action, sessionId}, directory);
    const client = {
      read: (payload: Record<string, unknown>) => invoke('read', payload),
      edit: (payload: Record<string, unknown>) => invoke('edit', payload),
      restore: (payload: Record<string, unknown>) => invoke('restore', payload),
      accept: (payload: Record<string, unknown>) => invoke('accept', payload),
      apply: (payload: Record<string, unknown>) => invoke('apply', payload),
    };
    const editor = createArtifactEditor(client);
    await editor.select('conversation-1', draft.artifactId);
    assert.deepEqual(
      editor.versions().map((v: {revision: number}) => v.revision),
      [2, 1],
      'a fresh editor must list durable revisions it has never seen',
    );
    const preview = await editor.previewVersion(1);
    assert.equal(preview.artifact.content, 'draft one');
    assert.equal(
      editor.state().revision,
      2,
      'preview must not replace the editable revision',
    );
    assert.equal(editor.state().content, 'draft two');
    const restored = await editor.restoreVersion(1);
    assert.equal(restored.ok, true);
    assert.equal(restored.artifact.revision, 3);
    assert.equal(restored.artifact.content, 'draft one');
    assert.equal(restored.artifact.title, 'Original title');
    assert.equal(restored.artifact.acceptedRevision, null);
    assert.equal(editor.state().preview, null);
    const reopened = await invoke('read', {artifactId: draft.artifactId});
    assert.equal((reopened.artifact as {revision: number}).revision, 3);
    assert.equal((await editor.restoreVersion(99)).ok, false);
    assert.equal((await editor.restoreVersion(3)).ok, true);
    editor.updateContent('unsaved work');
    assert.equal((await editor.restoreVersion(1)).ok, false);
    assert.equal(editor.state().content, 'unsaved work');
    assert.equal(
      (
        await invoke('restore', {
          artifactId: draft.artifactId,
          revision: 1,
          expectedRevision: 2,
        })
      ).error,
      'stale_revision',
    );

    const locator = {
      kind: 'text-range',
      value: {path: '/document.txt', start: 0, end: 3},
    };
    const patch = {
      patchId: 'patch-one',
      references: [
        {referenceId: 'target', sourceId: 'source', locator, role: 'target'},
      ],
      operations: [
        {
          operationId: 'op',
          operation: 'replace_text',
          referenceId: 'target',
          sourceId: 'source',
          locator,
          before: 'old',
          after: 'first',
        },
      ],
    };
    const patchDraft = await createArtifact(
      session,
      'first proposal',
      'Patch',
      'document_patch',
      patch,
    );
    await patchArtifact(session, patchDraft.artifactId, 1, 'second proposal', {
      patchPayload: {
        ...patch,
        operations: [{...patch.operations[0], after: 'second'}],
      },
    });
    const restoredPatch = await invoke('restore', {
      artifactId: patchDraft.artifactId,
      revision: 1,
      expectedRevision: 2,
    });
    assert.equal(restoredPatch.ok, true);
    const restoredArtifact = restoredPatch.artifact as {
      patchPayload: {
        operations: Array<{after: string}>;
        artifactRevision: number;
      };
      acceptedRevision: number | null;
    };
    assert.equal(restoredArtifact.patchPayload.operations[0].after, 'first');
    assert.equal(restoredArtifact.patchPayload.artifactRevision, 3);
    assert.equal(restoredArtifact.acceptedRevision, null);
    console.log(
      'Durable artifact history, preview, text/patch restore and stale/dirty protection passed',
    );
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    await rm(directory, {recursive: true, force: true});
  }
}
void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
