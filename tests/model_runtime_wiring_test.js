const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.ts'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'selection_worker.py'), 'utf8');
const expandBridge = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'expand_passage_bridge.py'), 'utf8');

assert.match(main, /modelRuntime:\s*activeModelRuntimeConfig\(\)/,
  'selection requests must carry the selected model profile and decrypted request credential');
assert.match(worker, /request_ai_config\(payload\.get\("modelRuntime"\)\)/,
  'the resident selection worker must bind model configuration to exactly one request');
assert.match(main, /passage,[\s\S]{0,180}modelRuntime:\s*activeModelRuntimeConfig\(\)/,
  'inline expansion must use the same selected model as the original answer');
assert.match(expandBridge, /request_ai_config\(payload\.get\("modelRuntime"\)\)/,
  'the one-shot expansion bridge must bind the selected model to its request');

console.log('model runtime wiring test ok');
