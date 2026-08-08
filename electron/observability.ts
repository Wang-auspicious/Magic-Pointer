import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Structured JSONL event log plus in-process counters. Kept intentionally
// small so main.js can load it without touching Electron APIs eagerly.
const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024;
const DEFAULT_HISTORY = 5;

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

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(): void {
  if (!logDir) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Logging must never interrupt the desktop runtime.
  }
}

function rotateIfNeeded(): void {
  if (!eventLogPath) return;
  let size = 0;
  try {
    size = fs.statSync(eventLogPath).size;
  } catch {
    return;
  }
  if (size < rotateBytes) return;
  for (let index = historyCount - 1; index >= 1; index -= 1) {
    const older = `${eventLogPath}.${index}`;
    const newer = index === 1 ? eventLogPath : `${eventLogPath}.${index - 1}`;
    try {
      if (fs.existsSync(newer)) fs.renameSync(newer, older);
    } catch {
      // A locked historical log must not break event recording.
    }
  }
}

function writeEvent(type: unknown, payload?: Record<string, unknown> | null): void {
  if (!eventLogPath) return;
  ensureDir();
  rotateIfNeeded();
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
  try {
    fs.appendFileSync(eventLogPath, line, 'utf8');
  } catch {
    // Logging must not throw.
  }
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
  return { eventLogPath, logDir };
}

function paths(): { logDir: string | null; eventLogPath: string | null } {
  return { logDir, eventLogPath };
}

export { bump, install, paths, resetCounters, snapshotCounters, writeEvent };
