const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const sharp = require('sharp');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { recoverPdfSelection } = require('../electron/runtime/desktop_sources');

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mp-pdf-highlight-'));
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([200, 100]).drawText('MAGIC', { x: 20, y: 60, size: 20, font });
    const pdfPath = join(root, 'selection.pdf');
    await writeFile(pdfPath, await pdf.save());
    for (const [name, color] of [['yellow', '#ffe84a'], ['gray', '#a0a0a0'], ['blue', '#3875d7']]) {
      const path = join(root, `${name}.png`);
      const highlight = Buffer.from(`<svg width="200" height="100"><rect x="20" y="18" width="80" height="26" fill="${color}"/></svg>`);
      await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } }).composite([{ input: highlight }]).png().toFile(path);
      const frame = { localArtifact: { path }, surfaceBoundsPx: [0, 0, 200, 100] };
      const recovered = await recoverPdfSelection({ document_location: pdfPath, page_number: 1, page_rect: [0, 0, 200, 100], rectangles: [[20, 18, 80, 26]], text: 'MAGIC', range_count: 1 }, frame);
      assert.equal(recovered.ok, true, `${name}: ${recovered.error || ''}`);
      assert.equal(recovered.text, 'MAGIC');
    }
    const twoLines = await PDFDocument.create();
    const page = twoLines.addPage([200, 100]);
    page.drawText('FIRST', { x: 20, y: 60, size: 20, font: await twoLines.embedFont(StandardFonts.Helvetica) });
    page.drawText('SECOND', { x: 20, y: 30, size: 20, font: await twoLines.embedFont(StandardFonts.Helvetica) });
    const twoLinePath = join(root, 'two-lines.pdf');
    await writeFile(twoLinePath, await twoLines.save());
    const partialPath = join(root, 'only-second-line-visible.png');
    const partialHighlight = Buffer.from('<svg width="200" height="100"><rect x="20" y="48" width="100" height="26" fill="#ffe84a"/></svg>');
    await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } }).composite([{ input: partialHighlight }]).png().toFile(partialPath);
    const partial = await recoverPdfSelection({ document_location: twoLinePath, page_number: 1, page_rect: [0, 0, 200, 100], rectangles: [[20, 18, 80, 26], [20, 48, 100, 26]], text: 'FIRST SECOND', range_count: 1 }, { localArtifact: { path: partialPath }, surfaceBoundsPx: [0, 0, 200, 100] });
    assert.equal(partial.ok, false, 'A visible tail of a multi-line selection is not the full selection');
    assert.equal(partial.error, 'pdf_selection_uia_disagreement');
  } finally { await rm(root, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
