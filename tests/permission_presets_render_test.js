'use strict';


const assert = require('assert');
const { PRESETS, PRIMARY_PRESETS, optionOf, presetSvg } = require('../electron/renderer/permission_presets');

const VALUES = PRESETS.map(option => option.value);
assert.deepStrictEqual(VALUES,
  ['auto', 'read-only', 'workspace-write', 'plan', 'danger-full-access'],
  `预设表顺序/取值：${VALUES}`);
assert.deepStrictEqual(PRESETS.map(option => option.label), [
  'Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions',
]);
assert.deepStrictEqual(PRIMARY_PRESETS.map(option => option.value), [
  'auto', 'workspace-write', 'plan', 'danger-full-access',
]);
assert.deepStrictEqual(PRESETS.map(option => option.shortcut || ''),
  ['1', '2', '3', '4', '']);
assert.strictEqual(optionOf('danger-full-access').action, 'Enable');
assert.strictEqual(optionOf('auto').badge, 'Start');
assert.strictEqual(optionOf('workspace-write').label, 'Accept edits');
assert.strictEqual(optionOf('danger-full-access').label, 'Bypass permissions');
assert.strictEqual(optionOf('read-only').label, 'Manual');
assert.strictEqual(optionOf('plan').description, 'Create a plan before making changes');
assert.strictEqual(optionOf('workspace-write').description, 'Automatically accept all file edits');
assert.strictEqual(optionOf('danger-full-access').description, 'Accepts all permissions');
assert.strictEqual(optionOf('read-only').description, 'Always ask before making changes');
assert.strictEqual(optionOf('read-only').primary, false);

for (const option of PRESETS) {
  assert.ok(option.name && option.description, `${option.value} 需要名称与描述`);
  const svg = presetSvg(option);
  assert.ok(svg.startsWith('<svg'), `${option.value} 的 SVG 可渲染`);
  assert.ok(svg.includes('viewBox="0 0 24 24"') && svg.includes('stroke-width="1.5"'),
    `${option.value} 必须使用 Studio 统一的 24px / 1.5px 线性图标`);
}

const full = optionOf('danger-full-access');
assert.ok(full && full.confirm && full.confirm.title.includes('Full access'));
assert.ok(PRESETS.filter(o => o.value !== 'danger-full-access').every(o => !o.confirm));

const custom = optionOf('custom');
assert.ok(custom && custom.value === 'custom');
assert.ok(!VALUES.includes('custom'));

assert.strictEqual(optionOf('bypass'), undefined);
assert.ok(optionOf('plan') && optionOf('plan').value === 'plan');

console.log('permission_presets render mirror: PASS');
