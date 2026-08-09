'use strict';

// Fabric 主进程/预加载侧的接线契约。
//
// 这些断言原本长在 fabric_dashboard_static_test.js 里，和已删除的旧
// dashboard.html 混在一起。旧界面没了，但桥接通道、运行时快照和校准入口
// 仍然是活的产品契约，所以单独钉在这里。

const assert = require('assert');
const fs = require('fs');

const tokens = fs.readFileSync('electron/renderer/tokens.css', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');

assert(tokens.includes('--mp-blue:'), 'shared tokens must define the accent blue');
assert(tokens.includes('--mp-canvas:'), 'shared tokens must define the canvas surface');

for (const channel of ['fabricRequest', 'runtimeSnapshot', 'saveFabricSettings', 'onFabricState']) {
  assert(preload.includes(channel), `preload must expose ${channel}`);
}

assert(main.includes("'scripts/fabric_bridge.py'"), 'main must route fabric operations to the bridge');
assert(main.includes("'dashboard:fabric-request'"), 'main must accept fabric requests');
assert(main.includes("'dashboard:fabric-state'"), 'main must push fabric state back');
assert(main.includes("operation === 'calibration.start'"), 'calibration must be a bounded operation');
assert(main.includes('wiggleDetector.startCalibration'), 'calibration must start the real detector');
assert(main.includes('wiggleDetector.finishCalibration'), 'calibration must finish the real detector');

console.log('fabric bridge wiring static test ok');
