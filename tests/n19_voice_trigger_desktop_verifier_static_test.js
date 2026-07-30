'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const verifierPath = path.join(root, 'scripts', 'verify_n19_voice_triggers_desktop.py');
assert(fs.existsSync(verifierPath), 'N19 needs a real desktop verifier, not policy-only tests');

const verifier = fs.readFileSync(verifierPath, 'utf8');
for (const token of [
  'push_to_talk',
  'hover',
  'MAGIC_POINTER_VOICE_INPUT_WAV',
  'stage:pointer-input',
  'voice.start',
  'voice.final',
  'foregroundInvariant',
  'pointerPollingEnabled',
  'wiggleStayedDisabled',
]) {
  assert(verifier.includes(token), `N19 desktop verifier missing ${token}`);
}
assert(verifier.includes('SetCursorPos'), 'verifier must move the physical Windows pointer');
assert(verifier.includes('mouse_event'), 'push-to-talk must use a physical button transition');
assert(verifier.includes('Magic Pointer Stage'), 'hover must read the real Stage geometry');
assert(!verifier.includes('ipcRenderer'), 'acceptance must not inject renderer IPC');
assert(!verifier.includes('webContents.send'), 'acceptance must not forge main-process events');

console.log('N19 voice trigger desktop verifier static test ok');
