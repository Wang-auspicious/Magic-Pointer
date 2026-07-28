const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

assert(html.includes('id="agent-context-list"'), 'Agents page needs reusable Context Pack list');
assert(html.includes('切换执行者'), 'Agents page must name the provider switch action');
assert(js.includes("fabricRequest('agent.contexts.list'"), 'Dashboard must load sealed Agent contexts');
assert(js.includes("fabricRequest('agent.context.dispatch'"), 'Dashboard must dispatch by context id only');
assert(js.includes('context.contextPacketDigest'), 'UI must preserve the sealed packet identity');
assert(!html.includes('id="agent-context-scene"'), 'switching providers must not ask users to repeat scene text');
assert(main.includes("'agent.contexts.list'"));
assert(main.includes("'agent.context.dispatch'"));

console.log('dashboard agent context static test ok');
