import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
const { createArtifactEditor } = require('../electron/renderer/artifact_editor');
async function main() {
  const studio = fs.readFileSync(path.resolve(__dirname, '../electron/renderer/studio.ts'), 'utf8');
  const artifact = (id: string) => ({ artifactId: id, revision: 1, content: 'draft', patchPayload: { marker: id, operations: [{ after: 'old' }] } });
  const editor = createArtifactEditor({ read: async (payload: any) => ({ ok: true, artifact: artifact(payload.artifactId) }) });
  await editor.select('c', 'a');
  let handler: any;
  const changeHandler = studio.slice(studio.indexOf("document.getElementById('artifact-patch-changes')?.addEventListener('change'"), studio.indexOf("document.getElementById('artifact-patch-changes')?.addEventListener('click'"));
  vm.runInNewContext(transformSync(changeHandler, { loader: 'ts' }).code, {
    artifactEditor: editor,
    document: { getElementById: () => ({ addEventListener: (_event: string, callback: any) => { handler = callback; } }) },
    renderArtifactEditor() {},
  });
  let validation = '';
  const field = { dataset: { artifactOperationIndex: '0' }, value: '更短的说明', setCustomValidity(value: string) { validation = value; }, reportValidity() {} };
  handler({ target: { closest: () => field } });
  assert.equal(validation, '', 'a plain text patch accepts the same text format that is displayed');
  assert.equal(editor.state().patchPayload.operations[0].after, '更短的说明');

  let resolveSelection: (value: any) => void = () => {};
  const retargetSource = studio.slice(studio.indexOf('async function retargetFigmaArtifact('), studio.indexOf('\nfunction artifactValueText('));
  const sandbox: any = {
    artifactEditor: editor, ArtifactEditor: { retargetFigmaPatch: (payload: any) => ({ ...payload, retargeted: true }) },
    Data: { inspectFigmaSelection: () => new Promise((resolve) => { resolveSelection = resolve; }) },
    figmaPatchCoordinates: () => ({ key: 'a:1', documentSessionId: 'doc-a' }), figmaArtifactPreviews: new Map(),
    renderArtifactPatchPreview() {}, renderArtifactEditor() {}, refreshFigmaArtifactPreviews: async () => {},
  };
  vm.runInNewContext(transformSync(retargetSource, { loader: 'ts' }).code, sandbox);
  const pending = sandbox.retargetFigmaArtifact(0);
  await editor.select('c', 'b');
  resolveSelection({ ok: true, result: { selectionIds: ['1:2'], nodes: [{ id: '1:2' }] } });
  await pending;
  assert.equal(editor.state().patchPayload.marker, 'b', 'a late retarget result cannot edit a different selected draft');
  console.log('artifact_renderer_edits_test: passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
