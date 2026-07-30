'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Structured JSONL event log plus in-process counters. Kept intentionally
// small so it can be required from main.js without touching electron APIs
// eagerly — electron.app / crashReporter are looked up lazily on install().

const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024;
const DEFAULT_HISTORY = 5;

let logDir = null;
let eventLogPath = null;
let rotateBytes = DEFAULT_ROTATE_BYTES;
let historyCount = DEFAULT_HISTORY;
let counters = new Map();
let installed = false;
let sessionId = null;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  if (!logDir) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (_) {
    // ignore
  }
}

function rotateIfNeeded() {
  if (!eventLogPath) return;
  let size = 0;
  try {
    size = fs.statSync(eventLogPath).size;
  } catch (_) {
    return;
  }
  if (size < rotateBytes) return;
  for (let i = historyCount - 1; i >= 1; i -= 1) {
    const older = `${eventLogPath}.${i}`;
    const newer = i === 1 ? eventLogPath : `${eventLogPath}.${i - 1}`;
    try {
      if (fs.existsSync(newer)) fs.renameSync(newer, older);
    } catch (_) {
      // ignore
    }
  }
}

function writeEvent(type, payload) {
  if (!eventLogPath) return;
  ensureDir();
  rotateIfNeeded();
  const record = {
    ts: nowIso(),
    session: sessionId,
    type: String(type || 'event'),
    ...(payload && typeof payload === 'object' ? payload : {}),
  };
  let line;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (_) {
    line = `${JSON.stringify({ ts: record.ts, session: sessionId, type: 'event.serialize_error' })}\n`;
  }
  try {
    fs.appendFileSync(eventLogPath, line, 'utf8');
  } catch (_) {
    // logging must not throw
  }
}

function bump(counter, delta = 1) {
  if (!counter) return;
  const key = String(counter);
  const prev = counters.get(key) || 0;
  counters.set(key, prev + Number(delta || 0));
}

function snapshotCounters() {
  const out = {};
  for (const [k, v] of counters.entries()) out[k] = v;
  return out;
}

function resetCounters() {
  counters = new Map();
}

function install(options = {}) {
  if (installed) return { eventLogPath, logDir };
  const {
    runtimeDir,
    rotateBytes: rb,
    history,
    enableCrashReporter = true,
  } = options;
  logDir = runtimeDir || path.join(os.tmpdir(), 'magic-pointer-runtime');
  eventLogPath = path.join(logDir, 'events.jsonl');
  rotateBytes = Number(rb) > 0 ? Number(rb) : DEFAULT_ROTATE_BYTES;
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
      const electron = require('electron');
      if (electron && electron.crashReporter && typeof electron.crashReporter.start === 'function') {
        electron.crashReporter.start({
          productName: 'Magic Pointer',
          companyName: 'Magic Pointer',
          submitURL: '',
          uploadToServer: false,
          compress: false,
          ignoreSystemCrashHandler: false,
        });
        writeEvent('crash_reporter.enabled', {});
      }
    } catch (_) {
      // crashReporter unavailable in non-electron test contexts
    }
  }
  installed = true;
  return { eventLogPath, logDir };
}

function paths() {
  return { logDir, eventLogPath };
}

module.exports = {
  install,
  writeEvent,
  bump,
  snapshotCounters,
  resetCounters,
  paths,
};
