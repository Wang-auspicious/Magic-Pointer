'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('electron/main.ts');
const preload = read('electron/preload.ts');
const stage = read('electron/renderer/stage.ts');
const stageHtml = read('electron/renderer/stage.html');

assert(stageHtml.includes('<script src="../voice_trigger_policy.js"></script>'));
assert(stage.includes('globalThis.MagicPointerVoiceTrigger'));
assert(stage.includes("strategy: session.voiceStartStrategy"));
assert(stage.includes("const wantDictation = name === 'capsule-voice' && session.groundingReady === true"),
  'voice must not auto-start before the gesture snapshot is attached');
assert(stage.includes('const groundingChanged = previousGroundingReady !== session.groundingReady'),
  'grounding completion must resync voice effects even when stage state does not change');
assert(stage.includes("session.voiceStartStrategy === 'push_to_talk'"));
assert(stage.includes("session.voiceStartStrategy === 'hover'"));
assert(stage.includes("api.stopDictation({ graceful: wantsSubmit && !pendingTranscript })"));
assert(stage.includes('api.onPointerInput((payload) => handleVoicePointerInput(payload))'));

assert(main.includes("stageWindow.webContents.send('stage:pointer-input'"));
assert(main.includes('voiceStartStrategy: fabricSettings.interaction.voice_start_strategy'));
assert(main.includes("require('./pointer_polling_policy')"),
  'voice mouse strategies must share an explicit polling policy with wake detection');
assert(/voicePointerConfigured:\s*\['push_to_talk',\s*'hover'\]\.includes\(/.test(main),
  'configuring either mouse voice strategy must keep the native pointer stream resident');
assert(/if\s*\(!pointerPolicy\.detectWiggle\)\s*return;[\s\S]*?wiggleDetector\.push/.test(main),
  'voice-only pointer polling must not silently re-enable wiggle activation');
assert(/pointerPolicy\.detectMouseButton[\s\S]*?mouseActivationDetector\.push/.test(main),
  'mouse-button wake detection must remain independently gated');
assert(main.includes("voiceArgs.push('--stop-file', stopFile)"));
assert(main.includes("fs.writeFileSync(stopFile, 'stop\\n', { encoding: 'utf8', flag: 'wx' })"));
assert(main.includes("stopDictation(surface, { graceful: payload?.graceful === true })"));
assert(main.includes("if (!selectionSession)"),
  'only a missing session may be reported as expired');
assert(main.includes("if (!selectionSession.snapshot)"),
  'a live session whose snapshot is pending must be handled separately');
assert(preload.includes("graceful: options?.graceful === true"));
assert(preload.includes("onPayload('stage:pointer-input'"));

console.log('voice trigger integration static test ok');
