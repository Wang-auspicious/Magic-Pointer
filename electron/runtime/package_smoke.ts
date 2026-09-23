import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createOfficeFile } from './actions';
import { DocumentReader } from './context_documents';
import { fileSource } from './context';
import { configureDesktop, desktopDataRoot, nativeRequest, closeDesktop, ensureNativeTool, registerDesktopTools } from './desktop';
import { registerPerceptionTools, registerLookTool, closeOcr } from './desktop_perception';
import { ToolRegistry } from './tools';
import { dispatchRuntime } from './worker';
import type { PatchOperation } from './artifacts';

export async function packageSmoke(root: string, userDataDir: string): Promise<Record<string, unknown>> {
  configureDesktop(root); process.env.MAGIC_POINTER_USER_DATA_DIR = userDataDir;
  const { mkdir } = await import('node:fs/promises'); await mkdir(userDataDir, { recursive: true });
  const temporary = await mkdtemp(join(userDataDir, 'document-fixtures-')), reader = new DocumentReader(), documents: Record<string, unknown> = {};
  try {
    for (const format of ['docx', 'xlsx', 'pptx']) {
      const path = join(temporary, `fixture.${format}`), text = `Package fixture ${format}`;
      const content = format === 'xlsx' ? { sheets: [{ name: 'Data', rows: [[text, 42]] }] } : format === 'pptx' ? { slides: [{ title: text, paragraphs: ['Native package readback'] }] } : { title: text, paragraphs: ['Native package readback'] };
      await createOfficeFile({ operationId: `smoke-${format}`, operation: 'create_file', sourceId: 'package-smoke', referenceId: 'package-smoke', locator: { kind: 'directory', value: { path: temporary } }, before: { path, exists: false }, after: { path, exists: true, format, content } } as PatchOperation);
      const result = await reader.read(fileSource('package-smoke', path)); if (!result.fragments.some(fragment => fragment.text.includes(text))) throw new Error(`document_fixture_readback_failed:${format}`);
      documents[format] = { fragments: result.fragments.length, backend: result.usedBackend };
    }
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica); pdf.addPage().drawText('Package PDF fixture', { x: 30, y: 500, font }); const pdfPath = join(temporary, 'fixture.pdf'); await writeFile(pdfPath, await pdf.save());
    const pdfResult = await reader.read(fileSource('package-smoke', pdfPath)); if (!pdfResult.fragments.some(fragment => fragment.text.includes('Package PDF fixture'))) throw new Error('document_fixture_readback_failed:pdf'); documents.pdf = { fragments: pdfResult.fragments.length, backend: pdfResult.usedBackend };
    const pixels = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer(); if ((await sharp(pixels).metadata()).width !== 2) throw new Error('sharp_native_readback_failed');
    const registry = new ToolRegistry(); registerDesktopTools(registry); registerPerceptionTools(registry, { snapshot: {} }); registerLookTool(registry, { snapshot: {} }); registry.get('look'); registry.get('get_app_state');
    const worker = await dispatchRuntime('fabric', { operation: 'settings.get' }, { root, userDataDir }); if (!worker.ok) throw new Error('node_worker_dispatch_failed');
    const native = process.platform === 'win32' ? { executable: await ensureNativeTool(), ping: await nativeRequest('ping') } : { unsupportedPlatform: process.platform };
    return { ok: true, executable: process.execPath, node: process.versions.node, dependencies: ['sharp', 'pdf-lib', 'pdfjs-dist', 'adm-zip', 'fast-xml-parser'], documents, tools: registry.list().length, worker: { ok: worker.ok }, native, writableRuntime: desktopDataRoot() };
  } finally { closeOcr(); closeDesktop(); await rm(temporary, { recursive: true, force: true }); }
}
if (require.main === module) void packageSmoke(resolve(process.argv[2]), resolve(process.env.MAGIC_POINTER_USER_DATA_DIR || process.argv[3])).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode = 1; });
