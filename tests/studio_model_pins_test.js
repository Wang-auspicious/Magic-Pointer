'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile('studio.ts', source, ts.ScriptTarget.Latest, true);
const names = ['modelEntries', 'readModelPins', 'writeModelPins', 'resolveModelPins', 'bindModelSeat'];
const statements = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
const storage = new Map();
let click;
const catalog = { current: 'one', groups: [{ models: ['one', 'two', 'three', 'four', 'five'].map(id => ({ id })) }] };
const context = {
  MODEL_PIN_LIMIT: 4, MODEL_PIN_STORAGE: 'mp:model-pins', modelPinsCache: null,
  modelCatalog: catalog, modelMoreOpen: true,
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  document: { getElementById: id => ({ addEventListener: (_event, handler) => { if (id === 'composer-model-menu') click = handler; } }) },
  renderModelMenu() {},
};
vm.runInNewContext(ts.transpileModule(statements.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);
context.bindModelSeat();
const pins = () => Array.from(context.resolveModelPins(catalog));
const toggle = id => click({ stopPropagation() {}, target: {
  closest: selector => selector === '[data-model-pin]' ? { dataset: { modelPin: id } } : null,
} });
(async () => {
  assert.deepEqual(pins(), ['one', 'two', 'three', 'four']);
  await toggle('three');
  assert(!pins().includes('three'), 'unchecking model 3 must survive the next render, without automatic refill');
  await toggle('five');
  assert.deepEqual(pins(), ['one', 'two', 'five', 'four'], 'replacement must occupy the vacated third slot');
  await toggle('one');
  assert(!pins().includes('one'), 'the active model may be unpinned without changing the active runtime');
  assert.equal(catalog.current, 'one');
  await toggle('two'); await toggle('five'); await toggle('four');
  assert.equal(pins().filter(Boolean).length, 0, 'an intentionally empty selection must not reset to defaults');
  await toggle('five');
  assert.equal(pins().filter(Boolean).length, 1);
  storage.clear(); context.modelPinsCache = null;
  const multi = { current: 'shared', currentProfileId: 'b', groups: [
    { profileId: 'a', models: [{ id: 'shared', contextWindow: 128000 }] },
    { profileId: 'b', models: [{ id: 'shared', contextWindow: 1000000 }] },
  ] };
  const qualified = Array.from(context.resolveModelPins(multi));
  assert.equal(qualified.filter(Boolean).length, 2, 'identical ids on two providers need distinct pins');
  assert.equal(context.modelEntries(multi).find(entry => entry.key === qualified[0]).profileId, 'b');
  assert.equal(context.modelEntries(multi)[1].contextWindow, 1000000, 'metadata must survive flattening');
  console.log('Studio model pins: uncheck, slot replacement, active unpin and empty preference passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
