const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const script = fs.readFileSync('scripts/local_voice_bridge.py', 'utf8');
const overlay = fs.readFileSync('electron/renderer/overlay.js', 'utf8');
const overlayHtml = fs.readFileSync('electron/renderer/index.html', 'utf8');

assert(preload.includes("startDictation: () => ipcRenderer.send('dictation:start', { surface: 'overlay' })"));
assert(preload.includes("startDictation: () => ipcRenderer.send('dictation:start', { surface: 'panel' })"));
assert(preload.includes("ipcRenderer.on('dictation:result'"));
assert(main.includes("ipcMain.on('dictation:start', (event, payload) =>"));
assert(main.includes('isSurfaceSender(event, surface, resultTargetWindow)'));
assert(main.includes('const dictationChildren = new Map();'));
assert(main.includes('if (dictationChildren.has(surface))'));
assert(main.includes('safeSurfaceSend(surface, \'dictation:result\''));
assert(main.includes("'scripts', 'local_voice_bridge.py'"));
assert(main.includes("'--silence-ms'"));
assert(main.includes('MAGIC_POINTER_VOICE_INPUT_WAV'));
assert(main.includes('windowsHide: true'));
assert(main.includes("eventPayload.type === 'partial'"));
assert(main.includes("eventPayload.type === 'final'"));
assert(script.includes('class VoiceActivity'));
assert(script.includes('sounddevice'));
assert(script.includes('whisper'));
assert(script.includes('cached_model_path'));

assert(main.includes('const wiggleEnv = process.env.MAGIC_POINTER_ENABLE_MOUSE_SHAKE'));
assert(main.includes('applyConfiguredWakeState'));
assert(main.includes('fabricSettings?.activation?.wiggle_enabled'));
assert(!main.includes('MAGIC_POINTER_SHOW_STARTUP'),
  'startup must never reveal the full-screen overlay or its hint capsule');
assert(!main.includes("showOverlay('startup'"),
  'startup must not schedule a transient observer surface');
assert(!overlay.includes("payload?.reason === 'startup'"),
  'the renderer must not retain a startup-only capsule state');
assert.match(overlayHtml, /id="hint"\s+class="hint dim"[^>]*><\/div>/,
  'the reusable hint must start empty and invisible before the first renderer event');
assert(!main.includes('MAGIC_POINTER_ENABLE_LAB'));
assert(!main.includes('该旧版演示工作流默认关闭'));
assert(!main.includes('startMouseShakePolling();\n  // First launch'));

console.log('dictation static test ok');
