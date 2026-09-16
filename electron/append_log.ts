'use strict';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Buffered append-only log for the Electron main process.
 *
 * Why this exists: `log()` used to be `mkdirSync` + `appendFileSync` per call,
 * and there are ~150 call sites — including one in the per-record path of
 * every bridge progress line. Measured on this machine that is **1.20 ms per
 * call** (0.56 ms of it the append alone), executed on the same thread that
 * services the 20 ms pointer poll and every IPC. A log line is not worth
 * blocking the UI for.
 *
 * The fix is to make `log()` a push and move the file I/O to a timer. Batching
 * also collapses N syscalls into one, and the directory is created once rather
 * than re-checked 150 times a second.
 *
 * Deliberately synchronous on flush, and deliberately not async `appendFile`:
 * a pending async write can land *after* the synchronous flush at shutdown and
 * invert the tail of the log, which is exactly the part anyone reads when
 * something went wrong. One syscall every `flushIntervalMs` is off the hot
 * path; the ordering guarantee is worth more than the thread-pool hop.
 *
 * Logging must never break the overlay, so every path here swallows its
 * errors. A dropped line is acceptable; a thrown exception is not.
 */

interface AppendLogDependencies {
  appendFileSync?: (path: string, data: string, encoding: BufferEncoding) => void;
  mkdirSync?: (path: string, options: { recursive: boolean }) => unknown;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface CreateBufferedLogOptions {
  /** Absolute path of the log file. Its parent directory is created on demand. */
  filePath: string;
  /** How long a line may sit in the buffer before it is written. */
  flushIntervalMs?: number;
  /**
   * Force a flush once this many lines are buffered. Without a ceiling, a burst
   * of logging (a crash loop, a runaway tool) would grow the buffer without
   * bound for as long as the timer keeps being pushed back.
   */
  maxPendingLines?: number;
  dependencies?: AppendLogDependencies;
}

interface BufferedLog {
  /** Queue one line. Never throws, never performs file I/O. */
  log(message: unknown): void;
  /** Write everything queued right now. Safe to call from any state. */
  flush(): void;
  /** Lines queued but not yet written. For tests and diagnostics. */
  pendingCount(): number;
  /** Stop the flush timer. Does not discard anything still queued. */
  dispose(): void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 150;
const DEFAULT_MAX_PENDING_LINES = 5000;

function createBufferedLog({
  filePath,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  maxPendingLines = DEFAULT_MAX_PENDING_LINES,
  dependencies = {},
}: CreateBufferedLogOptions): BufferedLog {
  const appendFileSync = dependencies.appendFileSync
    || ((target: string, data: string, encoding: BufferEncoding) => {
      fs.appendFileSync(target, data, encoding);
    });
  const mkdirSync = dependencies.mkdirSync
    || ((target: string, options: { recursive: boolean }) => {
      fs.mkdirSync(target, options);
    });
  const now = dependencies.now || (() => new Date());
  const setTimer = dependencies.setTimer
    || ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = dependencies.clearTimer
    || ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const directory = path.dirname(filePath);
  const pending: string[] = [];
  let timer: unknown = null;
  // The directory is created once and assumed to exist thereafter. On a write
  // failure this is reset, so a directory removed underneath us is recreated
  // on the next flush rather than silently losing every later line.
  let directoryReady = false;

  function ensureDirectory(): void {
    if (directoryReady) return;
    mkdirSync(directory, { recursive: true });
    directoryReady = true;
  }

  function clearFlushTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function flush(): void {
    clearFlushTimer();
    if (pending.length === 0) return;
    const payload = pending.join('');
    try {
      ensureDirectory();
      appendFileSync(filePath, payload, 'utf8');
      pending.length = 0;
    } catch (_) {
      // Either the directory vanished or the file is not writable right now.
      // Drop what we have rather than growing without bound, and let the next
      // flush try the directory again.
      directoryReady = false;
      pending.length = 0;
    }
  }

  function log(message: unknown): void {
    try {
      pending.push(`${now().toISOString()} ${message}\n`);
    } catch (_) {
      return;
    }
    if (pending.length >= maxPendingLines) {
      flush();
      return;
    }
    if (timer === null) {
      timer = setTimer(() => {
        timer = null;
        flush();
      }, flushIntervalMs);
    }
  }

  return {
    log,
    flush,
    pendingCount: () => pending.length,
    dispose: clearFlushTimer,
  };
}

module.exports = { createBufferedLog };
