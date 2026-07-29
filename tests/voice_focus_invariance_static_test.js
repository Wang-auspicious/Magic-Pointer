'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = readCode('electron/main.js');
const preload = readCode('electron/preload.js');
const stage = readCode('electron/renderer/stage.js');
const pointerState = readCode('scripts/pointer_input_state.ps1');

function readCode(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  // Static contracts must be satisfied by executable code, never comments.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\r\n]*/gm, '$1')
    .replace(/(^|\s)#(?!\{)[^\r\n]*/gm, '$1');
}

function requireCode(source, pattern, contract) {
  assert.match(source, pattern, contract);
}

(function pointerStateCarriesForegroundIdentityInEveryJsonShape() {
  requireCode(pointerState, /foregroundHwnd\s*=\s*(?:\[int64\])?\s*\$hwnd(?:\.ToInt64\(\))?\b/i,
    'PowerShell success JSON must expose foregroundHwnd from GetForegroundWindow');
  requireCode(pointerState, /foregroundProcessId\s*=\s*(?:\[u?int32\]|\[int64\])?\s*\$pidValue\b/i,
    'PowerShell success JSON must expose foregroundProcessId from GetWindowThreadProcessId');
  requireCode(pointerState, /\{(?=[^\r\n}]*"foregroundHwnd":0)(?=[^\r\n}]*"foregroundProcessId":0)[^\r\n}]*\}/,
    'PowerShell fallback JSON must default both foreground identity fields to zero');
}());

(function mainParsesForegroundIdentityWithSafeDefaults() {
  requireCode(main, /pointerInputState\s*=\s*\{[^}]*foregroundHwnd\s*:\s*0[^}]*foregroundProcessId\s*:\s*0/s,
    'main must default foregroundHwnd and foregroundProcessId to zero');
  requireCode(main, /foregroundHwnd\s*:\s*Number\(parsed\.foregroundHwnd\s*\|\|\s*0\)/,
    'main must parse foregroundHwnd from pointer-state JSON');
  requireCode(main, /foregroundProcessId\s*:\s*Number\(parsed\.foregroundProcessId\s*\|\|\s*0\)/,
    'main must parse foregroundProcessId from pointer-state JSON');
}());

(function mainOwnsTheFocusGuardAndExplicitFocusPolicy() {
  requireCode(main, /require\('\.\/voice_focus_guard'\)/,
    'main must import VoiceFocusGuard instead of duplicating its invariant');
  requireCode(main, /VoiceFocusGuard/,
    'main must construct or otherwise reference VoiceFocusGuard');
  requireCode(
    main,
    /function\s+setStageMouseCapture\s*\(\s*enabled\s*,\s*requestFocus(?:\s*=\s*false)?\s*,\s*rawRegions(?:\s*=\s*undefined)?\s*\)/,
    'setStageMouseCapture must accept explicit focus and native hit-region arguments',
  );
  requireCode(main, /if\s*\(\s*requestFocus\s*\)\s*stageWindow\.focus\(\);[\s\S]*?if\s*\(\s*enabled\s*&&\s*regions\.length\s*\)\s*\{[\s\S]*?stageWindow\.setIgnoreMouseEvents\(false\);/,
    'stageWindow.focus must follow the explicit request without requiring full shaped-window mouse capture');
  requireCode(
    main,
    /setStageMouseCapture\(\s*payload\?\.enabled\s*===\s*true\s*,\s*payload\?\.requestFocus\s*===\s*true\s*,\s*Array\.isArray\(payload\?\.regions\)\s*\?\s*payload\.regions\s*:\s*\[\]\s*,?\s*\)/,
    'stage mouse-capture IPC must forward focus and renderer hit regions explicitly',
  );
}());

(function preloadPreservesTheExplicitFocusRequest() {
  requireCode(
    preload,
    /setMouseCapture\s*:\s*\(\s*enabled\s*,\s*options\s*=\s*\{\}\s*\)\s*=>\s*ipcRenderer\.send\(\s*'stage:set-mouse-capture'\s*,\s*\{[\s\S]*?enabled\s*:\s*enabled\s*===\s*true\s*,[\s\S]*?requestFocus\s*:\s*options\?\.requestFocus\s*===\s*true\s*,[\s\S]*?regions\s*:\s*Array\.isArray\(options\?\.regions\)[\s\S]*?\}\s*\)/,
    'preload must accept focus options and bound the explicit native hit-region list',
  );
}());

(function stageRequestsKeyboardFocusOnlyForTextEntry() {
  requireCode(stage, /const\s+requestFocus\s*=\s*name\s*===\s*'capsule-text'/,
    'stage must derive requestFocus solely from the capsule-text state');
  requireCode(stage, /api\.setMouseCapture\(wantCapture\s*,\s*\{\s*requestFocus\s*,\s*regions\s*\}\)/,
    'stage must forward the derived focus request and visible regions with mouse capture');
  requireCode(stage, /hitPolicy\.shouldCaptureMouse\(\{[\s\S]*?hasInteractiveSurface,[\s\S]*?pointer:\s*lastPointerPoint,[\s\S]*?interactiveRegions,/,
    'result and error may capture the mouse only while the pointer is over an enabled control');
}());

(function mainRecordsEveryRequiredFocusPhaseAndHasDesktopEvidenceHook() {
  requireCode(main, /pointerInputState\.foregroundHwnd/,
    'focus phase observations must use the foreground HWND parsed from the native pointer-state stream');
  for (const phase of ['wake', 'loading', 'ready', 'partial', 'final', 'error', 'result']) {
    requireCode(main, new RegExp(`(?:voiceFocusGuard(?:\\?\\.|\\.)observe|observeVoiceFocusPhase)\\(\\s*'${phase}'`),
      `main must record the ${phase} foreground-HWND phase through VoiceFocusGuard`);
  }
  requireCode(main, /MAGIC_POINTER_N17_FOCUS_EVIDENCE_PATH/,
    'main must expose the N17 desktop-evidence environment hook');
  requireCode(main, /(?:const|let)\s+focusEvidencePath\s*=\s*String\(process\.env\.MAGIC_POINTER_N17_FOCUS_EVIDENCE_PATH/,
    'the N17 evidence hook must resolve the requested evidence path');
  requireCode(main, /fs\.writeFileSync\(focusEvidencePath\s*,/,
    'the N17 evidence hook must write a real desktop evidence artifact');
}());

console.log('voice_focus_invariance_static_test: PASS');
