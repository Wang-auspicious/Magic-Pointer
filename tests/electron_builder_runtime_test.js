'use strict';

const assert = require('assert');
const path = require('path');
const { runBuild } = require('../scripts/run-electron-builder');

(function windowsPreparesRuntimeBeforeBuilder() {
  const calls = [];
  const exitCode = runBuild(['--win', '--dir'], {
    platform: 'win32',
    root: 'D:\\repo',
    electronDist: 'D:\\repo\\node_modules\\electron\\dist',
    electronBuilderCli: 'D:\\repo\\node_modules\\electron-builder\\out\\cli\\cli.js',
    nodeExecutable: 'node.exe',
    spawnSync: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  assert.strictEqual(exitCode, 0);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].command.toLowerCase(), 'powershell.exe');
  assert(calls[0].args.includes(path.join('D:\\repo', 'scripts', 'prepare_python_runtime.ps1')));
  assert.strictEqual(calls[1].command, 'node.exe');
  assert(calls[1].args.includes('-c.electronDist=D:\\repo\\node_modules\\electron\\dist'));
})();

(function prepareFailureStopsBuilder() {
  const calls = [];
  assert.throws(() => runBuild(['--win'], {
    platform: 'win32',
    root: 'D:\\repo',
    electronDist: 'D:\\repo\\electron',
    electronBuilderCli: 'D:\\repo\\builder.js',
    nodeExecutable: 'node.exe',
    spawnSync: (command, args) => {
      calls.push({ command, args });
      return { status: 9 };
    },
  }), /Python runtime preparation failed/);
  assert.strictEqual(calls.length, 1, 'electron-builder must not run after runtime preparation failure');
})();

(function nonWindowsDoesNotPrepareWindowsRuntime() {
  const calls = [];
  assert.strictEqual(runBuild(['--dir'], {
    platform: 'darwin',
    root: '/repo',
    electronDist: '/repo/electron',
    electronBuilderCli: '/repo/builder.js',
    nodeExecutable: 'node',
    spawnSync: (command, args) => { calls.push({ command, args }); return { status: 0 }; },
  }), 0);
  assert.strictEqual(calls.length, 1);
})();

console.log('electron builder runtime test ok');
