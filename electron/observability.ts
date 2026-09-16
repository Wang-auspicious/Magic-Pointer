import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Structured JSONL event log plus in-process counters. Kept intentionally
// small so main.js can load it without touching Electron APIs eagerly.
//
// The event log is *buffered*, for the same reason `main.ts`'s `log()` is
// (see electron/append_log.ts). It used to be `statSync` + `appendFileSync`
// per event — measured 0.38 ms on this machine — executed on the main thread
// that also services the 20 ms pointer poll and every IPC. Events are queued
// and written in one batch on a short timer; `flushEvents()` is called on the
// quit paths and from the fatal handler so a crash report is never left in
// memory.
//
// The rotation check no longer stats the file on every write. This module is
// the only writer, so it counts the bytes it appends and rotates when the
// counter crosses the limit; the counter is seeded from the real file size
// once, lazily, in case a previous process left a large log behind. The file
// layout the diagnostics collector depends on is unchanged:
// `events.jsonl`, `events.jsonl.1` … `events.jsonl.<history>`.
const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024;
const DEFAULT_HISTORY = 5;
const DEFAULT_FLUSH_INTERVAL_MS = 150;
// A burst of events (a crash loop) must not grow the buffer without bound
// between timer ticks.
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

// --- buffered append state -------------------------------------------------
const pendingLines: string[] = [];
let pendingBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Bytes this process believes are in `eventLogPath`. `null` means "not seeded
// yet"; the first flush reads the real size once.
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
    // No file yet (or unreadable): start the counter at zero. A large
    // pre-existing log that we cannot stat is not worth blocking on.
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
  // The rotated file is now `events.jsonl.1`; whatever we append next starts
  // the new file. The real size of a locked/replaced file is unknown, so this
  // is a best-effort reset — the next rotate check re-seeds only if the append
  // itself fails.
  writtenBytes = 0;
}

/** Write everything queued right now. Never throws. */
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
    // Either the directory vanished or the file is not writable right now.
    // Drop what we have rather than growing without bound, and let the next
    // flush recreate the directory.
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
  // Never hold the process open just for a log line.
  if (typeof flushTimer === 'object' && flushTimer !== null && 'unref' in flushTimer) {
    (flushTimer as unknown as { unref(): void }).unref();
  }
}

/** Queue one event. Never throws and never performs file I/O. */
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
  // Write session.start (and create `events.jsonl`) immediately rather than
  // waiting for the first timer tick: a diagnostics bundle collected from a
  // freshly started app must still find the file, and a crash in the first
  // 150 ms must still have the session header in it.
  flushEvents();
  return { eventLogPath, logDir };
}

function paths(): { logDir: string | null; eventLogPath: string | null } {
  return { logDir, eventLogPath };
}

// `flushEvents` is exported for the quit paths and the fatal handler: events
// queued for the 150 ms flush window live only in memory and would otherwise
// go with the process.
export { bump, flushEvents, install, paths, resetCounters, snapshotCounters, writeEvent };
