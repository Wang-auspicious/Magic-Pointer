const path = require('node:path');
const fs = require('node:fs/promises');
const { FrameCaptureWorkerClient } = require('../build/electron/frame_capture_worker_client');
const { createRuntimeBridgeRunner } = require('../build/electron/runtime_bridge_runner');
const { createStashRuntime } = require('../build/electron/stash_runtime');
const desktop = require('../build/electron/runtime/desktop');

async function verifyNativeRuntime() {
  const root = path.resolve(__dirname, '..'), userDataDir = path.join(root, 'data', 'runtime', `native-protocol-${Date.now()}`); await fs.mkdir(userDataDir, { recursive: true });
  process.env.MAGIC_POINTER_USER_DATA_DIR = userDataDir; desktop.configureDesktop(root);
  const windows = await desktop.listWindows(), window = windows.find((row: any) => row.focused && !/^Magic Pointer/.test(row.title)) || windows.find((row: any) => !/^Magic Pointer/.test(row.title));
  if (!window) throw new Error('native_acceptance_requires_visible_target');
  const client = new FrameCaptureWorkerClient({ root, runtimeExecutable: process.execPath, baseEnv: process.env, logger: { log() {} }, requestTimeoutMs: 20000 });
  const runner = createRuntimeBridgeRunner();
  const invoke = (kind: string, input: any): Promise<any> => new Promise(resolve => runner.run({ executable: process.execPath, args: [path.join(root, 'build', 'electron', 'runtime', 'worker.js'), kind], spawnOptions: { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, input: { ...input, root }, timeoutMs: 60000, onComplete: resolve }));
  try {
    await client.start(); await client.arm({ epochId: 'native-protocol', displayId: 'native-protocol', scaleFactor: 1, surfaceBoundsPx: window.bbox, targetWindow: { hwnd: window.hwnd, processId: window.pid, processName: window.process_name, title: window.title } });
    await new Promise(resolve => setTimeout(resolve, 700));
    const frame = await client.commit({ epochId: 'native-protocol', gesture: { coordinateSpace: 'physical_screen_pixels', strokes: [] } });
    const started = Date.now(), captured = await invoke('selection_snapshot', { frameLease: frame, uploadScreenshots: false }); if (!captured.ok) throw new Error(`snapshot_failed:${captured.error}`);
    const snapshot = captured.selectionSnapshot, selection = await invoke('selection', { command: '/help', selectionSnapshot: snapshot, selectionSessionId: 'native-protocol', uploadScreenshots: false });
    if (!selection.ok || selection.usedBackend !== 'runtime.slash_help') throw new Error(`readonly_selection_failed:${selection.error || selection.usedBackend}`);
    const stash = createStashRuntime({ baseDir: path.join(userDataDir, 'stash'), userDataDir, clipboard: { availableFormats: () => [], readText: () => '', write() {} }, focusProbe: async () => ({ app: window.process_name, windowTitle: window.title }), settings: () => ({ stash: { clipboard: false, text: true } }), log() {} });
    const entry = await stash.addText('Frozen frame protocol acceptance', { sourceId: frame.frameLeaseId }); if (!entry || !stash.get(entry.id)) throw new Error('stash_roundtrip_failed');
    const result = { ok: true, frame: { source: frame.source, width: frame.localArtifact.width, height: frame.localArtifact.height, hwnd: frame.targetWindow.hwnd }, snapshot: { state: snapshot.status, captureSummary: captured.captureSummary.state, backend: snapshot.usedBackend, artifactPresent: !!snapshot.capture_path, evidenceBinding: snapshot.evidence_binding.status, observationCount: snapshot.structured_contexts.length }, selection: { backend: selection.usedBackend, hasSession: !!selection.agentSessionId, hasSelectionContext: !!selection.selectionContext }, stash: { roundtrip: true }, elapsedMs: Date.now() - started, reportDirectory: userDataDir };
    await fs.writeFile(path.join(userDataDir, 'acceptance.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await client.shutdown(); desktop.closeDesktop(); }
}
void verifyNativeRuntime().catch(error => { console.error(error); desktop.closeDesktop(); process.exitCode = 1; });
