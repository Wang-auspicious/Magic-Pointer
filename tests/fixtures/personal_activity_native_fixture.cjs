'use strict';
const readline = require('node:readline');
let sequence = 0;
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function batch() {
  return { type: 'batch', runId: 'fixture', sequence: ++sequence, at: '2026-09-29T01:00:00.000Z',
    from: '2026-09-29T01:00:00.000Z', to: '2026-09-29T01:00:00.500Z',
    keyboard: { Enter: 2, KeyA: 1 }, injectedKeyboard: {},
    applications: [{ appId: 'notepad.exe', label: 'Notepad', activeMs: 500, activations: 1 }],
    coverage: { activeMs: 500, idleMs: 0, lockedMs: 0, unavailableMs: 0 },
    foreground: null, state: 'active', usedBackend: 'windows.wh-keyboard-ll+winevent' };
}
if (process.argv[2] === 'fail') {
  send({ type: 'error', code: 'keyboard_hook_failed:5', message: 'Access is denied.' });
  process.exitCode = 1;
} else {
  setTimeout(() => send({ type: 'ready', runId: 'fixture', pid: process.pid }), 15);
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const command = JSON.parse(line);
    if (command.command === 'flush') {
      const output = `${JSON.stringify(batch())}\n`;
      process.stdout.write(output.slice(0, 30));
      setTimeout(() => { process.stdout.write(output.slice(30)); send({ type: 'flushed', id: command.id }); }, 5);
    } else if (command.command === 'stop') {
      send(batch());
      send({ type: 'stopped' });
      process.exit(0);
    }
  });
}
