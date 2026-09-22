const assert = require('node:assert/strict');
const { runBuild } = require('../scripts/run-electron-builder');
for (const platform of ['win32', 'darwin']) {
  const calls = [];
  const code = runBuild(['--dir'], { platform, root: 'D:\\repo', electronDist: 'D:\\repo\\electron', electronBuilderCli: 'D:\\repo\\builder.js', nodeExecutable: 'node', spawnSync: (file, args) => { calls.push({ file, args }); return { status: 0 }; } });
  assert.equal(code, 0); assert.equal(calls.length, 1); assert.equal(calls[0].file, 'node'); assert.ok(calls[0].args.includes('-c.electronDist=D:\\repo\\electron'));
}
assert.equal(runBuild(['--dir'], { root: 'D:\\repo', electronDist: 'D:\\repo\\electron', electronBuilderCli: 'builder.js', spawnSync: () => ({ status: 9 }) }), 9);
assert.throws(() => runBuild(['--dir'], { root: 'D:\\repo', electronDist: 'D:\\repo\\electron', electronBuilderCli: 'builder.js', spawnSync: () => ({ status: null, error: new Error('builder failed') }) }), /builder failed/);
console.log('electron builder runtime tests passed');
