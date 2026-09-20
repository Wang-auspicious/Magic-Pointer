'use strict';

// 模型席位合约：目录必须来自真实网关（fabric_bridge model.catalog），切换必须
// 更新对应 profile（没有 profile 时写 secrets）——不许渲染层自己编列表。

const assert = require('node:assert');
const fs = require('node:fs');

const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const data = fs.readFileSync('electron/renderer/data.ts', 'utf8');
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const bridge = fs.readFileSync('scripts/fabric_bridge.py', 'utf8');

assert.match(main, /ipcMain\.handle\('models:catalog'/, 'main must own the catalog IPC boundary');
assert.match(main, /ipcMain\.handle\('models:select'/, 'main must own the select IPC boundary');
assert(main.includes("operation: 'model.catalog'"), 'catalog must hit the fabric bridge op');
assert(main.includes("fs.writeFileSync(path.join(secretsDir, 'model.txt')"), 'legacy model selection must persist locally without a bridge cold start');
assert(preload.includes('modelsCatalog'), 'preload must expose the catalog');
assert(preload.includes('selectModel'), 'preload must expose the select');
assert(data.includes('async models()'), 'Data facade must expose models()');
assert(data.includes('async selectModel('), 'Data facade must expose selectModel()');
assert(studio.includes('openModelMenu'), 'the composer model seat must render the real directory');
assert(studio.includes('Data.selectModel(modelId, profileId)'), 'picking a row must select its model and provider');
assert.match(bridge, /operation == "model\.catalog"/, 'fabric bridge must implement model.catalog');
assert.match(bridge, /operation == "model\.select"/, 'fabric bridge must implement model.select');

console.log('model seat contract test ok');
