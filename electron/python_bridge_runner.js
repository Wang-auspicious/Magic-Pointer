'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const { createProgressLineSplitter } = require('./bridge_progress_lines');

function createPythonBridgeRunner({
  spawnImpl = spawn,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
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
  } = {}) {
    const log = typeof logger === 'function' ? logger : () => {};
    const complete = typeof onComplete === 'function' ? onComplete : () => {};
    // Progress is opt-in: without a consumer no splitter is built and stderr
    // handling is byte-for-byte what it was before.
    const feedProgress = typeof onProgress === 'function'
      ? createProgressLineSplitter((record) => { if (!delivered) onProgress(record); })
      : null;
    const child = spawnImpl(executable, args, spawnOptions);
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let delivered = false;
    let timer = null;

    const detach = () => {
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
      child.stdout?.off?.('data', onStdout);
      child.stderr?.off?.('data', onStderr);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const deliver = (value) => {
      if (delivered) return;
      delivered = true;
      detach();
      complete(value);
    };
    const stop = (value) => {
      try { child.kill(); } catch (_) {}
      deliver(value);
    };
    const append = (stream, chunk) => {
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
    const onStdout = chunk => append('stdout', chunk);
    const onStderr = chunk => append('stderr', chunk);
    const onAbort = () => stop({ ok: false, error: 'bridge_cancelled' });

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', onStdout);
    child.stderr?.on?.('data', onStderr);
    child.on('error', (error) => {
      log(`bridge spawn error ${error?.name || 'Error'}: ${error?.message || error}`);
      deliver({ ok: false, error: 'bridge_spawn_error', detail: String(error?.message || error).slice(0, 500) });
    });
    child.on('close', (code) => {
      if (delivered) return;
      let parsed;
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        parsed = JSON.parse(lines.at(-1) || '{}');
      } catch (_) {
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
      log(`bridge stdin error ${error?.name || 'Error'}: ${error?.message || error}`);
      deliver({ ok: false, error: 'bridge_stdin_error' });
    });

    timer = setTimeoutImpl(() => stop({ ok: false, error: 'bridge_timeout' }), Math.max(1, Number(timeoutMs) || 60_000));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (!delivered) {
      try {
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
      } catch (error) {
        deliver({ ok: false, error: 'bridge_stdin_error', detail: String(error?.message || error).slice(0, 500) });
      }
    }
    child.cancel = onAbort;
    return child;
  }

  return { run };
}

module.exports = { createPythonBridgeRunner };
