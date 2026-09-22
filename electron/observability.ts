import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024;
const DEFAULT_HISTORY = 5;
const DEFAULT_FLUSH_INTERVAL_MS = 150;
const DEFAULT_MAX_PENDING_BYTES = 256 * 1024;

interface InstallOptions {
  runtimeDir?: string;
  rotateBytes?: number;
  history?: number;
  enableCrashReporter?: boolean;
}

interface CrashReporter {
  start?: (options: {
    productName: string;
    companyName: string;
    submitURL: string;
    uploadToServer: boolean;
    compress: boolean;
    ignoreSystemCrashHandler: boolean;
  }) => void;
}

interface ElectronRuntime {
  crashReporter?: CrashReporter;
}

let logDir: string | null = null;
let eventLogPath: string | null = null;
let rotateBytes = DEFAULT_ROTATE_BYTES;
let historyCount = DEFAULT_HISTORY;
let counters = new Map<string, number>();
let installed = false;
let sessionId: string | null = null;

const pendingLines: string[] = [];
let pendingBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writtenBytes: number | null = null;
let directoryReady = false;

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(): void {
  if (!logDir || directoryReady) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    directoryReady = true;
  } catch {
    // Logging must never interrupt the desktop runtime.
  }
}

function seedWrittenBytes(): void {
  if (!eventLogPath || writtenBytes !== null) return;
  try {
    writtenBytes = fs.statSync(eventLogPath).size;
  } catch {
    writtenBytes = 0;
  }
}

function rotateIfNeeded(): void {
  if (!eventLogPath) return;
  seedWrittenBytes();
  if ((writtenBytes ?? 0) < rotateBytes) return;
  for (let index = historyCount - 1; index >= 1; index -= 1) {
    const older = `${eventLogPath}.${index}`;
    const newer = index === 1 ? eventLogPath : `${eventLogPath}.${index - 1}`;
    try {
      if (fs.existsSync(newer)) fs.renameSync(newer, older);
    } catch {
      // A locked historical log must not break event recording.
    }
  }
  writtenBytes = 0;
}

function flushEvents(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!eventLogPath || pendingLines.length === 0) return;
  const payload = pendingLines.join('');
  const bytes = Buffer.byteLength(payload, 'utf8');
  try {
    rotateIfNeeded();
  } catch (_) {
    // A failed rotation must not cost us the lines we are holding.
  }
  try {
    ensureDir();
    fs.appendFileSync(eventLogPath, payload, 'utf8');
    writtenBytes = (writtenBytes ?? 0) + bytes;
  } catch (_) {
    directoryReady = false;
    writtenBytes = null;
  } finally {
    pendingLines.length = 0;
    pendingBytes = 0;
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushEvents();
  }, DEFAULT_FLUSH_INTERVAL_MS);
  if (typeof flushTimer === 'object' && flushTimer !== null && 'unref' in flushTimer) {
    (flushTimer as unknown as { unref(): void }).unref();
  }
}

function writeEvent(type: unknown, payload?: Record<string, unknown> | null): void {
  if (!eventLogPath) return;
  const record: Record<string, unknown> = {
    ts: nowIso(),
    session: sessionId,
    type: String(type || 'event'),
    ...(payload && typeof payload === 'object' ? payload : {}),
  };
  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    line = `${JSON.stringify({
      ts: record.ts,
      session: sessionId,
      type: 'event.serialize_error',
    })}\n`;
  }
  pendingLines.push(line);
  pendingBytes += line.length;
  if (pendingBytes >= DEFAULT_MAX_PENDING_BYTES) {
    flushEvents();
    return;
  }
  scheduleFlush();
}

function bump(counter: unknown, delta = 1): void {
  if (!counter) return;
  const key = String(counter);
  const previous = counters.get(key) ?? 0;
  counters.set(key, previous + Number(delta || 0));
}

function snapshotCounters(): Record<string, number> {
  return Object.fromEntries(counters.entries());
}

function resetCounters(): void {
  counters = new Map<string, number>();
}

function install(options: InstallOptions = {}): {
  eventLogPath: string | null;
  logDir: string | null;
} {
  if (installed) return { eventLogPath, logDir };
  const {
    runtimeDir,
    rotateBytes: requestedRotateBytes,
    history,
    enableCrashReporter = true,
  } = options;
  logDir = runtimeDir || path.join(os.tmpdir(), 'magic-pointer-runtime');
  eventLogPath = path.join(logDir, 'events.jsonl');
  rotateBytes =
    Number(requestedRotateBytes) > 0 ? Number(requestedRotateBytes) : DEFAULT_ROTATE_BYTES;
  historyCount = Number(history) > 0 ? Number(history) : DEFAULT_HISTORY;
  sessionId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  ensureDir();
  writeEvent('session.start', {
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron || null,
  });
  if (enableCrashReporter) {
    try {
      const electron = require('electron') as ElectronRuntime;
      const reporter = electron.crashReporter;
      if (reporter && typeof reporter.start === 'function') {
        reporter.start({
          productName: 'Magic Pointer',
          companyName: 'Magic Pointer',
          submitURL: '',
          uploadToServer: false,
          compress: false,
          ignoreSystemCrashHandler: false,
        });
        writeEvent('crash_reporter.enabled', {});
      }
    } catch {
      // crashReporter is unavailable in non-Electron test contexts.
    }
  }
  installed = true;
  flushEvents();
  return { eventLogPath, logDir };
}

function paths(): { logDir: string | null; eventLogPath: string | null } {
  return { logDir, eventLogPath };
}

// `flushEvents` is exported for the quit paths and the fatal handler: events
export { bump, flushEvents, install, paths, resetCounters, snapshotCounters, writeEvent };
