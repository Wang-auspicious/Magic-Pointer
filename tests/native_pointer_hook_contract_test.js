'use strict';

const assert = require('assert');
const fs = require('fs');

const helper = fs.readFileSync('scripts/pointer_input_state.ps1', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

assert(helper.includes('param([switch]$SelfTest)'), 'the native hook must have a bounded compile/self-test mode');
assert(helper.includes('CaptureNextStroke'), 'the native helper must expose a bounded one-shot stroke gate');
assert(helper.includes('SetEpisodeChord'), 'the helper must support a side-button continuation chord');
assert.match(helper, /WM_LBUTTONDOWN[\s\S]*?return \(IntPtr\)1/,
  'an explicitly armed left-button stroke must be swallowed before the target application');
assert.match(helper, /WM_LBUTTONUP[\s\S]*?return \(IntPtr\)1/,
  'the matching release must also be swallowed');
assert(helper.includes('CallNextHookEx'), 'navigation-state events must continue through the hook chain');
// A swallowed press is invisible to GetAsyncKeyState, so the hook must report
// it or the poller can never see the stroke it is capturing.
assert(helper.includes('public static bool IsSwallowingLeft()'),
  'the hook must expose the left button it swallowed');
assert.match(helper, /IsSwallowingLeft\(\)\)\s*\{\s*\$buttons\s*=\s*\$buttons\s*-bor\s*1\s*\}/,
  'a swallowed left button must still be reported in the polled button mask');
assert(helper.includes('Console.In.ReadLine'), 'Electron must be able to change hook state without restarting the helper');
assert(main.includes("stdio: ['pipe', 'pipe', 'pipe']"), 'the pointer helper stdin must remain connected');
assert(main.includes('sendPointerInputCommand'), 'main must own hook-state transitions');
assert(main.includes("sendPointerInputCommand('idle')"), 'shutdown/cancel must fail open');

console.log('native_pointer_hook_contract_test: all assertions passed');
