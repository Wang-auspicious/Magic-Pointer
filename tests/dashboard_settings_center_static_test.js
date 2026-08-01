const assert = require('assert');
const fs = require('fs');
const { defaultSettings, validate } = require('../electron/settings_store');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const css = fs.readFileSync('electron/renderer/dashboard.css', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');

const settingsViews = [
  'general',
  'activation',
  'voice',
  'shortcuts',
  'models',
  'agents',
  'capabilities',
  'apps',
  'permissions',
  'connections',
  'storage',
  'activity',
  'privacy',
  'appearance',
  'accessibility',
  'diagnostics',
];

for (const view of settingsViews) {
  assert(html.includes(`data-view-target="${view}"`), `missing direct settings destination: ${view}`);
  assert(html.includes(`data-fabric-view="${view}"`), `missing settings surface: ${view}`);
}

for (const groupLabel of ['核心输入', '智能路由', '应用上下文', '数据', '系统']) {
  assert(html.includes(groupLabel), `missing sidebar group: ${groupLabel}`);
}

assert(!html.includes('data-view-target="overview"'), 'settings center must not have an overview destination');
assert(!html.includes('data-fabric-view="overview"'), 'settings center must not have an overview page');
assert.strictEqual((html.match(/class="nav-item/g) || []).length, settingsViews.length);
assert(!html.includes('🏠') && !html.includes('⚙') && !html.includes('✨'), 'navigation must not use emoji icons');
assert(html.includes('class="nav-section-label"'));
assert(html.includes('class="settings-list"'));

for (const id of [
  'wake-mode',
  'voice-start-strategy',
  'keep-current-app-focus',
  'dashboard-focus-after-action',
  'shortcut-wake',
  'shortcut-text-mode',
  'shortcut-voice-mode',
  'shortcut-pause',
  'mouse-side-button',
  'appearance-material',
  'reduce-motion',
  'reduce-transparency',
  'high-contrast-controls',
  'agent-session-binding',
  'agent-delivery-mode',
  'agent-cwd-match',
  'agent-auto-attach',
]) assert(html.includes(`id="${id}"`), `missing useful setting control: ${id}`);

assert(!html.includes('id="agent-delivery-mode" disabled'));
assert(js.includes("fabricRequest('agent.sessions'"));
assert(js.includes('renderAgentSessions'));

assert(js.includes("let activeView = 'activation'"), 'activation must be the useful default page');
assert(js.includes("general: ['通用'"));
assert(js.includes("shortcuts: ['键盘快捷键'"));
assert(js.includes("accessibility: ['辅助功能'"));
assert(css.includes('.nav-section-label'));
assert(css.includes('@media (prefers-contrast: more)'));
assert(css.includes('font-weight: 600') || css.includes('font-weight: 590'), 'setting typography must avoid oversized heavy headings');

const defaults = defaultSettings();
assert.strictEqual(defaults.activation.wake_mode, 'wiggle_hotkey');
assert.strictEqual(defaults.activation.keep_current_app_focus, true);
assert.strictEqual(defaults.activation.dashboard_focus_after_action, false);
assert.strictEqual(defaults.activation.mouse_side_button, 'none');
assert.strictEqual(defaults.activation.gesture_arm_delay_ms, 180);
assert.strictEqual(defaults.activation.gesture_timeout_ms, 5000);
assert.strictEqual(defaults.activation.multi_stroke_submit_ms, 10000);
assert(html.includes('id="multi-stroke-submit"'));
assert.strictEqual(defaults.interaction.voice_start_strategy, 'auto');
assert.deepStrictEqual(defaults.shortcuts, {
  wake: 'Control+Alt+M',
  text_mode: 'Control+Alt+T',
  voice_mode: 'Control+Alt+V',
  pause: 'Control+Alt+P',
});
assert.deepStrictEqual(defaults.appearance, {
  theme: 'system',
  material: 'auto',
  selection_visual: 'sweep_band',
  sweep_height_ratio: 0.52,
  sweep_min_height_dip: 10,
  sweep_max_height_dip: 24,
  sweep_duration_ms: 292,
  sweep_fade_ms: 96,
  capsule_spawn_ms: 80,
  capsule_expand_ms: 125,
  capsule_voice_width_dip: 40,
  capsule_text_width_dip: 144,
  capsule_max_width_dip: 440,
  capsule_inline_gap_dip: 18,
  gesture_line_style: 'demo6_band',
  gesture_line_width_dip: 40,
});
assert.deepStrictEqual(defaults.accessibility, {
  reduce_motion: false,
  reduce_transparency: false,
  high_contrast_controls: false,
});

const badWakeMode = defaultSettings();
badWakeMode.activation.wake_mode = 'telepathy';
assert.throws(() => validate(badWakeMode), /wake_mode/);

const badVoiceStart = defaultSettings();
badVoiceStart.interaction.voice_start_strategy = 'always_record';
assert.throws(() => validate(badVoiceStart), /voice_start_strategy/);

const badShortcut = defaultSettings();
badShortcut.shortcuts.wake = '';
assert.throws(() => validate(badShortcut), /shortcut/);

console.log('dashboard settings center static test ok');
