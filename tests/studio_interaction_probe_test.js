'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.resolve('scripts/probe_studio_interactions.ts');
const built = path.resolve('build/scripts/probe_studio_interactions.js');
const output = path.resolve('data/runtime/studio-claude-interactions-20260905.png');

assert(fs.existsSync(source), 'real-input Studio interaction probe source must exist');
assert(fs.existsSync(built), 'run `npm run build:electron` before the interaction probe');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(process.execPath, [built, '--output', output], {
  cwd: path.resolve('.'),
  env,
  encoding: 'utf8',
  timeout: 30_000,
});
assert.strictEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('INTERACTION_PROBE='));
assert(line, `probe did not emit its JSON witness:\n${result.stdout}`);
const witness = JSON.parse(line.slice('INTERACTION_PROBE='.length));

assert.deepStrictEqual(witness.consoleErrors, []);
assert.strictEqual(witness.account.open, true);
assert.strictEqual(witness.account.settingsOpened, true);
assert.strictEqual(witness.permission.selected, 'Manual');
assert.strictEqual(witness.model.selected, 'claude-sonnet-4');
assert.strictEqual(witness.effort.selected, 'Max');
/* effort 是一根滑块：能读的是两端的方向和刻度数，档名是当前那一档。
   点击轨道最右端必须落到最高档，这一条同时验了命中区域和吸附。 */
assert.deepStrictEqual(witness.effort.labels.scale, ['Faster', 'Smarter']);
assert.strictEqual(witness.effort.labels.ticks, 5,
  'one tick per effort level, so the slider cannot point between levels');
// 滑块打开的档位来自上一次会话（档位是持久偏好），所以这里只验它落在五个
// 合法档名之一——具体是哪一档由用户的最后一次选择决定。
assert(['Low', 'Medium', 'High', 'Extra', 'Max'].includes(witness.effort.labels.current),
  `the slider opens on a real level, got ${witness.effort.labels.current}`);
assert.strictEqual(witness.home.view, 'models');
assert.strictEqual(witness.home.range, '30d');
assert.strictEqual(witness.stash.noteDialogOpen, true);
assert.strictEqual(witness.stash.noteInput, true);
assert(witness.home.modelRows > 0);
assert.strictEqual(witness.tooltip.open, true);
assert.match(witness.tooltip.text, /messages/);

for (const name of ['account', 'permission', 'model', 'effort', 'tooltip']) {
  const bounds = witness[name].bounds;
  assert(bounds && bounds.width > 0 && bounds.height > 0, `${name} has no visible bounds`);
  assert(bounds.left >= 0 && bounds.top >= 0, `${name} escapes the viewport origin`);
  assert(bounds.right <= witness.viewport.width && bounds.bottom <= witness.viewport.height,
    `${name} is clipped by the viewport: ${JSON.stringify(bounds)}`);
}

assert(fs.existsSync(output) && fs.statSync(output).size > 10_000,
  'probe must leave a non-empty screenshot witness');
for (const name of ['account', 'permission', 'model', 'effort']) {
  const screenshot = witness.screenshots?.[name];
  assert(screenshot && fs.existsSync(screenshot) && fs.statSync(screenshot).size > 10_000,
    `probe must preserve a visual witness for ${name}`);
}

console.log('studio interaction probe test ok');
