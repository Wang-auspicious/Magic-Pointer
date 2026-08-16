'use strict';

// 渲染层权限预设镜像：表结构与 Python 真值（app/agent_runtime/permission_presets.py）
// 保持同档同名，custom 只作展示。执行 fail-closed 在桥那端，这里钉的是 UI 数据面。

const assert = require('assert');
const { PRESETS, optionOf, presetSvg } = require('../electron/renderer/permission_presets');

const VALUES = PRESETS.map(option => option.value);
assert.deepStrictEqual(VALUES, ['read-only', 'workspace-write', 'danger-full-access'],
  `预设表顺序/取值：${VALUES}`);

for (const option of PRESETS) {
  assert.ok(option.name && option.description, `${option.value} 需要名称与描述`);
  assert.ok(option.glyph, `${option.value} 需要盾形路径`);
  assert.ok(presetSvg(option).startsWith('<svg'), `${option.value} 的 SVG 可渲染`);
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
assert.strictEqual(optionOf('plan'), undefined);

console.log('permission_presets render mirror: PASS');
