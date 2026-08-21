'use strict';

import crypto from 'node:crypto';
import { spawn, type SpawnOptions } from 'node:child_process';

interface ProgressRecord {
  phase: string;
  ms: number | null;
  fields: Record<string, string>;
}

const { createProgressLineSplitter } = require('./bridge_progress_lines') as {
  createProgressLineSplitter(
    onProgress: (record: ProgressRecord) => void,
  ): (chunk: unknown) => void;
};

interface ReadableBridgeStream {
  off?(event: 'data', listener: (chunk: unknown) => void): unknown;
  on?(event: 'data', listener: (chunk: unknown) => void): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
}

interface WritableBridgeStream {
  on?(event: 'error', listener: (error: unknown) => void): unknown;
  write(value: string): unknown;
  end(): unknown;
}

interface BridgeChild {
  stdout?: ReadableBridgeStream | null;
  stderr?: ReadableBridgeStream | null;
  stdin: WritableBridgeStream;
  kill(): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  cancel?: () => void;
}

type SpawnImpl = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => BridgeChild;
type TimerHandle = unknown;
type SetTimeoutImpl = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimeoutImpl = (handle: TimerHandle) => void;
type BridgeResult = Record<string, unknown>;

interface RunnerDependencies {
  spawnImpl?: SpawnImpl;
  setTimeoutImpl?: SetTimeoutImpl;
  clearTimeoutImpl?: ClearTimeoutImpl;
}

interface RunOptions {
  executable?: string;
  args?: string[];
  spawnOptions?: SpawnOptions;
  input?: unknown;
  /** How long the bridge may stay *silent* before it counts as hung. Every
   * chunk of stdout/stderr re-arms it, so an agent that keeps working keeps
   * running. */
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal | null;
  onComplete?: (result: BridgeResult) => void;
  onProgress?: ((record: ProgressRecord) => void) | null;
  logger?: (message: string) => void;
}

interface PythonBridgeRunner {
  run(options?: RunOptions): BridgeChild;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createPythonBridgeRunner({
  spawnImpl = spawn as unknown as SpawnImpl,
  setTimeoutImpl = setTimeout as unknown as SetTimeoutImpl,
  clearTimeoutImpl = clearTimeout as unknown as ClearTimeoutImpl,
}: RunnerDependencies = {}): PythonBridgeRunner {
  function run({
    executable,
    args = [],
    spawnOptions = {},
    input = {},
    timeoutMs = 60_000,
    maxStdoutBytes = 1024 * 1024,
    maxStderrBytes = 256 * 1024,
    signal = null,
    onComplete,
    onProgress = null,
    logger,
  }: RunOptions = {}): BridgeChild {
    const log: (message: string) => void = typeof logger === 'function' ? logger : () => {};
    const complete: (result: BridgeResult) => void =
      typeof onComplete === 'function' ? onComplete : () => {};
    // Progress is opt-in: without a consumer no splitter is built and stderr
    // handling is byte-for-byte what it was before.
    const feedProgress =
      typeof onProgress === 'function'
        ? createProgressLineSplitter((record) => {
            if (!delivered) onProgress(record);
          })
        : null;
    const child = spawnImpl(executable as string, args, spawnOptions);
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let delivered = false;
    let timer: TimerHandle | null = null;

    const detach = (): void => {
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
      child.stdout?.off?.('data', onStdout);
      child.stderr?.off?.('data', onStderr);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const deliver = (value: BridgeResult): void => {
      if (delivered) return;
      delivered = true;
      detach();
      complete(value);
    };
    const stop = (value: BridgeResult): void => {
      try {
        child.kill();
      } catch {
        // A process that already exited still needs its final result delivered.
      }
      deliver(value);
    };
    const armIdleDeadline = (): void => {
      if (delivered) return;
      if (timer !== null) clearTimeoutImpl(timer);
      timer = setTimeoutImpl(
        () => stop({ ok: false, error: 'bridge_timeout' }),
        Math.max(1, Number(timeoutMs) || 60_000),
      );
    };
    const append = (stream: 'stdout' | 'stderr', chunk: unknown): void => {
      // Any output is proof of life. The deadline measures silence, not
      // elapsed time: a wall-clock kill caps how long a task may take
      // regardless of whether it is making progress, which is the wrong
      // question to ask of an agent that may legitimately run for hours.
      armIdleDeadline();
      const text = String(chunk);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (stream === 'stdout') {
        stdoutBytes += bytes;
        if (stdoutBytes > maxStdoutBytes) {
          stop({ ok: false, error: 'bridge_output_limit', stream: 'stdout' });
          return;
        }
        stdout += text;
      } else {
        stderrBytes += bytes;
        if (feedProgress) feedProgress(text);
        if (stderrBytes > maxStderrBytes) {
          stop({ ok: false, error: 'bridge_output_limit', stream: 'stderr' });
          return;
        }
        stderr += text;
      }
    };
    const onStdout = (chunk: unknown): void => append('stdout', chunk);
    const onStderr = (chunk: unknown): void => append('stderr', chunk);
    const onAbort = (): void => stop({ ok: false, error: 'bridge_cancelled' });

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', onStdout);
    child.stderr?.on?.('data', onStderr);
    child.on('error', (error) => {
      log(`bridge spawn error ${errorName(error)}: ${errorMessage(error)}`);
      deliver({
        ok: false,
        error: 'bridge_spawn_error',
        detail: errorMessage(error).slice(0, 500),
      });
    });
    child.on('close', (code) => {
      if (delivered) return;
      let parsed: BridgeResult;
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const decoded: unknown = JSON.parse(lines.at(-1) || '{}');
        parsed =
          decoded && typeof decoded === 'object'
            ? (decoded as BridgeResult)
            : { ok: false, error: 'bridge_invalid_json' };
      } catch {
        deliver({
          ok: false,
          error: 'bridge_invalid_json',
          stdout_sha256: crypto.createHash('sha256').update(stdout).digest('hex'),
        });
        return;
      }
      if (code !== 0 && parsed?.ok !== true) {
        parsed.code = code;
        parsed.stderr = stderr.slice(0, 2000);
        parsed.stderr_sha256 = crypto.createHash('sha256').update(stderr).digest('hex');
      }
      deliver(parsed);
    });
    child.stdin?.on?.('error', (error) => {
      log(`bridge stdin error ${errorName(error)}: ${errorMessage(error)}`);
      deliver({ ok: false, error: 'bridge_stdin_error' });
    });

    armIdleDeadline();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (!delivered) {
      try {
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
      } catch (error) {
        deliver({
          ok: false,
          error: 'bridge_stdin_error',
          detail: errorMessage(error).slice(0, 500),
        });
      }
    }
    child.cancel = onAbort;
    return child;
  }

  return { run };
}

export { createPythonBridgeRunner };
