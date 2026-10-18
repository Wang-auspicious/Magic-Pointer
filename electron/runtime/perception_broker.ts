export interface PerceptionProvider<T> {
  id: string;
  softDeadlineMs: number;
  hardDeadlineMs: number;
  read(signal: AbortSignal): Promise<T>;
}

export interface PerceptionProgress {
  provider: string;
  state: 'reading' | 'slow' | 'fulfilled' | 'rejected' | 'timeout' | 'cancelled';
  latencyMs: number;
  error?: string;
}

export interface PerceptionProviderResult<T> {
  id: string;
  status: 'fulfilled' | 'rejected' | 'timeout';
  latencyMs: number;
  value?: T;
  error?: string;
}

export interface PerceptionRunOptions {
  signal?: AbortSignal;
  onProgress?(event: PerceptionProgress): void;
}

export async function runPerceptionProviders<T>(
  providers: Array<PerceptionProvider<T>>,
  options: PerceptionRunOptions = {},
): Promise<Array<PerceptionProviderResult<T>>> {
  options.signal?.throwIfAborted();
  return Promise.all(providers.map(provider => runProvider(provider, options)));
}

function runProvider<T>(
  provider: PerceptionProvider<T>,
  options: PerceptionRunOptions,
): Promise<PerceptionProviderResult<T>> {
  const started = performance.now();
  const controller = new AbortController();
  const notify = (state: PerceptionProgress['state'], error?: string) => {
    try {
      options.onProgress?.({provider: provider.id, state, latencyMs: performance.now() - started, ...(error ? {error} : {})});
    } catch {
      // A detached UI must not discard a completed read.
    }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const timers: {soft?: ReturnType<typeof setTimeout>; hard?: ReturnType<typeof setTimeout>} = {};
    const cleanup = () => {
      clearTimeout(timers.soft);
      clearTimeout(timers.hard);
      options.signal?.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      controller.abort(options.signal?.reason);
      notify('cancelled');
      reject(options.signal?.reason || new Error('perception_cancelled'));
    };
    const finish = (status: PerceptionProviderResult<T>['status'], value?: T, error?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      notify(status, error);
      resolve({id: provider.id, status, latencyMs: performance.now() - started, ...(value !== undefined ? {value} : {}), ...(error ? {error} : {})});
    };
    options.signal?.addEventListener('abort', cancel, {once: true});
    notify('reading');
    if (settled) {
      return;
    }
    timers.soft = setTimeout(() => {
      if (!settled) {
        notify('slow');
      }
    }, provider.softDeadlineMs);
    timers.hard = setTimeout(() => {
      const error = `perception_provider_timeout:${provider.id}`;
      finish('timeout', undefined, error);
      controller.abort(new Error(error));
    }, provider.hardDeadlineMs);
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return provider.read(controller.signal);
    }).then(value => finish('fulfilled', value), error => finish('rejected', undefined, error instanceof Error ? error.message : String(error)));
  });
}
