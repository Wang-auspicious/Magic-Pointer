'use strict';

const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');

assert(main.includes("const { VoiceResidentRuntime } = require('./voice_resident_runtime');"));
assert(main.includes("new VoiceResidentRuntime({"));
assert(main.includes("startLegacy: startLegacyDictation"));
assert(main.includes("stopLegacy: stopLegacyDictation"));
assert(/voiceRuntime\?\.start\(\{[\s\S]*?requestId,[\s\S]*?surface,[\s\S]*?contextPath,[\s\S]*?silenceMs,[\s\S]*?inputWav,/.test(main));
assert(main.includes("const requestId = crypto.randomUUID()"));
assert(!/payload\?\.contextPath|payload\?\.requestId|payload\?\.inputWav/.test(main));
assert(main.includes("!app.isPackaged && process.env.MAGIC_POINTER_VOICE_INPUT_WAV"),
  'desktop WAV evidence may come only from the main-process development environment, never renderer IPC or packaged mode');
assert(main.includes("pythonInvocationArgs([scriptPath], { isolated: PYTHON_ISOLATED })"));
assert(main.includes("pythonSpawnEnvironment({ env:"));
assert(main.includes('const PYTHON_ISOLATED = PYTHON_RUNTIME.required === true;'));
assert(main.includes('function localWhisperModelName()'),
  'main must validate the environment-selected local model name before argv and audit use');
assert(!main.includes("spawn(py, [scriptPath]"), 'main bridge must not bypass bundled Python isolation');
assert(main.includes("configureVoiceRuntime(parsed.settings"), 'saved resident settings must reconfigure the real worker');
assert(main.includes("voice_session_active"), 'active settings changes must fail closed');
assert(/result\.ok\s*&&\s*preload\s*&&\s*result\.changed/.test(main),
  'saving unrelated settings must not touch the resident model idle deadline');
assert(/configureVoiceRuntime\(fabricSettings,\s*\{\s*preload:\s*false\s*\}\)/.test(main),
  'startup must configure voice without loading Torch before transparent renderers are ready');
assert(/function\s+scheduleStartupVoiceWarmup[\s\S]*?stageReadiness\.whenReady\([\s\S]*?overlayReadiness\.whenReady\([\s\S]*?voiceRuntime\?\.warmUp\(\)/.test(main),
  'startup voice warmup must begin only after both interactive surfaces are listening');
assert(/if\s*\(!captureMode\)\s*scheduleStartupVoiceWarmup\(/.test(main),
  'visual/evidence capture processes must not contend with an unrelated model preload');
assert(/failedHotkeys\.length[\s\S]*?configureVoiceRuntime\(previousSettings/.test(main),
  'a later hotkey rollback must also restore the previous voice runtime configuration');
assert(/function\s+stopLegacyDictation[\s\S]*?dictationStopFiles/.test(main),
  'disabled resident mode must retain a real graceful/cancel stop controller');
assert(/runtimeSession\.cancelled[\s\S]*?eventPayload\.type === 'partial' \|\| eventPayload\.type === 'final'/.test(main),
  'legacy cancellation must suppress partial/final events until the child exits');
assert(main.includes('latestVoiceRuntimeStatus ='),
  'main must retain the last truthful worker state even before Dashboard exists');
assert(/dashboardWindow\.webContents\.send\('dashboard:voice-residency-status',\s*latestVoiceRuntimeStatus\)/.test(main),
  'opening Dashboard must replay the current resident worker state');

console.log('voice_resident_main_static_test: all assertions passed');
