'use strict';

// 渲染层权限预设镜像：表结构与 Python 真值（app/agent_runtime/permission_presets.py）
// 保持同档同名，custom 只作展示。执行 fail-closed 在桥那端，这里钉的是 UI 数据面。

const assert = require('assert');
const { PRESETS, PRIMARY_PRESETS, optionOf, presetSvg } = require('../electron/renderer/permission_presets');

const VALUES = PRESETS.map(option => option.value);
assert.deepStrictEqual(VALUES, ['plan', 'workspace-write', 'danger-full-access', 'read-only'],
  `预设表顺序/取值：${VALUES}`);
assert.deepStrictEqual(PRIMARY_PRESETS.map(option => option.value), [
  'plan', 'workspace-write', 'danger-full-access',
]);
assert.strictEqual(optionOf('workspace-write').label, 'Accept edits');
assert.strictEqual(optionOf('danger-full-access').label, 'Bypass permissions');
assert.strictEqual(optionOf('read-only').primary, false);

for (const option of PRESETS) {
  assert.ok(option.name && option.description, `${option.value} 需要名称与描述`);
  const svg = presetSvg(option);
  assert.ok(svg.startsWith('<svg'), `${option.value} 的 SVG 可渲染`);
  assert.ok(svg.includes('viewBox="0 0 24 24"') && svg.includes('stroke-width="1.5"'),
    `${option.value} 必须使用 Studio 统一的 24px / 1.5px 线性图标`);
}

// Full access 带确认门文案；其余档位没有。
const full = optionOf('danger-full-access');
assert.ok(full && full.confirm && full.confirm.title.includes('Full access'));
assert.ok(PRESETS.filter(o => o.value !== 'danger-full-access').every(o => !o.confirm));

// custom 是派生展示态：能查到，但不在切换列表里。
const custom = optionOf('custom');
assert.ok(custom && custom.value === 'custom');
assert.ok(!VALUES.includes('custom'));

// 未知值查不到（渲染层绝不编造档位）。
assert.strictEqual(optionOf('bypass'), undefined);
// plan 是真实档位（不在 Python 真值表之外的展示态）。
assert.ok(optionOf('plan') && optionOf('plan').value === 'plan');

console.log('permission_presets render mirror: PASS');
