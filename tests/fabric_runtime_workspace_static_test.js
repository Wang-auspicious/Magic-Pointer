'use strict';

// 工作区绑定必须由 fabric 引擎解析，Context Packet 要带上可核对的证据。
//
// 原本在 dashboard_runtime_workspace_static_test.js 里，另外三条断言钉的是
// 已删除的旧 dashboard.js 渲染文案，随界面一起去掉了。

const assert = require('assert');
const fs = require('fs');

const engine = fs.readFileSync('app/fabric/engine.py', 'utf8');
const packet = fs.readFileSync('app/fabric/context_packet.py', 'utf8');

assert(engine.includes('workspaceBindingRelation'), 'engine must report how the workspace was bound');
assert(packet.includes('recent diff excerpt'), 'context packet must carry a recent diff excerpt');
assert(packet.includes('launch command'), 'context packet must carry the launch command');

console.log('fabric runtime workspace static test ok');
