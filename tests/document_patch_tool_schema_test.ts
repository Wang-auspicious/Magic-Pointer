import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerArtifactTools, documentPatch } from '../electron/runtime/artifacts';
import { EventSession } from '../electron/runtime/session';
import { ToolRegistry } from '../electron/runtime/tools';
import { modelPayload } from '../electron/runtime/model';

test('Document.propose_patch exposes its required operation contract to the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-patch-schema-'));
  const session = await EventSession.open(root, 'patch-schema');
  const registry = new ToolRegistry();
  registerArtifactTools(registry, session);
  registry.setInitialTools(['Document.propose_patch']);
  const tool = registry.schemas().find(item => item.name === 'Document.propose_patch')!;
  const body = modelPayload({ model: 'fixture', apiMode: 'chat-completions' },
    { system: '', messages: [], tools: [tool], maxTokens: 1000 });
  const visible = body.tools[0].function;
  const operation = visible.parameters.properties.operations.items;
  assert.deepEqual([...operation.required].sort(),
    ['operationId', 'operation', 'sourceId', 'referenceId', 'locator', 'before', 'after'].sort());
  assert.ok(operation.properties.operation.enum.includes('set_cell_values'));
  assert.ok(operation.properties.operation.enum.includes('replace_text'));
  assert.match(visible.description, /"operation":"set_cell_values"/);
  assert.match(visible.description, /"range":"B7"/);
  assert.match(visible.description, /"before":\[\[5\]\]/);
  assert.match(visible.description, /"after":\[\[8\]\]/);
  assert.doesNotMatch(visible.description, /"range":"B2"/, 'the tool example must not reveal the acceptance target');

  const locator = { kind: 'cell-range', value: { sheet: 'Sheet1', range: 'B2' } };
  const correct = { summary: 'Only B2', operations: [{ operationId: 'edit-B2', operation: 'set_cell_values',
    sourceId: 'source:excel', referenceId: 'target:B2', locator, before: [[120]], after: [[210]] }] };
  assert.deepEqual(registry.validateInput(registry.get('Document.propose_patch'), correct), []);
  assert.deepEqual(registry.validateInput(registry.get('Document.propose_patch'), {
    summary: 'Wrong field names', operations: [{ action: 'set_cell_values', targetReference: 'target:B2',
      locator, before: [[120]], after: [[210]] }],
  }).some(error => error.includes('missing operation')), true);
  assert.deepEqual(registry.validateInput(registry.get('Document.propose_patch'), {
    summary: 'Word change', operations: [{ operationId: 'edit-word', operation: 'replace_text',
      sourceId: 'source:word', referenceId: 'target:sentence',
      locator: { kind: 'text', value: { start: 3, end: 8 } }, before: 'old', after: 'new' }],
  }), [], 'the schema must preserve non-Excel operations');
  assert.equal(documentPatch({ patchId: 'patch', artifactId: 'artifact', artifactRevision: 1,
    references: [{ referenceId: 'target:B2', sourceId: 'source:excel', locator, role: 'target' }],
    operations: correct.operations }).operations[0].operation, 'set_cell_values');
});
