import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession } from '../electron/runtime/session';
import { registerCodingTools } from '../electron/runtime/agent_files';
import { ToolRegistry } from '../electron/runtime/tools';

async function fixture(name: string) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'mp-file-evidence-'));
  const session = await EventSession.open(workspace, name);
  const registry = new ToolRegistry();
  registerCodingTools(registry, workspace, session);
  return { workspace, registry };
}

test('Read reports actual byte and line ending evidence; Edit changes only the matched bytes', async () => {
  const { workspace, registry } = await fixture('mixed-lines');
  const before = Buffer.from('\uFEFFOrder: Aurora\r\nQuantity: 98\nDelivery: Tuesday\r\n');
  const after = Buffer.from('\uFEFFOrder: Aurora\r\nQuantity: 112\nDelivery: Tuesday\r\n');
  await writeFile(path.join(workspace, 'order.txt'), before);
  const read = await registry.execute({ id: 'read', name: 'Read', arguments: { path: 'order.txt' } });
  assert.equal(read.is_error, false, read.error_message);
  assert.match(String(read.value), new RegExp(`utf8Bytes=${before.length}`));
  assert.match(String(read.value), /bom=present/);
  assert.match(String(read.value), /lineEndings=mixed/);
  const edit = await registry.execute({ id: 'edit', name: 'Edit', arguments: { path: 'order.txt', old_string: 'Quantity: 98', new_string: 'Quantity: 112' } });
  assert.equal(edit.is_error, false, edit.error_message);
  assert.deepEqual(await readFile(path.join(workspace, 'order.txt')), after);
  const result = edit.value as { verification: { matched: boolean; method: string; preservedUntouchedBytes: boolean; originalBytes: number; finalBytes: number } };
  assert.equal(result.verification.matched, true);
  assert.equal(result.verification.preservedUntouchedBytes, true);
  assert.equal(result.verification.originalBytes, before.length);
  assert.equal(result.verification.finalBytes, after.length);
});

test('Edit preserves unrelated CSV bytes instead of re-encoding the whole file', async () => {
  const { workspace, registry } = await fixture('csv-lines');
  const before = Buffer.from('item,qty\r\nAurora,98\nother,7\r\n');
  const after = Buffer.from('item,qty\r\nAurora,112\nother,7\r\n');
  await writeFile(path.join(workspace, 'order.csv'), before);
  await registry.execute({ id: 'read', name: 'Read', arguments: { path: 'order.csv' } });
  const edit = await registry.execute({ id: 'edit', name: 'Edit', arguments: { path: 'order.csv', old_string: 'Aurora,98', new_string: 'Aurora,112' } });
  assert.equal(edit.is_error, false, edit.error_message);
  assert.deepEqual(await readFile(path.join(workspace, 'order.csv')), after);
});

test('multiline Edit maps a normalized search onto raw offsets without consuming the following CRLF', async () => {
  const { workspace, registry } = await fixture('multiline-lines');
  await writeFile(path.join(workspace, 'mixed.txt'), 'pre\r\nA\r\nB\r\npost\n');
  await registry.execute({ id: 'read', name: 'Read', arguments: { path: 'mixed.txt' } });
  const edit = await registry.execute({ id: 'edit', name: 'Edit', arguments: { path: 'mixed.txt', old_string: 'A\nB', new_string: 'X\nY' } });
  assert.equal(edit.is_error, false, edit.error_message);
  assert.deepEqual(await readFile(path.join(workspace, 'mixed.txt')), Buffer.from('pre\r\nX\nY\r\npost\n'));
});
