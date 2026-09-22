import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import sharp from 'sharp';
import { desktopRuntimeRoot, desktopDataRoot, probeSelection, listWindows, listElements, nativeRequest, captureSurface, type DesktopRecord, type DesktopWindow, type Rect } from './desktop';
import { resolveSelection, surfaceAdapters, readOffice, readBrowser, readChat, type AdapterContext } from './desktop_adapters';
import { ActionFailure, type ToolRegistry } from './tools';
import { requestVision, type ModelConfig } from './model';

export type EvidenceStatus = 'ok' | 'degraded' | 'empty_confirmed' | 'busy' | 'timeout' | 'unsupported' | 'denied' | 'error';
export interface Evidence { value: string | null; status: EvidenceStatus; confidence: number; source: string; latency_ms?: number; captured_at_utc?: string; container_hint?: boolean; note?: string }
export interface OcrBlock { text: string; rect: Rect; confidence?: number | null }
export interface FrozenFrame extends DesktopRecord { frameLeaseId: string; localArtifact: { path: string; width: number; height: number }; surfaceBoundsPx: Rect; capturedAtUtc: string; targetWindow: DesktopRecord; gesture: DesktopRecord; contentHash?: string }

let ocrChild: ChildProcessWithoutNullStreams | undefined;
let ocrIdle: NodeJS.Timeout | undefined;
const ocrPending = new Map<string, { accept(value: DesktopRecord): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
export function closeOcr(): void { if (ocrIdle) clearTimeout(ocrIdle); ocrIdle = undefined; ocrChild?.kill(); ocrChild = undefined; for (const pending of ocrPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('ocr_worker_closed')); } ocrPending.clear(); }
async function ocrRequest(path: string, language: string, signal?: AbortSignal): Promise<DesktopRecord> {
  signal?.throwIfAborted(); if (ocrIdle) clearTimeout(ocrIdle);
  if (!ocrChild || ocrChild.killed) {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(desktopRuntimeRoot(), 'scripts', 'desktop_ocr.ps1'), '-Resident'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); ocrChild = child;
    let buffer = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { buffer += chunk; let position: number; while ((position = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, position); buffer = buffer.slice(position + 1); try { const response = JSON.parse(line.replace(/^\uFEFF/, '')); const pending = ocrPending.get(response.id); if (!pending) continue; ocrPending.delete(response.id); clearTimeout(pending.timer); if (response.error) pending.reject(new Error(response.error)); else pending.accept(response.result); if (!ocrPending.size) { ocrIdle = setTimeout(closeOcr, 60000); ocrIdle.unref(); } } catch { closeOcr(); } } });
    child.stderr.on('data', () => {}); child.on('error', () => { if (ocrChild === child) closeOcr(); }); child.on('exit', () => { if (ocrChild === child) closeOcr(); });
  }
  return new Promise((accept, reject) => {
    const id = randomUUID(); const abort = () => { const item = ocrPending.get(id); if (!item) return; clearTimeout(item.timer); ocrPending.delete(id); reject(signal?.reason || new Error('aborted')); };
    const timer = setTimeout(() => { ocrPending.delete(id); signal?.removeEventListener('abort', abort); reject(new Error('ocr_timeout')); if (!ocrPending.size) closeOcr(); }, 20000);
    ocrPending.set(id, { accept: value => { signal?.removeEventListener('abort', abort); accept(value); }, reject: error => { signal?.removeEventListener('abort', abort); reject(error); }, timer });
    signal?.addEventListener('abort', abort, { once: true }); ocrChild!.stdin.write(`${JSON.stringify({ id, path, language })}\n`);
  });
}

export function evidence(value: string | null, status: EvidenceStatus, source: string, confidence = status === 'ok' ? 1 : 0, extras: Partial<Evidence> = {}): Evidence {
  if (confidence < 0 || confidence > 1 || !Number.isFinite(confidence) || status === 'ok' && (value === null || confidence < 0.5)) throw new Error('invalid_evidence');
  return { value, status, source, confidence, ...extras };
}
export function mergeEvidence(values: Evidence[]): Evidence {
  const good = values.filter(item => item.status === 'ok' && !item.container_hint && item.value);
  if (good.length) { const first = good[0]; const conflict = good.some(item => !textsAgree(first.value || '', item.value || '')); return { ...first, status: conflict ? 'degraded' : 'ok', confidence: conflict ? 0.4 : first.confidence, note: conflict ? 'conflicting_evidence' : first.note }; }
  return values.find(item => item.value && !item.container_hint) || values.find(item => item.status !== 'empty_confirmed') || evidence(null, 'empty_confirmed', 'fusion');
}
export function textsAgree(left: string, right: string): boolean {
  const clean = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' '); const a = clean(left), b = clean(right);
  if (!a || !b || a === b) return true;
  const numbers = (value: string) => [...value.matchAll(/[+\-−]?\d+(?:[.,]\d+)*/g)].map(match => match[0].replace('−', '-').replace(/^\+/, ''));
  if (JSON.stringify(numbers(a)) !== JSON.stringify(numbers(b))) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const grams = (value: string) => new Set([...value.replaceAll(' ', '')].slice(1).map((_, index) => value.replaceAll(' ', '').slice(index, index + 2)));
  const x = grams(a), y = grams(b); return [...x].filter(value => y.has(value)).length / Math.max(1, new Set([...x, ...y]).size) >= 0.6;
}
export function rectIntersection(a: Rect, b: Rect): Rect | null { const r: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]; return r[2] > r[0] && r[3] > r[1] ? r : null; }
export function subtractRectangle(base: Rect, cutter: Rect): Rect[] { const cut = rectIntersection(base, cutter); if (!cut) return [base]; return [[base[0], base[1], base[2], cut[1]], [base[0], cut[3], base[2], base[3]], [base[0], cut[1], cut[0], cut[3]], [cut[2], cut[1], base[2], cut[3]]].filter(row => row[2] > row[0] && row[3] > row[1]) as Rect[]; }
export async function buildScreenContext(selection: Rect, imagePath?: string, signal?: AbortSignal): Promise<DesktopRecord> {
  const area = (rect: Rect) => Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]), windows: DesktopRecord[] = [], above: Rect[] = [];
  for (const window of await listWindows(signal)) {
    if (/^Magic Pointer(?:$| - | Open$| Overlay$| Panel$| Reader$| Result$)/.test(window.title)) continue;
    const clipped = rectIntersection(selection, window.bbox); if (!clipped) continue;
    let visible = [clipped]; for (const cover of above) visible = visible.flatMap(rect => subtractRectangle(rect, cover));
    const visibleArea = visible.reduce((sum, rect) => sum + area(rect), 0), intersection = area(clipped);
    windows.push({ ...window, index: windows.length + 1, clipped_bbox: clipped, intersection_area: intersection, selection_coverage: intersection / Math.max(1, area(selection)), window_coverage: intersection / Math.max(1, area(window.bbox)), estimated_visible_area: visibleArea, estimated_visible_selection_coverage: visibleArea / Math.max(1, area(selection)) }); above.push(clipped);
  }
  let annotated_image_path: string | null = null;
  if (imagePath && windows.length) {
    const metadata = await sharp(imagePath).metadata(), colors = ['#4285f4', '#34a853', '#fbbc05', '#ea4335', '#ab47bc', '#00acc1'];
    const shapes = windows.slice(0, 12).map((window, index) => { const r = window.clipped_bbox, x = r[0] - selection[0], y = r[1] - selection[1], color = colors[index % colors.length]; return `<rect x="${x}" y="${y}" width="${r[2] - r[0]}" height="${r[3] - r[1]}" fill="none" stroke="${color}" stroke-width="3"/><rect x="${x + 4}" y="${y + 4}" width="24" height="22" rx="5" fill="${color}"/><text x="${x + 10}" y="${y + 21}" fill="white" font-size="16">${index + 1}</text>`; }).join('');
    annotated_image_path = imagePath.replace(/\.[^.]+$/, '') + '.objects.png'; await sharp(imagePath).composite([{ input: Buffer.from(`<svg width="${metadata.width}" height="${metadata.height}">${shapes}</svg>`) }]).png().toFile(annotated_image_path);
  }
  return { selection_bbox: selection, windows, annotated_image_path };
}
const xywhToLtrb = (r: Rect): Rect => [r[0], r[1], r[0] + r[2], r[1] + r[3]];
function validRect(value: unknown): value is Rect { return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > 0 && value[3] > 0; }
function unionBoxes(rects: Rect[]): Rect { const l = Math.min(...rects.map(row => row[0])), t = Math.min(...rects.map(row => row[1])); return [l, t, Math.max(...rects.map(row => row[0] + row[2])) - l, Math.max(...rects.map(row => row[1] + row[3])) - t]; }
export function gestureStrokes(gesture: DesktopRecord = {}): [number, number][][] {
  return (gesture.strokes?.length ? gesture.strokes : gesture.points?.length ? [{ points: gesture.points }] : []).slice(0, 8).map((stroke: DesktopRecord) => (stroke.geometry?.type === 'polygon_region' && stroke.geometry?.coordinateSpace === 'physical_screen_pixels' ? stroke.geometry.ring : stroke.points || []).slice(0, 256).map((point: DesktopRecord) => [Number(point.x), Number(point.y)]).filter((point: number[]) => point.every(Number.isFinite))).filter((stroke: unknown[]) => stroke.length >= 2);
}
export function selectOpenStroke(rectangles: Rect[], stroke: [number, number][], tolerance = 14): number[] {
  const scored: { index: number; rect: Rect; cost: number }[] = [];
  rectangles.forEach((rect, index) => {
    if (!validRect(rect)) return; const [x, top, width, height] = rect, bottom = top + height; const samples: number[] = [];
    for (let i = 1; i < stroke.length; i++) { const [ax, ay] = stroke[i - 1], [bx, by] = stroke[i]; const left = Math.max(x - tolerance, Math.min(ax, bx)), right = Math.min(x + width + tolerance, Math.max(ax, bx)); if (left > right) continue; if (ax === bx) samples.push(ay, by); else for (const px of [left, (left + right) / 2, right]) samples.push(ay + (by - ay) * (px - ax) / (bx - ax)); }
    const costs = samples.filter(y => y >= top - tolerance && y <= bottom + tolerance).map(y => y < top ? top - y + 10 : y > bottom ? y - bottom : y <= top + Math.max(2, Math.min(4, height * 0.12)) ? 10 - (y - top) : -Math.min(y - top, bottom - y));
    if (costs.length) scored.push({ index, rect, cost: Math.min(...costs) });
  });
  scored.sort((a, b) => a.cost - b.cost || a.rect[1] - b.rect[1] || a.index - b.index);
  if (!scored.length) return []; const best = scored[0].rect;
  return scored.filter(row => Math.abs(row.rect[1] - best[1]) <= Math.max(4, Math.min(row.rect[3], best[3]) * 0.35)).map(row => row.index).sort((a, b) => a - b);
}
export function selectOcrBlocks(blocks: OcrBlock[], gesture: DesktopRecord): { selected: OcrBlock[]; segments: OcrBlock[][] } {
  const strokes = gestureStrokes(gesture); if (!strokes.length) return { selected: blocks, segments: [blocks] };
  const selected = new Set<OcrBlock>(); const segments: OcrBlock[][] = [];
  for (const stroke of strokes) {
    const closed = stroke.length >= 5 && Math.hypot(stroke[0][0] - stroke.at(-1)![0], stroke[0][1] - stroke.at(-1)![1]) <= 26;
    const left = Math.min(...stroke.map(p => p[0])), top = Math.min(...stroke.map(p => p[1])), right = Math.max(...stroke.map(p => p[0])), bottom = Math.max(...stroke.map(p => p[1]));
    const indexes = closed ? blocks.map((block, index) => ({ block, index })).filter(({ block }) => { const [x, y, w, h] = block.rect; return x + w / 2 >= left - 22 && x + w / 2 <= right + 22 && y + h / 2 >= top - 22 && y + h / 2 <= bottom + 22; }).map(row => row.index) : selectOpenStroke(blocks.map(block => block.rect), stroke);
    const segment = indexes.map(index => blocks[index]); segments.push(segment); segment.forEach(block => selected.add(block));
  }
  return { selected: blocks.filter(block => selected.has(block)), segments };
}
export function ocrText(blocks: OcrBlock[]): string {
  const rows: { center: number; height: number; parts: string[] }[] = [];
  for (const block of [...blocks].sort((a, b) => Math.round(a.rect[1] / 22) - Math.round(b.rect[1] / 22) || a.rect[0] - b.rect[0])) { const center = block.rect[1] + block.rect[3] / 2; const row = [...rows].reverse().find(item => Math.abs(item.center - center) <= Math.max(8, Math.min(item.height, block.rect[3]) * 0.5)); if (row) { row.parts.push(block.text); row.center += (center - row.center) / row.parts.length; row.height = Math.max(row.height, block.rect[3]); } else rows.push({ center, height: block.rect[3], parts: [block.text] }); }
  return rows.map(row => row.parts.join(' ')).join('\n');
}
export function groupVisualElements(blocks: OcrBlock[], windowBounds?: Rect): DesktopRecord[] {
  const groups: OcrBlock[][] = [];
  for (const block of [...blocks].filter(row => validRect(row.rect) && row.text.trim()).sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
    const group = [...groups].reverse().find(rows => { if (rows.length >= 24) return false; const a = rows.at(-1)!.rect, b = block.rect; const gap = Math.max(0, b[1] - a[1] - a[3]); const overlap = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) / Math.max(1, Math.min(a[2], b[2])); return gap <= Math.min(a[3], b[3]) * 0.55 && overlap >= 0.35; });
    if (group) group.push(block); else groups.push([block]);
  }
  return groups.map(rows => ({ rect: unionBoxes(rows.map(row => row.rect)), text: rows.map(row => row.text).join('\n'), lineCount: rows.length, source: 'pixel' })).filter(row => !windowBounds || row.rect[2] <= (windowBounds[2] - windowBounds[0]) * 0.94).slice(0, 60);
}

export async function recognizeText(path: string, options: { bounds?: Rect; signal?: AbortSignal; language?: string } = {}): Promise<DesktopRecord> {
  const started = performance.now(), metadata = await sharp(path).metadata(), width = metadata.width || 0, height = metadata.height || 0;
  const bounds = options.bounds || [0, 0, width, height], blocks: OcrBlock[] = [], tileSize = 2500, overlap = 100;
  if (!width || !height) throw new Error('ocr_image_dimensions_missing');
  for (let top = 0; top < height; top += tileSize - overlap) for (let left = 0; left < width; left += tileSize - overlap) {
    options.signal?.throwIfAborted();
    const tile = { left, top, width: Math.min(tileSize, width - left), height: Math.min(tileSize, height - top) };
    let input = resolve(path), temporary: string | undefined;
    try {
      if (width > tileSize || height > tileSize) { temporary = join(desktopDataRoot(), `ocr-${randomUUID()}.png`); await mkdir(desktopDataRoot(), { recursive: true }); await sharp(path).extract(tile).png().toFile(temporary); input = temporary; }
      const data = await ocrRequest(input, options.language || 'zh-Hans', options.signal);
      for (const block of data.blocks || []) {
        const rect: Rect = [bounds[0] + left + block.rect[0], bounds[1] + top + block.rect[1], block.rect[2], block.rect[3]];
        if (!blocks.some(existing => existing.text === block.text && Math.abs(existing.rect[0] - rect[0]) < 8 && Math.abs(existing.rect[1] - rect[1]) < 8)) blocks.push({ ...block, rect });
      }
    } finally { if (temporary) await unlink(temporary).catch(() => {}); }
  }
  return { blocks, text: ocrText(blocks), usedBackend: 'windows-ocr', latencyMs: performance.now() - started, coordinateSpace: 'physical_screen_pixels' };
}

export function structuredCoverage(context: AdapterContext, mark?: Rect): { covers: boolean; reason: string } {
  const text = context.content.trim(); if (!text) return { covers: false, reason: 'no_structured_text' };
  if ([context.window.title, context.window.app, context.window.process_name, context.window.processName].some(value => value && String(value).trim().toLowerCase() === text.toLowerCase()) || /^[^\n]{0,260}[\\/][^\n]+\.(exe|app|dll)$/i.test(text)) return { covers: false, reason: 'identity_only' };
  if (!mark) return { covers: true, reason: 'structured_text' };
  const rects: Rect[] = context.artifacts.rectangles || (context.artifacts.region_elements || []).map((row: DesktopRecord) => row.rect) || [];
  if (!rects.length) return { covers: context.adapter === 'office' || context.adapter === 'explorer', reason: 'unbound_text' };
  const hits = rects.filter(rect => validRect(rect) && rectIntersection(xywhToLtrb(rect), xywhToLtrb(mark)));
  if (!hits.length) return { covers: false, reason: 'mark_crossed_no_element' };
  const height = context.window.bbox?.[3] - context.window.bbox?.[1];
  if (hits.some(rect => rect[3] > height * 0.5 && rect[3] > mark[3] * 6)) return { covers: false, reason: 'container_not_selection' };
  return { covers: true, reason: 'structured_text' };
}

export async function perceiveFrozenFrame(frame: FrozenFrame, request: DesktopRecord = {}, signal?: AbortSignal): Promise<DesktopRecord> {
  const started = performance.now(); const bytes = await readFile(frame.localArtifact.path); const metadata = await sharp(bytes).metadata();
  if (metadata.width !== frame.localArtifact.width || metadata.height !== frame.localArtifact.height) throw new Error('artifact_dimension_mismatch');
  if (frame.contentHash?.startsWith('sha256:') && frame.contentHash !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`) throw new Error('artifact_hash_mismatch');
  const window = { ...frame.targetWindow, hwnd: Number(frame.targetWindow.hwnd), title: String(frame.targetWindow.title || ''), pid: frame.targetWindow.pid || frame.targetWindow.processId, process_name: frame.targetWindow.process_name || frame.targetWindow.processName, bbox: frame.surfaceBoundsPx } as DesktopWindow;
  const gesture = request.gesture || frame.gesture || {}; const point = request.point || gesture.semanticPoint;
  const strokes = gestureStrokes(gesture); const allPoints = strokes.flat();
  if (!window.hwnd || !window.pid || !window.process_name) throw new Error('target_identity_incomplete');
  if (metadata.width !== frame.surfaceBoundsPx[2] - frame.surfaceBoundsPx[0] || metadata.height !== frame.surfaceBoundsPx[3] - frame.surfaceBoundsPx[1]) throw new Error('artifact_surface_mismatch');
  if (allPoints.length && gesture.coordinateSpace !== 'physical_screen_pixels') throw new Error('gesture_coordinate_space_mismatch');
  if (allPoints.some(([x, y]) => x < frame.surfaceBoundsPx[0] || y < frame.surfaceBoundsPx[1] || x >= frame.surfaceBoundsPx[2] || y >= frame.surfaceBoundsPx[3])) throw new Error('gesture_outside_surface');
  const source = request.sourceWindow || request.source_window;
  if (source && (Number(source.hwnd) !== window.hwnd || Number(source.pid || source.processId) !== window.pid || String(source.process_name || source.processName || '').replace(/\.exe$/i, '').toLowerCase() !== String(window.process_name).replace(/\.exe$/i, '').toLowerCase())) throw new Error('target_identity_mismatch');
  const mark: Rect | undefined = allPoints.length ? [Math.min(...allPoints.map(p => p[0])), Math.min(...allPoints.map(p => p[1])), Math.max(1, Math.max(...allPoints.map(p => p[0])) - Math.min(...allPoints.map(p => p[0]))), Math.max(1, Math.max(...allPoints.map(p => p[1])) - Math.min(...allPoints.map(p => p[1])))] : undefined;
  let sameWindow = false;
  try { const live = await nativeRequest<DesktopWindow>('window', { hwnd: window.hwnd }, signal); sameWindow = live.pid === window.pid && (!window.processStartTime || live.processStartTime === window.processStartTime) && JSON.stringify(live.bbox) === JSON.stringify(window.bbox); } catch { signal?.throwIfAborted(); }
  const region = mark ? { x: mark[0], y: mark[1], width: mark[2], height: mark[3] } : undefined;
  const results = await Promise.allSettled([sameWindow ? resolveSelection(window, { ...request, point, region }, signal) : Promise.resolve([]), recognizeText(frame.localArtifact.path, { bounds: frame.surfaceBoundsPx, signal }), sameWindow ? surfaceAdapters.resolve(window, { ...request, point, region }, signal) : Promise.resolve([])]);
  signal?.throwIfAborted();
  const contexts = results[0].status === 'fulfilled' ? results[0].value as AdapterContext[] : [];
  for (const context of contexts) {
    if (context.adapter === 'uia' && context.artifacts.document_location && context.artifacts.page_rect) {
      const recovery = await (await import('./desktop_sources.js')).recoverPdfSelection(context.artifacts, frame).catch((error: unknown) => ({ ok: false, error: String(error) })) as DesktopRecord;
      context.artifacts.pdf_recovery = recovery;
      if (recovery.ok) { context.content = recovery.text; context.artifacts.pdf_document_path = recovery.document_path; context.artifacts.pdf_context = recovery.context; context.artifacts.source_identity = { absolutePath: recovery.document_path, hwnd: window.hwnd, host: 'pdf' }; context.artifacts.locators = [{ kind: 'pdf-region', value: { pageIndex: recovery.page_number - 1, rectangles: recovery.rectangles } }]; }
    }
  }
  const ocr = results[1].status === 'fulfilled' ? results[1].value as DesktopRecord : { blocks: [], error: String(results[1].reason), usedBackend: 'windows-ocr' };
  const surfaces = results[2].status === 'fulfilled' ? results[2].value : [];
  const selected = selectOcrBlocks(ocr.blocks || [], gesture);
  const observations = contexts.map(context => ({ context, ...structuredCoverage(context, mark), status: context.error ? context.content ? 'degraded' : 'error' : context.content ? 'ok' : 'empty_confirmed', priority: context.adapter === 'office' ? 0 : context.adapter === 'browser-devtools' ? 1 : 2 }));
  const best = observations.filter(item => item.covers && item.context.content).sort((a, b) => a.priority - b.priority)[0];
  const pixelText = ocrText(selected.selected);
  const conflicts = best && pixelText && !textsAgree(best.context.content, pixelText) ? [{ providers: [best.context.adapter, 'ocr'], reason: 'content_disagreement' }] : [];
  const context: AdapterContext = best && !conflicts.length ? best.context : { adapter: 'pixel-ocr', app: window.process_name, window, content: pixelText, method: 'ocr:windows', artifacts: { blocks: selected.selected, all_blocks: ocr.blocks } };
  const conversation = surfaces.find(surface => surface.conversationIdentity)?.conversationIdentity;
  if (conversation) context.artifacts.conversationIdentity = conversation;
  if (request.workspaceRoot) context.artifacts.componentLink = await (await import('./desktop_sources.js')).resolveComponentSource(request.workspaceRoot, contexts.find(item => item.adapter === 'browser-devtools')?.artifacts.browser_context || null, surfaces.flatMap(surface => surface.objects || []));
  const content = context.content;
  return { frameLeaseId: frame.frameLeaseId, context, content, source_window: window, capture_path: frame.localArtifact.path, capture_bbox: frame.surfaceBoundsPx, frame_lease: frame, selection_gesture: gesture, evidence_binding: { status: 'verified', target: frame.targetWindow, surface_bounds_px: frame.surfaceBoundsPx, capture_kind: frame.source === 'wgc-window' ? 'window' : /display/.test(frame.source || '') ? 'display' : 'fallback' },
    structured_covers_mark: !!best, structured_gap_reason: best ? '' : observations.find(item => !item.covers)?.reason || 'structured_context_unavailable', selection_bbox: mark ? xywhToLtrb(mark) : frame.surfaceBoundsPx,
    selection_segments: selected.segments.map(blocks => ({ text: ocrText(blocks), rectangles: blocks.map(block => block.rect) })), visual_elements: groupVisualElements(ocr.blocks || [], frame.surfaceBoundsPx),
    surface_objects: surfaces.flatMap(surface => surface.objects || []), surface_adapters: surfaces, structured_contexts: contexts, ocr, conflicts, status: conflicts.length ? 'degraded' : content ? 'ok' : 'unsupported',
    perception_trace: { schemaVersion: 1, selectedLayer: context.adapter === 'pixel-ocr' ? 'pixel' : context.adapter, selectedAdapter: context.adapter, selectedMethod: context.method, pixelFallbackUsed: context.adapter === 'pixel-ocr', attempts: observations.map(item => ({ adapter: item.context.adapter, status: item.status, reason: item.reason, coversMark: item.covers })), observations: observations.map(item => ({ ...item.context, layer: item.context.adapter, status: item.status, coversMark: item.covers, confidence: item.status === 'ok' ? 0.8 : 0.4 })), conflicts, liveIdentityMatched: sameWindow },
    captured_at: frame.capturedAtUtc, latencyMs: performance.now() - started, usedBackend: context.method };
}

export async function probeElement(payload: DesktopRecord, signal?: AbortSignal): Promise<DesktopRecord> {
  const started = performance.now(), x = Number(payload.x), y = Number(payload.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'a physical screen point is required' };
  const windows = await listWindows(signal); const window = payload.hwnd ? windows.find(row => row.hwnd === Number(payload.hwnd)) : windows.find(row => !/^Magic Pointer(?: |$)/.test(row.title) && x >= row.bbox[0] && x < row.bbox[2] && y >= row.bbox[1] && y < row.bbox[3]);
  if (!window) return { ok: false, error: 'no_window_at_point' };
  const data = await probeSelection(window.hwnd, { point: { x, y }, signal }); const area = (window.bbox[2] - window.bbox[0]) * (window.bbox[3] - window.bbox[1]);
  const rectangles = [data.element_rect, ...(data.rectangles || [])].filter(validRect).filter(rect => rect[2] * rect[3] < area * 0.92).sort((a, b) => a[2] * a[3] - b[2] * b[3]);
  let rectangle = rectangles[0], source = 'structured', label = String(data.element_name || '').slice(0, 120);
  if (!rectangle) {
    const capture = await captureSurface(window.bbox, signal); const path = join(desktopDataRoot(), `element-${randomUUID()}.png`); await mkdir(desktopDataRoot(), { recursive: true }); await writeFile(path, capture.bytes);
    try { const ocr = await recognizeText(path, { bounds: window.bbox, signal }); const elements = groupVisualElements(ocr.blocks, window.bbox).filter(row => x >= row.rect[0] && x <= row.rect[0] + row.rect[2] && y >= row.rect[1] && y <= row.rect[1] + row.rect[3]).sort((a, b) => a.rect[2] * a.rect[3] - b.rect[2] * b.rect[3]); if (elements.length) { rectangle = elements[0].rect; label = String(elements[0].text).split('\n')[0].slice(0, 120); source = 'pixel'; } } finally { await unlink(path).catch(() => {}); }
  }
  return rectangle ? { ok: true, rect: { x: rectangle[0], y: rectangle[1], width: rectangle[2], height: rectangle[3] }, source, label, controlType: data.control_type || '', resultKind: data.result_kind || '', window: { hwnd: window.hwnd, title: window.title }, elapsedMs: performance.now() - started } : { ok: false, error: 'no_element_at_point', window: { hwnd: window.hwnd, title: window.title }, elapsedMs: performance.now() - started };
}

export async function handleSelection(payload: DesktopRecord, options: { signal?: AbortSignal; runRuntime?: (payload: DesktopRecord, options?: DesktopRecord) => Promise<DesktopRecord> } = {}): Promise<DesktopRecord> {
  if (payload.action === 'element_probe' || payload.kind === 'element_probe') return probeElement(payload, options.signal);
  if (payload.action === 'snapshot' || payload.action === 'capture' || !payload.command && !payload.instruction && !payload.question) return captureSnapshot(payload, options.signal);
  const snapshot = payload.selectionSnapshot || payload.snapshot || (await captureSnapshot(payload, options.signal)).selectionSnapshot;
  if (!snapshot || snapshot.status === 'invalid_frame_lease') return { ok: false, error: 'invalid_frame_lease', selectionSnapshot: snapshot };
  if (!options.runRuntime) throw new Error('selection_runtime_not_connected');
  const command = String(payload.instruction || payload.command || payload.question || ''), source = String(snapshot.context?.content || snapshot.content || ''), target = lengthTarget(source, { ...payload, ...payload.lengthTarget }, command);
  const bounds = snapshot.source_window?.bbox || snapshot.capture_bbox;
  const pointing = /哪里|哪个|位置|指出|指向|点哪|where|which|point\s+(?:to|at)/i.test(command) ? `\n若答案涉及明确屏幕位置，可插入 [POINT x,y]，使用屏幕物理像素坐标，范围 ${JSON.stringify(bounds)}。不确定位置时不要生成标记。` : '';
  const instruction = target ? `${lengthInstruction(target)}\n用户要求：${command}` : command + pointing;
  const result = await options.runRuntime({ ...payload, selectionSnapshot: snapshot, snapshot, instruction }, { signal: options.signal });
  const parsed = parseScreenPoints(String(result.answer || ''), bounds);
  return { ...result, answer: parsed.text, ...(target ? { intentKind: 'length_target', lengthTarget: target, ...measureLengthTarget(parsed.text, target) } : {}), selectionContext: result.selectionContext || snapshot.context, sourceWindow: result.sourceWindow || snapshot.source_window, selectionSessionId: payload.selectionSessionId || payload.selection_session_id || null, selectionSnapshotId: snapshot.snapshot_id || snapshot.snapshotId || null, screenPoints: parsed.points.length ? parsed.points : result.screenPoints || [], actionProposals: result.actionProposals || [], errors: result.errors || [] };
}

export function parseScreenPoints(answer: string, bounds?: Rect): { text: string; points: DesktopRecord[] } {
  const points: DesktopRecord[] = [];
  const text = answer.replace(/\[\s*point\s*[:\s]\s*(-?\d{1,5})\s*[,\s]\s*(-?\d{1,5})\s*\]/gi, (_match, rawX, rawY) => { const x = Number(rawX), y = Number(rawY); if (points.length < 6 && (!bounds || x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3])) points.push({ x, y, order: points.length + 1 }); return ''; }).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([，。、；：,.;:!?！？）)])/g, '$1').replace(/([（(])[ \t]+/g, '$1').replace(/[ \t]+$/gm, '').trim();
  return { text, points };
}
export function lengthTarget(source: string, request: DesktopRecord, command = ''): DesktopRecord | null {
  const sourceLines = source.trim() ? source.split(/\r?\n/).filter(line => line.trim()).length : 0, sourceChars = [...source.trim()].length;
  const linesMatch = /(?:扩写|压缩|精简|缩)(?:到|成)?\s*(\d{1,3})\s*行/.exec(command), charsMatch = /(?:扩写|压缩|精简|缩)(?:到|成)?\s*(\d{1,5})\s*(?:个字|字)/.exec(command);
  const targetLines = Number(request.targetLines || linesMatch?.[1] || (request.deltaLines ? Math.max(1, sourceLines + Number(request.deltaLines)) : 0)) || null;
  const targetChars = targetLines ? null : Number(request.targetChars || charsMatch?.[1]) || null;
  if ((!targetLines && !targetChars) || !sourceChars) return null;
  const wanted = targetLines || targetChars!, current = targetLines ? sourceLines : sourceChars, direction = wanted === current ? 'keep' : wanted > current ? 'expand' : 'condense';
  return { direction, targetLines, targetChars, sourceLines, sourceChars, ratio: Math.round(wanted / Math.max(1, current) * 1000) / 1000 };
}
export function lengthInstruction(target: DesktopRecord): string {
  const size = target.targetLines ? `${target.targetLines} 行` : `${target.targetChars} 个字`;
  const head = target.direction === 'expand' ? `把选中文字扩写到大约 ${size}。只展开原文已有的意思，补足省略步骤，不引入原文没有的事实、数字、人名或来源。` : target.direction === 'condense' ? `把选中文字压缩到大约 ${size}。保留结论、关键数字和专有名词，删去重复，保持原意。` : '保持长度基本不变，润色选中文字。';
  return head + '\n只输出替换后的文字本身，不要前言、标题、引号、Markdown或解释。保持原文语言和段落结构。';
}
export function measureLengthTarget(text: string, target: DesktopRecord): DesktopRecord {
  const lines = text.split(/\r?\n/).filter(line => line.trim()).length, chars = [...text.trim()].length, wanted = target.targetLines || target.targetChars, got = target.targetLines ? lines : chars, tolerance = target.targetLines ? Math.max(1, Math.round(wanted * 0.34)) : Math.max(8, Math.round(wanted * 0.30));
  const lengthHit = Math.abs(got - wanted) <= tolerance; return { lengthHit, detail: `目标 ${wanted} ${target.targetLines ? '行' : '字'}，实际 ${got} ${target.targetLines ? '行' : '字'}${lengthHit ? '' : '（未命中目标，可继续调整）'}` };
}

export async function captureSnapshot(payload: DesktopRecord, signal?: AbortSignal): Promise<DesktopRecord> {
  const frame = payload.frameLease || payload.frame_lease;
  if (!frame) return { ok: false, error: 'invalid_frame_lease', captureSummary: { state: 'invalid_frame_lease', label: '画面未冻结', hasContent: false, hasVisual: false }, selectionSnapshot: { status: 'invalid_frame_lease', context: null, capture_path: null } };
  try {
      const result = await perceiveFrozenFrame(frame, { ...payload, gesture: payload.gesture, point: payload.cursor || payload.target_point }, signal);
    const snapshot = { ...result, snapshot_id: `selection-${randomUUID()}`, expires_at: new Date(Date.now() + 10 * 60000).toISOString(), source_kind: result.context.adapter, target_point: payload.cursor || payload.target_point || frame.gesture?.semanticPoint || null, target_point_space: 'physical_screen_pixels', pointer_anchor_bbox: result.selection_bbox, capture_attestation: { frameLeaseId: frame.frameLeaseId, source: frame.source, pixelsFrozen: true }, capture_policy: payload.capturePolicy || { uploadScreenshots: payload.uploadScreenshots !== false }, gesture_grounding: { objects: result.surface_objects, segments: result.selection_segments } };
    return { ok: true, selectionSnapshot: snapshot, captureSummary: { state: result.content ? 'ready' : 'visual', label: result.source_window.title || '所选区域', detail: String(result.content || '').slice(0, 200), app: result.context.app, hasContent: !!result.content, hasVisual: true, canRewrite: !!result.content, usedBackend: result.usedBackend }, suggestedCommands: [] };
  } catch (error) { signal?.throwIfAborted(); return { ok: false, error: error instanceof Error ? error.message : String(error), selectionSnapshot: { status: 'invalid_frame_lease', frame_lease: frame, capture_path: null }, captureSummary: { state: 'invalid_frame_lease', hasContent: false, hasVisual: false } }; }
}

export interface PerceptionToolOptions { snapshot?: DesktopRecord; model?: ModelConfig; vision?: (images: { dataUrl?: string; path?: string; label?: string }[], prompt: string, signal?: AbortSignal) => Promise<DesktopRecord>; sources?: (id: string) => DesktopRecord | undefined; uploadScreenshots?: boolean }
export function registerPerceptionTools(registry: ToolRegistry, options: PerceptionToolOptions = {}): void {
  const snapshot = options.snapshot || {}; const frame: FrozenFrame | undefined = snapshot.frame_lease || snapshot.frameLease;
  let lookCalls = 0;
  const vision = options.vision || (options.model ? (images: { dataUrl?: string; path?: string; label?: string }[], prompt: string, signal?: AbortSignal) => requestVision(options.model!, { images, prompt, signal, timeoutMs: 30000 }) : undefined);
  const frozenEvidence = (value: string) => evidence(`[historical frozen frame captured at ${frame?.capturedAtUtc || snapshot.captured_at || 'gesture time'}]\n${value}`, value ? 'ok' : 'empty_confirmed', 'frozen', value ? 1 : 0);
  const string = { type: 'string' };
  for (const [name, properties] of Object.entries({ read_around: { anchor: string, radius: { type: 'integer' } }, dump_subtree: { anchor: string, depth: { type: 'integer' } }, find_in_window: { pattern: string }, list_windows: {}, get_focused: {} })) {
    registry.register({ name, description: name === 'list_windows' || name === 'get_focused' ? 'Read current visible window identity.' : 'Read historical selection evidence. Frozen evidence cannot establish current action targets.', input_schema: { type: 'object', properties, required: [] }, effect: 'read', is_concurrency_safe: true, used_backend: 'frozen_evidence', execute: async (args, context) => {
      if (name === 'list_windows' || name === 'get_focused') { const windows = await listWindows(context.signal); return evidence(JSON.stringify(name === 'get_focused' ? windows.find(window => window.focused) || null : windows), 'ok', 'win32'); }
      const text = String(snapshot.context?.content || snapshot.content || '');
      if (name === 'find_in_window') return frozenEvidence(text.split('\n').filter(line => line.toLowerCase().includes(String(args.pattern || '').toLowerCase())).join('\n'));
      if (name === 'dump_subtree') return frozenEvidence(JSON.stringify(snapshot.surface_objects || snapshot.gesture_grounding || snapshot.context?.artifacts || {}));
      const anchor = String(args.anchor || ''), rows = text.split('\n'), found = rows.findIndex(row => row.includes(anchor)), radius = Math.max(1, Math.min(10, Number(args.radius || 3)));
      return frozenEvidence(found < 0 ? text : rows.slice(Math.max(0, found - radius), found + radius + 1).join('\n'));
    } });
  }
  registry.register({ name: 'look', description: 'Inspect the historical frozen image or a referenced region. The same historical full frame provides context; this is not a current screen observation.', input_schema: { type: 'object', properties: { anchor: string, reference: string, prompt: string, question: string, box_ltrb: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 } }, required: [] }, effect: 'read', is_concurrency_safe: true, timeout_ms: 35000, execute: async (args, context) => {
    if (!frame || !vision) return evidence(null, 'unsupported', 'vision', 0, { note: !frame ? 'frozen_frame_unavailable' : 'vision_not_configured' });
    if (options.uploadScreenshots === false) return evidence(null, 'denied', 'vision', 0, { note: 'screenshot_upload_disabled' });
    if (lookCalls >= 12) return evidence(null, 'unsupported', 'vision', 0, { note: 'look_quota_exhausted' });
    let box = args.box_ltrb as Rect | undefined;
    const anchor = String(args.anchor || args.reference || '');
    if (!box && anchor.startsWith('bbox:')) box = anchor.slice(5).split(',').map(Number) as Rect;
    if (!box && anchor) { const material = (snapshot.materials || snapshot.references || []).find((row: DesktopRecord) => [row.referenceId, row.id, row.label].includes(anchor)); box = material?.locator?.value?.bboxPx || material?.bbox || material?.selection_bbox; }
    box ||= snapshot.selection_bbox || frame.surfaceBoundsPx;
    const intersect = rectIntersection(box!, frame.surfaceBoundsPx); if (!intersect) return evidence(null, 'error', 'vision', 0, { note: 'box_out_of_bounds' });
    const region = { left: Math.round(intersect[0] - frame.surfaceBoundsPx[0]), top: Math.round(intersect[1] - frame.surfaceBoundsPx[1]), width: Math.round(intersect[2] - intersect[0]), height: Math.round(intersect[3] - intersect[1]) };
    const bytes = await sharp(frame.localArtifact.path).extract(region).png().toBuffer(); lookCalls++;
    const result = await vision([{ dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, label: 'Selected historical detail' }, { path: frame.localArtifact.path, label: `FROZEN_FRAME_CONTEXT same historical frame captured at ${frame.capturedAtUtc}; context only` }], String(args.prompt || args.question || 'Describe the selected image region.'), context.signal);
    return { ...frozenEvidence(String(result.text || '')), source: 'vision', usedBackend: result.usedBackend, latency_ms: result.latencyMs };
  } });
  registry.register({ name: 'observe_source', description: 'Observe the current state of a source already bound to this task. Revalidates document or conversation identity before reading pixels.', input_schema: { type: 'object', properties: { source_id: string, question: string, locator: { type: 'object' } }, required: ['source_id'] }, effect: 'read', access_for: args => ({ action: 'read', source_ids: [String(args.source_id || '')] }), execute: async (args, context) => {
    const source = options.sources?.(String(args.source_id)); if (!source || !source.capabilities?.includes('read')) throw new ActionFailure('permission_denied', 'source is not bound to this task');
    const identity = source.identity || {}; const window = await nativeRequest<DesktopWindow>('window', { hwnd: identity.hwnd || identity.windowHwnd }, context.signal);
    if (identity.pid && window.pid !== identity.pid) throw new ActionFailure('stale_snapshot', 'source process changed');
    if (identity.conversationIdentity) { const expected = identity.conversationIdentity; if (!expected.nativeConversationId) throw new ActionFailure('stale_snapshot', 'conversation native identity unavailable'); const current = await readChat(window, expected.adapterId, context.signal); if (JSON.stringify(current.conversationIdentity) !== JSON.stringify(expected)) throw new ActionFailure('stale_snapshot', 'conversation changed'); }
    else if (identity.targetId) await readBrowser(identity, context.signal);
    else if (identity.absolutePath) { const current = await readOffice(window, { signal: context.signal }); if (resolve(current.artifacts.source_identity.absolutePath).toLowerCase() !== resolve(identity.absolutePath).toLowerCase()) throw new ActionFailure('stale_snapshot', 'document changed'); }
    else if (source.kind !== 'capture') throw new ActionFailure('stale_snapshot', 'source identity unavailable');
    const [elements, capture] = await Promise.all([listElements(window.hwnd, context.signal), captureSurface(window.bbox, context.signal)]);
    const result = vision && options.uploadScreenshots !== false ? await vision([{ dataUrl: `data:image/png;base64,${capture.bytes.toString('base64')}`, label: 'CURRENT SURFACE' }], String(args.question || 'Describe the current surface.'), context.signal) : { text: '', usedBackend: 'vision_unavailable' };
    return { sourceId: source.sourceId || source.source_id, observedAt: capture.capturedAtUtc, stateVersion: randomUUID(), window, elements, text: result.text, coverage: { extent: 'viewport', complete: false }, usedBackend: `${capture.source}+${result.usedBackend}`, evidenceStatus: result.text ? 'ok' : 'degraded' };
  } });
}

export function planOverlay(blocks: OcrBlock[], translations: string[]): DesktopRecord[] {
  const width = (value: string, size: number) => [...value].reduce((sum, c) => sum + (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uff00-\uff60]/.test(c) ? 1 : 0.56), 0) * size;
  const wrap = (text: string, size: number, max: number) => { const lines: string[] = []; let current = ''; for (const c of text) { if (c === '\n' || current && width(current + c, size) > max) { lines.push(current); current = c === '\n' ? '' : c; } else current += c; } if (current) lines.push(current); return lines.length ? lines : ['']; };
  return blocks.slice(0, 60).flatMap((block, index) => { const text = translations[index]?.trim(); if (!text || text === block.text || !validRect(block.rect)) return []; for (let fontPx = Math.max(11, Math.min(48, Math.floor(block.rect[3] * 0.78))); fontPx >= 11; fontPx--) { const lines = wrap(text, fontPx, block.rect[2]); if (lines.length * fontPx * 1.25 <= block.rect[3]) return [{ rect: block.rect, text, fontPx, lines, truncated: false }]; } const lines = wrap(text, 11, block.rect[2]), count = Math.max(1, Math.floor(block.rect[3] / 13.75)); return [{ rect: block.rect, text, fontPx: 11, lines: lines.slice(0, count), truncated: lines.length > count }]; });
}
export async function annotateFrozenFrame(frame: FrozenFrame, output: string): Promise<string> {
  const strokes = gestureStrokes(frame.gesture); const points = strokes.map(stroke => `<polyline fill="none" stroke="#3c8cff" stroke-width="3" points="${stroke.map(([x, y]) => `${x - frame.surfaceBoundsPx[0]},${y - frame.surfaceBoundsPx[1]}`).join(' ')}"/>`).join('');
  await sharp(frame.localArtifact.path).composite([{ input: Buffer.from(`<svg width="${frame.localArtifact.width}" height="${frame.localArtifact.height}">${points}</svg>`) }]).png().toFile(output); return output;
}
