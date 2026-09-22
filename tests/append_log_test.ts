'use strict';

const assert = require('assert');

const { createBufferedLog } = require('../electron/append_log');


type Written = { path: string; data: string };

function harness(options: { failAppend?: boolean } = {}) {
  const written: Written[] = [];
  const mkdirs: string[] = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const cleared: unknown[] = [];
  let clock = 0;

  const log = createBufferedLog({
    filePath: 'C:/runtime/electron.log',
    flushIntervalMs: 150,
    dependencies: {
      appendFileSync: (path: string, data: string) => {
        if (options.failAppend) throw new Error('EACCES');
        written.push({ path, data });
      },
      mkdirSync: (path: string) => {
        mkdirs.push(path);
        return undefined;
      },
      now: () => new Date(Date.UTC(2026, 8, 16, 0, 0, clock++)),
      setTimer: (callback: () => void, delayMs: number) => {
        timers.push({ callback, delayMs });
        return timers.length;
      },
      clearTimer: (handle: unknown) => {
        cleared.push(handle);
      },
    },
  });

  return {
    log,
    written,
    mkdirs,
    timers,
    cleared,
    fireTimer: () => {
      const next = timers.shift();
      if (next) next.callback();
    },
    text: () => written.map((entry) => entry.data).join(''),
  };
}


{
  const h = harness();
  h.log.log('first');
  assert.strictEqual(h.written.length, 0, 'log() must not write to disk on the hot path');
  assert.strictEqual(h.mkdirs.length, 0, 'log() must not touch the filesystem on the hot path');
  assert.strictEqual(h.log.pendingCount(), 1);
  console.log('append_log_test: log() performs no file I/O');
}


{
  const h = harness();
  for (let i = 0; i < 50; i += 1) h.log.log(`line ${i}`);
  assert.strictEqual(h.timers.length, 1, '50 lines must arm one timer, not 50');
  h.fireTimer();
  assert.strictEqual(h.written.length, 1, '50 lines must become one append');
  assert.strictEqual(h.mkdirs.length, 1, 'the directory is created once, not per line');
  const lines = h.text().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 50);
  assert.ok(h.text().startsWith('2026-09-16T00:00:00.000Z line 0\n'));
  console.log('append_log_test: lines batch into a single append');
}


{
  const h = harness();
  h.log.log('a');
  h.log.log('b');
  h.log.log('c');
  h.fireTimer();
  const bodies = h.text().split('\n').filter(Boolean).map((line) => line.split(' ').pop());
  assert.deepStrictEqual(bodies, ['a', 'b', 'c'],
    'lines must be written in the order they were logged');
  console.log('append_log_test: order is preserved');
}


{
  const h = harness();
  h.log.log('urgent');
  h.log.flush();
  assert.strictEqual(h.written.length, 1, 'flush() writes immediately');
  h.log.flush();
  assert.strictEqual(h.written.length, 1, 'flush() with nothing pending is a no-op');
  assert.strictEqual(h.log.pendingCount(), 0);
  console.log('append_log_test: flush() is immediate and idempotent');
}


{
  const written: Written[] = [];
  const log = createBufferedLog({
    filePath: 'C:/runtime/electron.log',
    maxPendingLines: 10,
    dependencies: {
      appendFileSync: (path: string, data: string) => written.push({ path, data }),
      mkdirSync: () => undefined,
      now: () => new Date(0),
      setTimer: () => 1,
      clearTimer: () => {},
    },
  });
  for (let i = 0; i < 10; i += 1) log.log(`line ${i}`);
  assert.strictEqual(log.pendingCount(), 0, 'hitting the ceiling must force a flush');
  assert.strictEqual(written.length, 1);
  console.log('append_log_test: a burst cannot grow the buffer without bound');
}


{
  const h = harness({ failAppend: true });
  h.log.log('dropped');
  h.fireTimer();  
  assert.strictEqual(h.log.pendingCount(), 0, 'a failed write must not accumulate forever');
  console.log('append_log_test: a failing append never throws and never accumulates');
}

{
  const written: Written[] = [];
  const log = createBufferedLog({
    filePath: 'C:/runtime/electron.log',
    dependencies: {
      appendFileSync: (path: string, data: string) => written.push({ path, data }),
      mkdirSync: () => undefined,
      now: () => {
        throw new Error('no clock');
      },
      setTimer: () => 1,
      clearTimer: () => {},
    },
  });
  log.log('ignored');  
  log.flush();
  assert.strictEqual(written.length, 0);
  console.log('append_log_test: a throwing clock is swallowed');
}


{
  let attempts = 0;
  const written: Written[] = [];
  const log = createBufferedLog({
    filePath: 'C:/runtime/electron.log',
    dependencies: {
      appendFileSync: (path: string, data: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error('ENOENT');
        written.push({ path, data });
      },
      mkdirSync: () => undefined,
      now: () => new Date(0),
      setTimer: () => 1,
      clearTimer: () => {},
    },
  });
  log.log('first');
  log.flush();
  log.log('second');
  log.flush();
  assert.strictEqual(written.length, 1, 'a write after a failure must be retried');
  console.log('append_log_test: the directory is recreated after a failed write');
}


{
  const h = harness();
  h.log.log('kept');
  h.log.dispose();
  assert.strictEqual(h.cleared.length >= 1, true, 'dispose() must cancel the pending timer');
  assert.strictEqual(h.log.pendingCount(), 1, 'dispose() discards nothing');
  h.log.flush();
  assert.strictEqual(h.written.length, 1);
  console.log('append_log_test: dispose() cancels the timer without discarding');
}

console.log('append_log_test: all assertions passed');
