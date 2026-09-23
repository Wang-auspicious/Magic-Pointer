import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DocumentReader } from '../electron/runtime/context_documents';
import { fileSource } from '../electron/runtime/context';

test('PDF search returns one page when query terms occur in separate text items on that page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-pdf-page-search-'));
  const path = join(root, 'clauses.pdf');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([400, 300]);
  first.drawText('alpha', { x: 40, y: 240, font, size: 14 });
  first.drawText('beta', { x: 40, y: 190, font, size: 14 });
  const second = pdf.addPage([400, 300]);
  second.drawText('alpha', { x: 40, y: 240, font, size: 14 });
  await writeFile(path, await pdf.save());

  const reader = new DocumentReader();
  const source = fileSource('pdf-search', path);
  const result = await reader.read(source, {
    query: 'alpha beta',
  });
  assert.equal(result.fragments.length, 1);
  assert.equal(result.fragments[0]!.locator.kind, 'pdf-region');
  assert.equal(result.fragments[0]!.locator.value.pageIndex, 0);
  assert.equal(result.fragments[0]!.locator.value.searchAggregate, 'pdf-page');
  assert.match(result.fragments[0]!.text, /alpha/);
  assert.match(result.fragments[0]!.text, /beta/);
  assert.equal(result.fragments[0]!.metadata.searchAggregate, 'pdf-page');
  assert.equal(result.coverage.extent, 'query-results');
  const neighborhood = await reader.read(source, {
    locator: result.fragments[0]!.locator,
    limit: 3,
  });
  assert.ok(neighborhood.fragments.some((fragment) => fragment.text.includes('beta')));
  const exactItem = (await reader.read(source, { limit: 1 })).fragments[0]!;
  const wrongRegion = await reader.read(source, {
    locator: {
      kind: 'pdf-region',
      value: { ...exactItem.locator.value, rectPt: [999, 999, 1000, 1000] },
    },
  });
  assert.equal(wrongRegion.fragments.length, 0);
});

test('ordinary PDF reading reaches the end of a long page and continues by page', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mp-pdf-page-read-'));
  const path = join(root, 'long-terms.pdf');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([500, 900]);
  for (let line = 1; line <= 35; line++)
    first.drawText(`Clause ${line}: service terms on the opening page`, { x: 40, y: 870 - line * 20, font, size: 12 });
  const second = pdf.addPage([500, 900]);
  second.drawText('Termination clause on the second page', { x: 40, y: 820, font, size: 12 });
  await writeFile(path, await pdf.save());

  const reader = new DocumentReader();
  const source = fileSource('pdf-page-read', path);
  const defaultRead = await reader.read(source);
  assert.ok(defaultRead.fragments.some(fragment => fragment.text.includes('Clause 35:')),
    'default read stopped at the first 20 text items');
  const firstPage = await reader.read(source, { limit: 1 });
  assert.equal(firstPage.fragments.length, 1);
  assert.equal(firstPage.fragments[0]!.locator.value.pageIndex, 0);
  assert.match(firstPage.fragments[0]!.text, /Clause 35:/);
  const located = await reader.read(source, { locator: firstPage.fragments[0]!.locator, limit: 1 });
  assert.match(located.fragments[0]!.text, /Clause 35:/);
  assert.ok(firstPage.coverage.nextCursor);
  const nextPage = await reader.read(source, { cursor: firstPage.coverage.nextCursor, limit: 1 });
  assert.equal(nextPage.fragments[0]!.locator.value.pageIndex, 1);
  assert.match(nextPage.fragments[0]!.text, /Termination clause/);
  assert.equal(nextPage.coverage.complete, true);
  assert.equal(nextPage.coverage.nextCursor, null);
  assert.equal(nextPage.usedBackend, 'document.pdf.pdfjs');
  t.diagnostic(`usedBackend=${nextPage.usedBackend}; latencyMs=${[defaultRead.latencyMs, firstPage.latencyMs, nextPage.latencyMs].map(value => value.toFixed(1)).join('/')}`);
});

test('mixed-language clause search and located read keep the target page and following clause in view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-pdf-clause-search-'));
  const path = join(root, 'agreement.pdf');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 40; pageNumber++) {
    const page = pdf.addPage([500, 900]);
    if (pageNumber === 36)
      for (let line = 1; line <= 25; line++)
        page.drawText(`Previous section line ${line}`, { x: 40, y: 870 - line * 25, font, size: 12 });
    if (pageNumber === 37) {
      page.drawText('Service provider liability cap applies', { x: 40, y: 820, font, size: 12 });
      page.drawText('Notice of claim within thirty days', { x: 40, y: 780, font, size: 12 });
      for (let line = 1; line <= 25; line++)
        page.drawText(`Target page context ${line}`, { x: 40, y: 760 - line * 25, font, size: 12 });
    }
    if (pageNumber === 38)
      page.drawText('Liability shall not exceed fees paid', { x: 40, y: 820, font, size: 12 });
  }
  await writeFile(path, await pdf.save());

  const reader = new DocumentReader();
  const source = fileSource('pdf-clause-search', path);
  const result = await reader.read(source, { query: '责任限制 liability limitation cap' });
  assert.equal(result.fragments[0]?.locator.value.pageIndex, 36);
  assert.match(result.fragments[0]!.text, /liability cap/i);
  const neighborhood = await reader.read(source, { locator: result.fragments[0]!.locator });
  assert.ok(neighborhood.fragments.some(fragment => fragment.text.includes('Notice of claim')));
  assert.ok(neighborhood.fragments.some(fragment => fragment.text.includes('Liability shall not exceed')));
});
