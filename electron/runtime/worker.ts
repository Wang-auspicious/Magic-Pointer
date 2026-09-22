import path from 'node:path';
import { runRuntime, type RuntimeOptions, type Data } from './index';
import { handleFabric } from './fabric_api';
import { Fabric } from './fabric';
import { handleSession, EventSession } from './session';
import { handleArtifact } from './artifacts';
import { handleLearning, reviewLearning } from './learning';
import { handleSelection, captureSnapshot, probeElement, closeOcr } from './desktop_perception';
import { handleContext, parseContextIntent } from './context_sessions';
import { handleAction, handleDelivery } from './actions_delivery';
import { configureDesktop, closeDesktop } from './desktop';
import { resolveModelConfig, requestVision } from './model';
import { ExternalTasks, buildInvocation, discoverProviders, locateExecutable } from './external';
import { handleReview, isReviewCommand } from './review';

export async function dispatchRuntime(kind: string, payload: Data, options: RuntimeOptions): Promise<Data> {
  configureDesktop(options.root);
  if (kind === 'conversation') return runRuntime(payload, options);
  if (kind === 'fabric') return handleFabric(payload, options);
  if (kind === 'agent_session') return handleSession(payload, options.userDataDir);
  if (kind === 'artifact') return handleArtifact(payload, options.userDataDir);
  if (kind === 'learning_candidates') return handleLearning(payload, options.userDataDir);
  if (kind === 'learning_review') { const session = await EventSession.open(options.userDataDir, payload.sessionId, false); return reviewLearning(options.userDataDir, session.id, session.deriveMessages(), payload.terminalReason, resolveModelConfig(payload.modelRuntime, options.root, options.userDataDir), options.signal); }
  if (kind === 'selection_snapshot') return captureSnapshot(payload, options.signal);
  if (kind === 'element_probe') return probeElement(payload, options.signal);
  if (kind === 'selection' || kind === 'electron') {
    if (isReviewCommand(String(payload.command || ''))) {
      const captured = payload.selectionSnapshot ? { selectionSnapshot: payload.selectionSnapshot } : await captureSnapshot(payload, options.signal);
      return (await handleReview(payload, captured.selectionSnapshot, options.userDataDir))!;
    }
    if (payload.workflow === 'runtime_issue' || parseContextIntent(String(payload.command || ''))) {
      const captured = payload.selectionSnapshot ? { selectionSnapshot: payload.selectionSnapshot } : await captureSnapshot(payload, options.signal);
      return handleContext(payload, { ...options, capture: captured.selectionSnapshot });
    }
    return handleSelection(payload, { signal: options.signal, runRuntime: next => runRuntime(next, options) });
  }
  if (kind === 'action') return handleAction(payload, { ...options, executeRecipe: async proposal => ({ fabric_receipt: await new Fabric(options).execute(proposal.parameters?.plan || proposal.metadata?.plan, true) }) });
  if (kind === 'deliver_text') return handleDelivery(payload, options);
  if (kind === 'stash_describe') { const reply = await requestVision(resolveModelConfig(payload.modelRuntime, options.root, options.userDataDir), { images: [{ path: payload.imagePath }], prompt: '用三到四句中文简要描述这张图片的内容：主要对象、场景、可见文字（如有）。只描述你确定看到的，不要编造。', signal: options.signal }); return { ok: true, summary: reply.text, usedBackend: reply.usedBackend }; }
  if (kind === 'agent') {
    const operation = String(payload.operation || 'providers'), store = new ExternalTasks(options.userDataDir);
    if (operation === 'providers') return { ok: true, providers: await discoverProviders() };
    if (operation === 'status') return { ok: true, task: await store.status(payload.taskId) };
    if (operation === 'cancel') return { ok: true, task: await store.cancel(payload.taskId) };
    if (operation === 'steer') return { ok: true, task: await store.steer(payload.taskId, payload.message) };
    if (operation === 'start') { const request = payload.request || {}, executable = payload.executable || await locateExecutable(request.provider === 'cursor' ? 'cursor-agent' : request.provider); if (!executable) throw new Error('agent_executable_missing'); return { ok: true, task: await store.start(request, await buildInvocation(request, executable, payload.profile)) }; }
  }
  throw new Error(`Unknown runtime request: ${kind}`);
}

async function main(): Promise<void> {
  const controller = new AbortController(); process.once('SIGTERM', () => controller.abort(new DOMException('Interrupted', 'AbortError')));
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error('runtime_request_too_large'); }
  const payload = JSON.parse(input || '{}');
  const root = payload.root || path.resolve(__dirname, '..', '..', '..'), userDataDir = process.env.MAGIC_POINTER_USER_DATA_DIR || path.join(root, 'data', 'runtime');
  const onProgress = (phase: string, fields: Data = {}) => { const values = { phase, ms: Math.round(performance.now()), ...fields }; process.stderr.write('@@mp ' + Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${String(value).replace(/\s/g, '_')}`).join(' ') + '\n'); };
  const heartbeat = setInterval(() => onProgress('runtime_alive'), 10000); heartbeat.unref();
  try { onProgress('runtime_ready'); const result = await dispatchRuntime(process.argv[2] || 'electron', payload, { root, userDataDir, signal: controller.signal, onProgress }); onProgress('total'); process.stdout.write(JSON.stringify(result) + '\n'); }
  finally { clearInterval(heartbeat); closeOcr(); closeDesktop(); }
}

if (require.main === module) main().catch(error => { closeOcr(); closeDesktop(); process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), usedBackend: 'typescript_runtime' }) + '\n'); process.exitCode = 1; });
