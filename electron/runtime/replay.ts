import { access, readFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeAtomic } from './learning';
import type { Data } from './index';

export async function loadTrace(directory: string): Promise<Data> {
  const trace = JSON.parse(await readFile(path.join(directory, 'trace.json'), 'utf8'));
  if (trace.schema_version !== 1 || !trace.trace_id || !Array.isArray(trace.frames) || !Array.isArray(trace.pointer_trace)) throw new Error('invalid_desktop_trace');
  for (const frame of trace.frames) await access(path.resolve(directory, frame.png_path));
  for (const snapshot of trace.uia_snapshots || []) if (snapshot.tree_path) await access(path.resolve(directory, snapshot.tree_path));
  for (const sample of trace.pointer_trace) if (!['down', 'move', 'up'].includes(sample.phase) || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) throw new Error('invalid_pointer_sample');
  return trace;
}
export function traceStats(trace: Data): Data {
  const times = trace.pointer_trace.length ? trace.pointer_trace.map((sample: Data) => Date.parse(sample.t_utc)) : trace.frames.map((frame: Data) => Date.parse(frame.captured_at_utc));
  return { frames: trace.frames.length, pointer_samples: trace.pointer_trace.length, uia_snapshots: trace.uia_snapshots?.length || 0, cdp_snapshots: trace.cdp_snapshots?.length || 0, focus_events: trace.focus_events?.length || 0, duration_seconds: times.length ? (Math.max(...times) - Math.min(...times)) / 1000 : 0 };
}
export async function tracePayload(directory: string, trace: Data): Promise<Data> {
  const uia = trace.uia_snapshots?.at(-1) || {}, focus = trace.focus_events?.at(-1) || {}, stamp = new Date().toISOString(), truth = trace.ground_truth || {};
  const points = trace.pointer_trace.slice(0, 512).map((sample: Data) => ({ x: sample.x, y: sample.y, t: 0 }));
  const content = uia.tree_text ?? (uia.tree_path ? await readFile(path.resolve(directory, uia.tree_path), 'utf8') : '');
  return { command: truth.command || '', requestMode: 'auto', selectionSessionId: `replay:${trace.trace_id}`, selectionGesture: { points },
    selectionSnapshot: { snapshot_id: `replay-${trace.trace_id}`, captured_at: stamp, expires_at: new Date(Date.now() + 600000).toISOString(), status: 'replay', source_kind: 'replay',
      target_point: points.at(-1) || null, target_point_space: 'physical_screen_pixels', source_window: { hwnd: uia.window_hwnd, title: focus.title || 'replay', process_name: focus.process_name || '' },
      context: { adapter: 'replay:uia', app: 'replay', window: { hwnd: uia.window_hwnd }, content, label: truth.label || 'replay', method: 'replay:uia', artifacts: { replay_trace_id: trace.trace_id, captured_rects_source: 'replay', captured_rects: [] }, error: null },
      capture_path: trace.frames.length ? path.resolve(directory, trace.frames[0].png_path) : null, capture_attestation: { status: 'replay', backend: 'replay', overlay_excluded: true }, frame_lease: null },
    replay: { traceId: trace.trace_id, recordedAt: trace.recorded_at_utc }, expected: truth.replay_expectation || {} };
}
export async function recordSnapshot(directory: string, snapshot: Data, gesture: Data = {}): Promise<Data> {
  await mkdir(directory, { recursive: true }); const frame = snapshot.frame_lease || snapshot.frameLease, image = snapshot.capture_path || frame?.localArtifact?.path, stamp = snapshot.captured_at || new Date().toISOString();
  const frames = [];
  if (image) { await copyFile(image, path.join(directory, 'frame.png')); frames.push({ frame_id: frame?.frameLeaseId || randomUUID(), png_path: 'frame.png', captured_at_utc: stamp, display_bounds_ltrb: frame?.surfaceBoundsPx || snapshot.selection_bbox }); }
  const trace = { schema_version: 1, trace_id: randomUUID(), recorded_at_utc: stamp, frames, uia_snapshots: [{ snapshot_id: snapshot.snapshot_id, captured_at_utc: stamp, tree_text: snapshot.context?.content || '', window_hwnd: snapshot.source_window?.hwnd }], pointer_trace: (gesture.points || []).map((point: Data, index: number, all: Data[]) => ({ x: point.x, y: point.y, t_utc: stamp, phase: index === 0 ? 'down' : index === all.length - 1 ? 'up' : 'move', buttons: 1 })), cdp_snapshots: [], focus_events: [], display_config: {}, ground_truth: null };
  await writeAtomic(path.join(directory, 'trace.json'), trace); return trace;
}
if (require.main === module) {
  void (async () => { const [command, directory, input] = process.argv.slice(2); if (!directory) throw new Error('Usage: replay.js stats|payload|record <directory> [snapshot.json]');
    if (command === 'record') { const value = JSON.parse(await readFile(input, 'utf8')); console.log(JSON.stringify(await recordSnapshot(directory, value.selectionSnapshot || value, value.selectionGesture), null, 2)); }
    else { const trace = await loadTrace(directory); if (!['stats', 'payload'].includes(command)) throw new Error('unknown_replay_command'); console.log(JSON.stringify(command === 'stats' ? traceStats(trace) : await tracePayload(directory, trace), null, 2)); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
