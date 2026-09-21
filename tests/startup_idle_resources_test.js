'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const ready = ast.statements.find(n => ts.isIfStatement(n) && n.expression.getText(ast) === 'gotLock');
// Execute the real readiness callback with OS surfaces stubbed. Drain startup timers.
const calls = [];
const timers = [];
const noop = new Proxy(function () {}, { get: (_target, key) => key === Symbol.toPrimitive ? () => '' : noop, apply: () => noop });
const context = new Proxy({
  String, Number, Boolean, Math, Date, Error, Array, Object,
  gotLock: true, process: { pid: 1, platform: 'win32', env: {}, argv: [] },
  app: { whenReady: () => ({ then: fn => fn() }), getLoginItemSettings: () => ({}), setAppUserModelId() {}, setLoginItemSettings() {}, isPackaged: false },
  fs: noop, path: { join: () => 'fixture' },
  ElectronSettingsStore: class { load() { return { activation: {}, general: {} }; } },
  CredentialStore: class {}, VoiceResidentRuntime: class {}, WiggleDetector: class {},
  configureVoiceRuntime: () => ({ ok: true }), inspectOnboardingReadiness: () => ({ ready: true }),
  setTimeout: fn => { timers.push(fn); },
  warmUpOcrWorker: () => calls.push('ocr'),
  startModelHealthWatch: () => calls.push('health-poll'),
  ensureResidentUiaHost: () => calls.push('uia-eager'),
  shouldStartHidden: () => true,
}, { has: () => true, get: (target, key) => key in target ? target[key] : noop });
vm.runInNewContext(ts.transpileModule(ready.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
timers.forEach(fn => fn());
assert(!calls.includes('ocr'), 'idle app launch must not initialize OCR or run warm inference');
assert(!calls.includes('health-poll'), 'idle launch must not repeatedly spawn Fabric just to poll a health file');
console.log('Idle startup does not launch OCR or poll Python health');
