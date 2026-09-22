import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { configureDesktop, desktopRuntimeRoot, listWindows, listElements, probeSelection, nativeRequest, captureSurface, closeDesktop, delay, type DesktopRecord, type Rect } from './desktop';
import { CdpConnection, evaluateBrowser, resolveSelection, readOffice } from './desktop_adapters';
import { recognizeText, captureSnapshot, probeElement, closeOcr } from './desktop_perception';
import { FrameCaptureService } from './desktop_capture';
import { chooseUiTarget } from './desktop_selector';

export async function desktopCommand(command: string, args: DesktopRecord = {}, signal?: AbortSignal): Promise<unknown> {
  if (command === 'windows') return listWindows(signal);
  if (command === 'uia-tree') return listElements(Number(args.hwnd), signal);
  if (command === 'uia-selection') return probeSelection(Number(args.hwnd), { point: args.point, region: args.region, signal });
  if (command === 'element') return probeElement(args, signal);
  if (command === 'snapshot') return captureSnapshot(args, signal);
  if (command === 'ocr') return recognizeText(args.path, { bounds: args.bounds, signal, language: args.language });
  if (command === 'desktop-files') return nativeRequest('desktop_items', {}, signal);
  if (command === 'choose-target') return chooseUiTarget(args.target, args.candidates || [], args.state_id || 'diagnostic', signal);
  if (command === 'capture') { const capture = await captureSurface(args.bounds as Rect, signal); const path = resolve(args.output || 'data/runtime/capture.png'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, capture.bytes); return { ...capture, bytes: undefined, path }; }
  if (command === 'selection' || command === 'office') { const window = (await listWindows(signal)).find(row => row.hwnd === Number(args.hwnd)); if (!window) throw new Error('window_not_found'); return command === 'office' ? readOffice(window, { region: args.region, signal }) : resolveSelection(window, args, signal); }
  if (command === 'cdp-eval' || command === 'cdp-shot') {
    const endpoint = args.endpoint || 'http://127.0.0.1:9222', combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const pages = await (await fetch(`${endpoint}/json/list`, { signal: combined })).json() as DesktopRecord[];
    const matches = pages.filter(page => args.targetId ? page.id === args.targetId : page.type === 'page' && page.title.includes(args.title || 'Magic Pointer |'));
    if (matches.length !== 1) throw new Error(matches.length ? 'ambiguous_browser_target' : 'browser_target_not_found');
    if (command === 'cdp-eval') return evaluateBrowser(endpoint, matches[0].id, args.expression, combined);
    const cdp = new CdpConnection(matches[0].webSocketDebuggerUrl, combined);
    try { await cdp.request('Page.enable', {}); const result = await cdp.request('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); if (!result.data) throw new Error('browser_screenshot_empty'); const path = resolve(args.output || 'data/runtime/cdp-shot.png'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from(result.data, 'base64')); return { path, usedBackend: 'cdp_screenshot' }; } finally { cdp.close(); }
  }
  if (command === 'benchmark') {
    const rounds = Math.max(1, Math.min(100, Number(args.rounds || 10))), operation = String(args.operation || 'uia-selection'), results: DesktopRecord[] = [];
    if (operation === 'benchmark') throw new Error('recursive_benchmark');
    for (let index = 0; index < rounds; index++) { const started = performance.now(); try { const result = await desktopCommand(operation, args, signal); results.push({ elapsedMs: performance.now() - started, ok: true, result }); } catch (error) { results.push({ elapsedMs: performance.now() - started, ok: false, error: String(error) }); } }
    const times = results.map(row => row.elapsedMs).sort((a, b) => a - b), percentile = (value: number) => times[Math.min(times.length - 1, Math.ceil(times.length * value) - 1)];
    return { operation, rounds, completed: results.filter(row => row.ok).length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), memory: process.memoryUsage(), results };
  }
  if (command === 'frame-capture') {
    const service = new FrameCaptureService(resolve(args.outputRoot || 'data/runtime')); const epochId = `diagnostic-${Date.now()}`;
    try { await nativeRequest('ping', {}, signal); service.arm({ ...args, epochId, displayId: args.displayId || 'diagnostic' }); await delay(Number(args.bufferMs || 300), signal); return await service.commit({ epochId, gesture: args.gesture }); } finally { service.cancel(); }
  }
  throw new Error(`unknown_desktop_command:${command}`);
}
if (require.main === module) {
  const [command = 'windows', input = '{}'] = process.argv.slice(2); configureDesktop(desktopRuntimeRoot());
  void (async () => { const args = JSON.parse(input.startsWith('@') ? await readFile(resolve(input.slice(1)), 'utf8') : input); try { console.log(JSON.stringify(await desktopCommand(command, args), null, 2)); } finally { closeOcr(); closeDesktop(); } })().catch(error => { console.error(error); process.exitCode = 1; });
}
