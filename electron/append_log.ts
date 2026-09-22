'use strict';

import fs from 'node:fs';
import path from 'node:path';


interface AppendLogDependencies {
  appendFileSync?: (path: string, data: string, encoding: BufferEncoding) => void;
  mkdirSync?: (path: string, options: { recursive: boolean }) => unknown;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface CreateBufferedLogOptions {
  filePath: string;
  flushIntervalMs?: number;
  maxPendingLines?: number;
  dependencies?: AppendLogDependencies;
}

interface BufferedLog {
  log(message: unknown): void;
  flush(): void;
  pendingCount(): number;
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
