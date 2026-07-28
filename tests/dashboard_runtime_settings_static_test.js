const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');

assert(main.includes('function registerConfigurableHotkeys('), 'missing runtime hotkey registrar');
assert(main.includes('fabricSettings.shortcuts?.wake'), 'wake shortcut must come from persisted settings');
assert(main.includes('fabricSettings.shortcuts?.text_mode'), 'text shortcut must come from persisted settings');
assert(main.includes('fabricSettings.shortcuts?.voice_mode'), 'voice shortcut must come from persisted settings');
assert(main.includes('fabricSettings.shortcuts?.pause'), 'pause shortcut must come from persisted settings');
assert(main.includes("requestActivation('shortcut-text')"));
assert(main.includes("requestActivation('shortcut-voice')"));
assert(main.includes("current.reason === 'shortcut-text'"), 'text shortcut must override input mode for one session');
assert(main.includes("current.reason === 'shortcut-voice'"), 'voice shortcut must override input mode for one session');
assert(main.includes('globalShortcut.unregister(accelerator)'), 'saving shortcuts must replace old registrations');
assert(main.includes('registerConfigurableHotkeys()'), 'runtime must register configurable shortcuts');
assert(main.includes('applyConfiguredWakeState()'), 'wake mode save must update pointer polling');
assert(main.includes('function applyDashboardMaterial('), 'material setting needs a native runtime');
assert(main.includes('dashboardWindow.setBackgroundMaterial('), 'material setting must update the desktop window');
assert(main.includes('fabricSettings?.general?.keep_running !== false'), 'close behavior must use persisted setting');
assert(main.includes('event.preventDefault()'), 'keep-running mode must hide instead of destroying the app');
assert(!main.includes("globalShortcut.register('Control+Alt+M'"), 'wake shortcut must not remain hard-coded');

assert(js.includes('settingsBeforeSave'), 'UI must retain rollback snapshot');
assert(js.includes('保存失败，已恢复上次设置'));
assert(js.includes('payload.hotkeys'), 'UI must surface shortcut registration failures');

console.log('dashboard runtime settings static test ok');
