'use strict';

// `+` 菜单合约：它必须是 DSH 的命令/技能目录，不是本地假动作。
// 目录从本机扫描来（slash.directory → skill_catalog），选中插入 `/name `，
// 提交由 conversation_bridge.route_slash_command 结算并带副作用。

const assert = require('node:assert');
const fs = require('node:fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const data = fs.readFileSync('electron/renderer/data.ts', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const bridge = fs.readFileSync('scripts/conversation_bridge.py', 'utf8');
const fabric = fs.readFileSync('scripts/fabric_bridge.py', 'utf8');

assert(main.includes("ipcMain.handle('slash:directory'"), 'main must own the slash directory IPC');
assert(preload.includes('slashDirectory'), 'preload must expose the directory');
assert(data.includes('async slashDirectory()'), 'Data facade must expose the directory');
assert(html.includes('composer-slash-search'), 'the menu must carry a search box');
assert(html.includes('composer-slash-rows'), 'the menu must render grouped rows');
assert(!html.includes('data-composer-act'), 'the fake copy/origin actions must be gone');
assert(studio.includes("textContent = '命令'"), 'command group header');
assert(studio.includes("textContent = '技能'"), 'skill group header');
assert(studio.includes('insertSlashToken'), 'picking a row must insert the /name token');
assert(studio.includes("token = `/${name} `"), 'the token is the DSH /name-then-space form');
assert.match(fabric, /operation == "slash\.directory"/, 'fabric bridge must serve the directory');
assert.match(bridge, /def route_slash_command/, 'the bridge must route slash commands');
assert(bridge.includes('load_skill_body'), 'known skills must inject their rendered body');
assert(studio.includes('command?.type === \'permission\''), 'permission settlement must move the chip');
assert(studio.includes('command?.type === \'model\''), 'model settlement must refresh the model seat');

console.log('slash menu contract test ok');
