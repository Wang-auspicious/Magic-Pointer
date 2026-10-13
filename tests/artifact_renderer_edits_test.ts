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
  const changeStart = studio.indexOf('function updateArtifactPatchFields(');
  const changeEnd = studio.indexOf('\ndocument', changeStart);
  assert.ok(changeStart >= 0 && changeEnd > changeStart, 'patch handler must exist');
  const changeHandler = studio.slice(changeStart, changeEnd);
  const field = {value: '更短的说明', closest: (selector: string) => selector.includes('data-value-path') ? field : null, matches: () => false};
  const fieldContext: any = {
    artifactEditor: editor,
    document: { getElementById: () => ({}) },
    ArtifactPatchFields: {read: (_host: unknown, operations: Array<Record<string, unknown>>) => operations.map(operation => ({...operation, after: field.value}))},
    renderArtifactEditor() {},
  };
  vm.runInNewContext(transformSync(changeHandler, { loader: 'ts' }).code, fieldContext);
  fieldContext.updateArtifactPatchFields({target: field});
  assert.equal(editor.state().patchError, '', 'a plain text patch accepts the same text format that is displayed');
  assert.equal(editor.state().patchPayload.operations[0].after, '更短的说明');

  let resolveSelection: (value: any) => void = () => {};
  const retargetSource = studio.slice(studio.indexOf('async function retargetFigmaArtifact('), studio.indexOf('\nfunction renderArtifactPatchPreview('));
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
