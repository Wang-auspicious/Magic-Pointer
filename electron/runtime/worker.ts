import path from 'node:path';
import type {RuntimeOptions, Data} from './index';
import {configureDesktop, closeDesktop} from './desktop';

interface RuntimeDispatchOptions extends RuntimeOptions {
  deferSnapshotCleanup?: (cleanup: () => Promise<void>) => void;
}

export async function dispatchRuntime(
  kind: string,
  payload: Data,
  options: RuntimeDispatchOptions,
): Promise<Data> {
  configureDesktop(options.root);
  if (kind === 'conversation') {
    const {runRuntime} = require('./index') as typeof import('./index');
    return runRuntime(payload, options);
  }
  if (kind === 'fabric') {
    const {handleFabric} =
      require('./fabric_api') as typeof import('./fabric_api');
    return handleFabric(payload, options);
  }
  if (kind === 'agent_session') {
    const {handleSession} = require('./session') as typeof import('./session');
    return handleSession(payload, options.userDataDir);
  }
  if (kind === 'artifact') {
    const {handleArtifact} =
      require('./artifacts') as typeof import('./artifacts');
    return handleArtifact(payload, options.userDataDir);
  }
  if (kind === 'learning_candidates') {
    const {handleLearning} =
      require('./learning') as typeof import('./learning');
    return handleLearning(payload, options.userDataDir);
  }
  if (kind === 'learning_review') {
    const {EventSession} = require('./session') as typeof import('./session');
    const {reviewLearning} =
      require('./learning') as typeof import('./learning');
    const {resolveModelConfig} = require('./model') as typeof import('./model');
    const session = await EventSession.open(
      options.userDataDir,
      payload.sessionId,
      false,
    );
    return reviewLearning(
      options.userDataDir,
      session.id,
      session.deriveMessages(),
      payload.terminalReason,
      resolveModelConfig(
        payload.modelRuntime,
        options.root,
        options.userDataDir,
      ),
      options.signal,
    );
  }
  if (kind === 'selection_snapshot') {
    const {captureSnapshot} =
      require('./desktop_perception') as typeof import('./desktop_perception');
    return captureSnapshot(
      payload,
      options.signal,
      progress =>
        options.onProgress?.('perception_provider', {
          b64: Buffer.from(JSON.stringify(progress)).toString('base64'),
        }),
      options.deferSnapshotCleanup,
    );
  }
  if (kind === 'element_probe') {
    const {probeElement} =
      require('./desktop_perception') as typeof import('./desktop_perception');
    return probeElement(payload, options.signal);
  }
  if (kind === 'selection' || kind === 'electron') {
    const {captureSnapshot, handleSelection} =
      require('./desktop_perception') as typeof import('./desktop_perception');
    const {handleReview, isReviewCommand} =
      require('./review') as typeof import('./review');
    if (isReviewCommand(String(payload.command || ''))) {
      const captured = payload.selectionSnapshot
        ? {selectionSnapshot: payload.selectionSnapshot}
        : await captureSnapshot(payload, options.signal);
      return (await handleReview(
        payload,
        captured.selectionSnapshot,
        options.userDataDir,
      ))!;
    }
    const {handleContext, parseContextIntent} =
      require('./context_sessions') as typeof import('./context_sessions');
    if (
      payload.workflow === 'runtime_issue' ||
      parseContextIntent(String(payload.command || ''))
    ) {
      const captured = payload.selectionSnapshot
        ? {selectionSnapshot: payload.selectionSnapshot}
        : await captureSnapshot(payload, options.signal);
      return handleContext(payload, {
        ...options,
        capture: captured.selectionSnapshot,
      });
    }
    return handleSelection(payload, {
      root: options.root,
      userDataDir: options.userDataDir,
      signal: options.signal,
      runRuntime: next => {
        const {runRuntime} = require('./index') as typeof import('./index');
        return runRuntime(next, options);
      },
    });
  }
  if (kind === 'action') {
    const {handleAction} =
      require('./actions_delivery') as typeof import('./actions_delivery');
    return handleAction(payload, {
      ...options,
      executeRecipe: async proposal => {
        const {Fabric} = require('./fabric') as typeof import('./fabric');
        return {
          fabric_receipt: await new Fabric(options).execute(
            proposal.parameters?.plan || proposal.metadata?.plan,
            true,
          ),
        };
      },
    });
  }
  if (kind === 'deliver_text') {
    const {handleDelivery} =
      require('./actions_delivery') as typeof import('./actions_delivery');
    return handleDelivery(payload, options);
  }
  if (kind === 'stash_describe') {
    const {requestVision, resolveModelConfig} =
      require('./model') as typeof import('./model');
    const reply = await requestVision(
      resolveModelConfig(
        payload.modelRuntime,
        options.root,
        options.userDataDir,
      ),
      {
        images: [{path: payload.imagePath}],
        prompt:
          '用三到四句中文简要描述这张图片的内容：主要对象、场景、可见文字（如有）。只描述你确定看到的，不要编造。',
        signal: options.signal,
      },
    );
    return {ok: true, summary: reply.text, usedBackend: reply.usedBackend};
  }
  if (kind === 'agent') {
    const {
      ExternalTasks,
      buildInvocation,
      discoverProviders,
      locateExecutable,
    } = require('./external') as typeof import('./external');
    const operation = String(payload.operation || 'providers');
    const store = new ExternalTasks(options.userDataDir);
    if (operation === 'providers') {
      return {ok: true, providers: await discoverProviders()};
    }
    if (operation === 'status') {
      return {ok: true, task: await store.status(payload.taskId)};
    }
    if (operation === 'cancel') {
      return {ok: true, task: await store.cancel(payload.taskId)};
    }
    if (operation === 'steer') {
      return {
        ok: true,
        task: await store.steer(payload.taskId, payload.message),
      };
    }
    if (operation === 'start') {
      const request = payload.request || {};
      const executable =
        payload.executable ||
        (await locateExecutable(
          request.provider === 'cursor' ? 'cursor-agent' : request.provider,
        ));
      if (!executable) {
        throw new Error('agent_executable_missing');
      }
      return {
        ok: true,
        task: await store.start(
          request,
          await buildInvocation(request, executable, payload.profile),
        ),
      };
    }
  }
  throw new Error(`Unknown runtime request: ${kind}`);
}

async function flushResult(result: Data): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(result) + '\n', error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function closeWorkerResources(): void {
  // A route that never used perception must not load it just to close it.
  const perception = require.cache[require.resolve('./desktop_perception')]
    ?.exports as typeof import('./desktop_perception') | undefined;
  perception?.closeOcr();
  closeDesktop();
}

async function finishSnapshotCleanup(
  cleanups: Array<() => Promise<void>>,
): Promise<{state: 'completed' | 'timeout' | 'error'; error?: string}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(
        cleanups.map(cleanup => Promise.resolve().then(cleanup)),
      ).then(results => {
        const failed = results.find(result => result.status === 'rejected');
        return failed?.status === 'rejected'
          ? {state: 'error' as const, error: String(failed.reason)}
          : {state: 'completed' as const};
      }),
      new Promise<{state: 'timeout'}>(resolve => {
        timer = setTimeout(() => resolve({state: 'timeout'}), 500);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function main(): Promise<void> {
  // Before the first request, because undici picks its dispatcher lazily and
  // cannot be corrected afterwards. Every model call this process makes runs
  // through it, so skipping this is what produced "fetch failed" on a machine
  // whose proxy curl and Chromium were both already using.
  const {installEnvironmentProxy} =
    require('./proxy') as typeof import('./proxy');
  installEnvironmentProxy();
  const controller = new AbortController();
  process.once('SIGTERM', () =>
    controller.abort(new DOMException('Interrupted', 'AbortError')),
  );
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 8 * 1024 * 1024) {
      throw new Error('runtime_request_too_large');
    }
  }
  const payload = JSON.parse(input || '{}');
  const root = payload.root || path.resolve(__dirname, '..', '..', '..');
  const userDataDir =
    process.env.MAGIC_POINTER_USER_DATA_DIR ||
    path.join(root, 'data', 'runtime');
  const onProgress = (phase: string, fields: Data = {}) => {
    const values = {phase, ms: Math.round(performance.now()), ...fields};
    process.stderr.write(
      '@@mp ' +
        Object.entries(values)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${String(value).replace(/\s/g, '_')}`)
          .join(' ') +
        '\n',
    );
  };
  const heartbeat = setInterval(() => onProgress('runtime_alive'), 10000);
  heartbeat.unref();
  const kind = process.argv[2] || 'electron';
  const snapshotCleanups: Array<() => Promise<void>> = [];
  try {
    onProgress('runtime_ready');
    const result = await dispatchRuntime(kind, payload, {
      root,
      userDataDir,
      signal: controller.signal,
      onProgress,
      ...(kind === 'selection_snapshot'
        ? {
            deferSnapshotCleanup: (cleanup: () => Promise<void>) => {
              snapshotCleanups.push(cleanup);
            },
          }
        : {}),
    });
    onProgress('total');
    await flushResult(result);
  } finally {
    clearInterval(heartbeat);
    if (kind === 'selection_snapshot') {
      onProgress(
        'snapshot_cleanup',
        await finishSnapshotCleanup(snapshotCleanups),
      );
    }
    closeWorkerResources();
  }
  if (kind === 'selection_snapshot') {
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch(async error => {
    closeWorkerResources();
    await flushResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      usedBackend: 'typescript_runtime',
    });
    if (process.argv[2] === 'selection_snapshot') {
      process.exit(1);
    }
    process.exitCode = 1;
  });
}
