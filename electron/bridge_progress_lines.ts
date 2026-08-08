'use strict';

// Bridges emit phase timings on stderr so the main process can react before the
// process exits. stdout stays a pure JSON contract (python_bridge_runner only
// parses its last line), and stderr keeps flowing into electron.log unchanged —
// progress lines are additive, never a replacement.
//
// Wire format, one per line:
//   @@mp phase=<name> ms=<int> [key=value ...]
//
// Keys and values are whitespace-free tokens. Anything unparseable is dropped
// rather than thrown: a malformed diagnostic must never take down a capture.

const PROGRESS_PREFIX = '@@mp ';
const MAX_PENDING_BYTES = 8192;

type ProgressRecord = {
  phase: string;
  ms: number | null;
  fields: Record<string, string>;
};

function parseProgressLine(line: unknown): ProgressRecord | null {
  const text = String(line == null ? '' : line).trim();
  if (!text.startsWith(PROGRESS_PREFIX)) return null;
  const tokens = text.slice(PROGRESS_PREFIX.length).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const fields: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    fields[token.slice(0, eq)] = token.slice(eq + 1);
  }
  const phase = String(fields.phase || '').trim();
  if (!phase) return null;
  const ms = Number(fields.ms);
  return { phase, ms: Number.isFinite(ms) ? ms : null, fields };
}

// Returns a chunk consumer that tolerates progress records split across stream
// chunks. The trailing partial line is held until its newline arrives.
function createProgressLineSplitter(onProgress: unknown): (chunk: unknown) => void {
  const emit: (record: ProgressRecord) => void =
    typeof onProgress === 'function' ? (onProgress as (record: ProgressRecord) => void) : () => {};
  let pending = '';
  return (chunk) => {
    pending += String(chunk == null ? '' : chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    // A writer that never emits a newline must not grow this buffer forever.
    if (pending.length > MAX_PENDING_BYTES) pending = '';
    for (const line of lines) {
      const record = parseProgressLine(line);
      if (!record) continue;
      try {
        emit(record);
      } catch (_) {
        // A throwing consumer is a caller bug; it must not kill the bridge.
      }
    }
  };
}

module.exports = { PROGRESS_PREFIX, parseProgressLine, createProgressLineSplitter };
