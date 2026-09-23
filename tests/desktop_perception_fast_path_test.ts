const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const sharp = require('sharp');
const { perceiveFrozenFrame, closeOcr } = require('../electron/runtime/desktop_perception');
const { closeDesktop } = require('../electron/runtime/desktop');
const { officeSelectionError } = require('../electron/runtime/desktop_adapters');

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mp-perception-'));
  const path = join(root, 'frame.png');
  await writeFile(path, await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } }).png().toBuffer());
  const frame = { frameLeaseId: 'frame-1', localArtifact: { path, width: 10, height: 10 }, surfaceBoundsPx: [0, 0, 10, 10], capturedAtUtc: new Date().toISOString(), targetWindow: { hwnd: 42, processId: 7, processName: 'demo.exe', title: 'Demo', bbox: [1, 1, 9, 9] }, gesture: {} };
  const window = { hwnd: 42, pid: 7, processStartTime: '', process_name: 'demo.exe', title: 'Demo', bbox: [1, 1, 9, 9] };
  const abort = new AbortController();
  let ocrCancelled = false;
  const providers = {
    nativeWindow: async () => window,
    selection: async () => [{ adapter: 'office', app: 'demo.exe', window, content: 'Selected text', method: 'office:com', artifacts: {} }],
    ocr: (_path: string, options: { signal: AbortSignal }) => new Promise((_accept, reject) => options.signal.addEventListener('abort', () => { ocrCancelled = true; reject(new Error('cancelled')); }, { once: true })),
  };
  try {
    const result = await Promise.race([
      perceiveFrozenFrame(frame, {}, abort.signal, { resolve: async () => [] }, providers),
      new Promise((_accept, reject) => setTimeout(() => reject(new Error('structured_perception_waited_for_ocr')), 1000)),
    ]);
    assert.equal(result.content, 'Selected text');
    assert.equal(result.context.adapter, 'office');
    assert.equal(ocrCancelled, true);
    const fallback = await perceiveFrozenFrame(frame, {}, abort.signal, { resolve: async () => [] }, {
      ...providers,
      selection: async () => [],
      ocr: async () => ({ blocks: [{ text: 'Visible from OCR', rect: [1, 1, 8, 8] }] }),
    });
    assert.equal(fallback.content, 'Visible from OCR');
    assert.equal(fallback.context.adapter, 'pixel-ocr');
    assert.equal(officeSelectionError('powerpoint', ['No shape selection; returned current slide structure.']), null,
      'reading the current slide without a selected shape is useful document evidence');
    assert.match(officeSelectionError('powerpoint', ['No shape selection; returned current slide structure.', 'COM read failed']), /COM read failed/,
      'a real PowerPoint probe failure must remain an error');
    for (const { app, process, reason } of [
      { app: 'word', process: 'WINWORD.EXE', reason: 'unbound_word_selection' },
      { app: 'powerpoint', process: 'POWERPNT.EXE', reason: 'unbound_powerpoint_selection' },
    ]) {
      const document = `C:\\Documents\\current.${app === 'word' ? 'docx' : 'pptx'}`;
      const markedOffice = { ...frame, targetWindow: { ...frame.targetWindow, processName: process }, gesture: { coordinateSpace: 'physical_screen_pixels', strokes: [{ points: [{ x: 2, y: 4 }, { x: 8, y: 4 }] }] } };
      const staleSelection = await perceiveFrozenFrame(markedOffice, {}, abort.signal, { resolve: async () => [] }, {
        nativeWindow: async () => ({ ...window, process_name: process }),
        selection: async () => [{ adapter: 'office', app, window: { ...window, process_name: process }, content: 'Old selection B', method: `com:${app}.selection`, artifacts: { hwnd: 42, document, document_saved: false, source_identity: { absolutePath: document, hwnd: 42, host: `microsoft_${app}` }, selection_start: 10, selection_end: 25, locators: [{ kind: 'text', value: { start: 10, end: 25 } }] } }],
        ocr: async () => ({ blocks: [] }),
      });
      assert.equal(staleSelection.context.adapter, 'pixel-ocr', `an unbound ${app} selection cannot claim the marked line`);
      assert.equal(staleSelection.content, '');
      assert.equal(staleSelection.structured_covers_mark, false);
      assert.equal(staleSelection.structured_gap_reason, reason);
      assert.equal(staleSelection.structured_contexts.some((context: { adapter: string; app: string }) => context.adapter === 'office' && context.app === app), false, 'unbound historical Office selection must not become a pointed document source');
      assert.equal(staleSelection.perception_trace.observations.some((observation: { adapter: string; app: string }) => observation.adapter === 'office' && observation.app === app), false, 'unbound Office text must not enter model input facts');
      assert.equal(staleSelection.perception_trace.attempts.some((attempt: { reason: string }) => attempt.reason === reason), true, 'binding failure stays visible in diagnostics');
      assert.deepEqual(staleSelection.office_document_sources, [{ app, document, document_saved: false, hwnd: 42, pid: 7, process_name: process }], 'the verified document remains available for live read without treating its old selection as the marked target');
    }
    const newDeckFrame = { ...frame,
      targetWindow: { ...frame.targetWindow, processName: 'POWERPNT.EXE' },
      gesture: { coordinateSpace: 'physical_screen_pixels', strokes: [{ points: [{ x: 2, y: 4 }, { x: 8, y: 4 }] }] } };
    const newDeck = await perceiveFrozenFrame(newDeckFrame, {}, abort.signal, { resolve: async () => [] }, {
      nativeWindow: async () => ({ ...window, process_name: 'POWERPNT.EXE' }),
      selection: async () => [{ adapter: 'office', app: 'powerpoint', window: { ...window, process_name: 'POWERPNT.EXE' },
        content: 'Current slide', method: 'com:powerpoint.selection', artifacts: { hwnd: 42, document: 'Presentation1',
          document_saved: false, source_identity: { documentName: 'Presentation1', hwnd: 42, host: 'microsoft_powerpoint' } } }],
      ocr: async () => ({ blocks: [] }),
    });
    assert.deepEqual(newDeck.office_document_sources,
      [{ app: 'powerpoint', document: 'Presentation1', document_saved: false, hwnd: 42, pid: 7, process_name: 'POWERPNT.EXE' }],
      'a never-saved presentation retains a live document source without a false disk path');
    const markedFrame = { ...frame, gesture: { coordinateSpace: 'physical_screen_pixels', strokes: [{ points: [{ x: 2, y: 4 }, { x: 8, y: 4 }] }] } };
    const unboundUia = await perceiveFrozenFrame(markedFrame, {}, abort.signal, { resolve: async () => [] }, {
      nativeWindow: async () => window,
      selection: async () => [{ adapter: 'uia', app: 'demo.exe', window, content: 'Text from elsewhere', method: 'uia:selection', artifacts: { rectangles: [[1, 7, 8, 2]] } }],
      ocr: async () => ({ blocks: [] }),
    });
    assert.equal(unboundUia.structured_covers_mark, false);
    assert.deepEqual(unboundUia.structured_contexts, []);
    assert.deepEqual(unboundUia.perception_trace.observations, []);
  } finally { abort.abort(); closeOcr(); closeDesktop(); await rm(root, { recursive: true, force: true }); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
