const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const preload = fs.readFileSync('electron/preload.js', 'utf8');
const script = fs.readFileSync('scripts/local_voice_bridge.py', 'utf8');

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
assert(main.includes("process.env.MAGIC_POINTER_SHOW_STARTUP === '1'"));
assert(!main.includes('MAGIC_POINTER_ENABLE_LAB'));
assert(!main.includes('该旧版演示工作流默认关闭'));
assert(!main.includes('startMouseShakePolling();\n  // First launch'));

console.log('dictation static test ok');
