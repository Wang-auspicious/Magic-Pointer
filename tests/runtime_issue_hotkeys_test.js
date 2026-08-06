const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const overlay = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const html = fs.readFileSync('electron/renderer/index.html', 'utf8');

assert(main.includes('function registerConfigurableHotkeys('));
assert(main.includes('fabricSettings.shortcuts?.wake'));
assert(main.includes("requestActivation('shortcut-wake')"));
assert(main.includes("requestActivation('shortcut-text')"));
assert(main.includes("requestActivation('shortcut-voice')"));
assert(main.includes("globalShortcut.register('Control+Alt+Enter'"));
assert(main.includes("globalShortcut.register('Control+Alt+Shift+M'"));
assert(main.includes("requestActivation('runtime-delivery')"));
assert(main.includes("requestActivation('legacy-native-selection')"));
assert(main.includes('const previousSettings = fabricSettings;'));
assert(main.includes('const failedHotkeys = Object.entries(parsed.hotkeys)'));
assert(main.includes('fabricSettingsStore.save(previousSettings)'));
assert(main.includes('parsed.ok = false'));
assert(main.includes('快捷键注册失败'));

assert(!main.includes('function showRuntimeIssueOverlay('),
  'the uncallable legacy runtime-issue overlay must not remain as a fake feature');

assert(overlay.includes("let currentWorkflow = 'generic';"));
assert(overlay.includes('workflow: currentWorkflow'));
assert(overlay.includes("currentWorkflow = String(payload?.workflow || 'generic')"));

// Runtime-issue capture results route to the PointerStage, never back into
// the overlay (legacy in-overlay receipt retired with Task 5).
assert(main.includes("reason: 'runtime-issue'"));
assert(main.includes('stageEventFromBridge(parsed)'));
assert(!overlay.includes('runtime_issue_recorded'));
assert(!overlay.includes('autoDismissMs'));
assert(!html.includes('描述问题或期望，不需要找源码'));
// P0#5: recovery from a runtime-issue capture is event-driven off overlay:done,
// not off bridge completion. The overlay must hide at handoff so it can never
// sit black and input-blocking for the whole bridge run (up to the 120s timeout).
const overlayDoneBlock = main.slice(
  main.indexOf("ipcMain.on('overlay:done'"),
  main.indexOf("ipcMain.on('stage:submit-selection-command'"),
);
const nonGestureHandoff = overlayDoneBlock.slice(overlayDoneBlock.indexOf("workflow === 'selection_gesture'"));
assert(nonGestureHandoff.indexOf('hideOverlay()') < nonGestureHandoff.indexOf('runPythonBridge('),
  'overlay must hide when the capture is handed to the bridge');
assert.doesNotMatch(overlayDoneBlock, /onComplete:\s*\(parsed\)\s*=>\s*\{\s*hideOverlay\(\)/,
  'overlay hide must not wait for bridge completion');
// P0#6: the non-gesture handoff must bound points before forwarding to the
// capture bridge; a compromised renderer must not push an unbounded array.
assert(main.includes('const MAX_OVERLAY_CAPTURE_POINTS = 4096;'), 'capture points must have a hard cap');
assert(nonGestureHandoff.includes('rawPoints.slice(0, MAX_OVERLAY_CAPTURE_POINTS)'),
  'handoff must truncate points before forwarding');


console.log('runtime issue hotkeys test ok');
