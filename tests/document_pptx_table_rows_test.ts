import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { DocumentReader } from '../electron/runtime/context_documents';
import { fileSource } from '../electron/runtime/context';

test('PowerPoint table preserves row and cell structure beside ordinary text shapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-pptx-table-'));
  const path = join(root, 'quarterly.pptx');
  const presentation = new PptxGenJS();
  const slide = presentation.addSlide();
  slide.addText('Quarterly results', { x: 0.5, y: 0.3, w: 5, h: 0.5 });
  slide.addTable(
    [
      ['Region', 'Q1', 'Q2'],
      ['North', '10', '15'],
      ['South', '20', '25'],
    ].map((row) => row.map((text) => ({ text }))),
    { x: 0.5, y: 1, w: 6, h: 2 },
  );
  await presentation.writeFile({ fileName: path });

  const reader = new DocumentReader();
  const source = fileSource('pptx-table', path);
  const result = await reader.read(source);
  const rows = result.fragments.filter((fragment) => fragment.metadata.contentKind === 'table');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.metadata.cells), [
    ['Region', 'Q1', 'Q2'],
    ['North', '10', '15'],
    ['South', '20', '25'],
  ]);
  assert.deepEqual(rows.map((row) => row.locator.value.tableRowIndex), [0, 1, 2]);
  assert.ok(rows.every((row) => row.locator.value.shapeId === rows[0]!.locator.value.shapeId));
  assert.ok(result.fragments.some((fragment) => fragment.text === 'Quarterly results' && fragment.metadata.contentKind === 'text'));

  const matched = await reader.read(source, { query: 'South 25' });
  assert.equal(matched.fragments.length, 1);
  assert.deepEqual(matched.fragments[0]!.metadata.cells, ['South', '20', '25']);
  assert.equal(matched.fragments[0]!.locator.value.tableRowIndex, 2);
});
