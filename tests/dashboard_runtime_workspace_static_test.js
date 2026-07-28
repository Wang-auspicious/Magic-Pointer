const assert = require('assert');
const fs = require('fs');

const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const engine = fs.readFileSync('app/fabric/engine.py', 'utf8');
const packet = fs.readFileSync('app/fabric/context_packet.py', 'utf8');

assert(js.includes("timelineStage('工作区'"));
assert(js.includes('workspaceBindingState'));
assert(js.includes('运行目标未解析 · 当前 cwd 仅作未验证回退'));
assert(engine.includes('workspaceBindingRelation'));
assert(packet.includes('recent diff excerpt'));
assert(packet.includes('launch command'));

console.log('dashboard runtime workspace static test ok');
