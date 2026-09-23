import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { explorerContextFromEvidence, SurfaceAdapterRegistry } from '../electron/runtime/desktop_adapters';
import { perceiveFrozenFrame } from '../electron/runtime/desktop_perception';
import { prepareTaskContext } from '../electron/runtime/context_prepare';
import { taskSources } from '../electron/runtime/context';
import { EventSession } from '../electron/runtime/session';
import { ToolRegistry } from '../electron/runtime/tools';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mp-explorer-selection-'));
  try {
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([300, 200]).drawText('Selected document body', { x: 20, y: 150, font });
    const selectedPath = join(root, 'selected.pdf'), neighborPath = join(root, 'neighbor.pdf'), outsidePath = join(root, 'outside.pdf');
    await writeFile(selectedPath, await pdf.save());
    await writeFile(neighborPath, await pdf.save());
    await writeFile(outsidePath, await pdf.save());
    const window = { hwnd: 42, pid: 7, process_name: 'explorer.exe', title: 'Files', class_name: 'CabinetWClass', bbox: [0, 0, 400, 300] as [number, number, number, number] };
    const context = explorerContextFromEvidence(window, {
      folder_path: root,
      selected_paths: [],
      items: [{ name: 'selected.pdf', path: selectedPath }, { name: 'neighbor.pdf', path: neighborPath }],
    }, [
      { role: 'listitem', name: 'selected.pdf', rect: [10, 10, 130, 40] },
      { role: 'listitem', name: 'neighbor.pdf', rect: [10, 50, 130, 80] },
    ], { region: { x: 20, y: 15, width: 80, height: 20 } });
    assert.equal(context.artifacts.selected_item.path, selectedPath);
    assert.deepEqual(context.artifacts.selected_paths, [selectedPath]);
    const session = await EventSession.open(root, 'explorer-document');
    const registry = new ToolRegistry();
    await prepareTaskContext(session, { selectionSnapshot: { snapshot_id: 'explorer-selection', context, source_window: window } }, { root, userDataDir: root, registry });
    const source = taskSources(session.events).find(item => item.identity.absolutePath === selectedPath && item.kind === 'document');
    assert.ok(source, 'the selected native file should become a document SourceRef');
    assert.equal(taskSources(session.events).some(item => item.identity.absolutePath === neighborPath), false);
    const read = await registry.execute({ id: 'read-selected', name: 'Context.read', arguments: { source_id: source.sourceId } });
    assert.equal(read.is_error, false, read.error_message);
    assert.match(JSON.stringify(read.value), /Selected document body/);

    const multiData = {
      folder_path: root,
      selected_paths: [],
      items: [
        { name: 'selected.pdf', path: selectedPath },
        { name: 'neighbor.pdf', path: neighborPath },
        { name: 'outside.pdf', path: outsidePath },
      ],
    };
    const multiElements = [
      { role: 'listitem', name: 'selected.pdf', rect: [10, 10, 130, 40] },
      { role: 'listitem', name: 'outside.pdf', rect: [10, 50, 130, 80] },
      { role: 'listitem', name: 'neighbor.pdf', rect: [10, 100, 130, 130] },
    ];
    const multiRequest = {
      region: { x: 20, y: 15, width: 80, height: 110 },
      gesture: { strokes: [
        { points: [{ x: 20, y: 15 }, { x: 100, y: 35 }] },
        { points: [{ x: 20, y: 105 }, { x: 100, y: 125 }] },
      ] },
    };
    const multi = explorerContextFromEvidence(window, multiData, multiElements, multiRequest);
    assert.deepEqual(multi.artifacts.selected_paths, [selectedPath, neighborPath]);
    assert.deepEqual(multi.artifacts.selected_items.map((item: { path: string }) => item.path), [selectedPath, neighborPath]);
    assert.equal(multi.content.includes(outsidePath), false, 'an unmarked folder item must not become selected text');
    const multiSession = await EventSession.open(root, 'explorer-multi-document');
    const multiRegistry = new ToolRegistry();
    await prepareTaskContext(multiSession, { selectionSnapshot: { snapshot_id: 'explorer-multi-selection', context: multi, source_window: window } }, { root, userDataDir: root, registry: multiRegistry });
    const selectedSources = taskSources(multiSession.events).filter(item => [selectedPath, neighborPath, outsidePath].includes(String(item.identity.absolutePath || '')));
    assert.deepEqual(selectedSources.map(item => item.identity.absolutePath), [selectedPath, neighborPath]);
    for (const selectedSource of selectedSources) {
      const result = await multiRegistry.execute({ id: `read-${selectedSource.sourceId}`, name: 'Context.read', arguments: { source_id: selectedSource.sourceId } });
      assert.equal(result.is_error, false, result.error_message);
      assert.match(JSON.stringify(result.value), /Selected document body/);
    }
    const framePath = join(root, 'frame.png');
    await sharp({ create: { width: 400, height: 300, channels: 4, background: '#fff' } }).png().toFile(framePath);
    const fused = await perceiveFrozenFrame({
      frameLeaseId: 'explorer-multi-frame',
      localArtifact: { path: framePath, width: 400, height: 300 },
      surfaceBoundsPx: [0, 0, 400, 300],
      capturedAtUtc: new Date().toISOString(),
      targetWindow: window,
      gesture: { ...multiRequest.gesture, coordinateSpace: 'physical_screen_pixels' },
    }, {}, undefined, new SurfaceAdapterRegistry(), {
      nativeWindow: async () => window,
      selection: async (_window, request) => [explorerContextFromEvidence(window, multiData, multiElements, request)],
      ocr: async () => ({ blocks: [], text: '', usedBackend: 'fixture.ocr' }),
    });
    assert.deepEqual(fused.context.artifacts.selected_paths, [selectedPath, neighborPath], 'frame-only gesture must keep separate marked files');
  } finally { await rm(root, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
