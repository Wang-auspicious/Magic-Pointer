'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const probePath = 'scripts/probe_studio_claude.ts';
const preloadPath = 'scripts/probe_studio_claude_preload.js';
assert(fs.existsSync(probePath), 'Claude Studio render probe must exist');
assert(fs.existsSync(preloadPath), 'render probe must install fixture data before Studio boots');

const probe = fs.readFileSync(probePath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const searchModule = fs.readFileSync('electron/renderer/studio_search.ts', 'utf8');
const inspectorModule = fs.readFileSync('electron/renderer/studio_inspector_state.ts', 'utf8');

for (const option of ['--width', '--height', '--scale-factor', '--theme', '--state', '--output']) {
  assert(probe.includes(option), `probe CLI is missing ${option}`);
}
for (const state of [
  'landing',
  'conversation-inspector',
  'running',
  'permission',
  'error',
  'inspector-maximized',
  'thinking-expanded',
  'subagent',
  'browser',
  'customize',
  'design',
  'minimum',
]) {
  assert(probe.includes(`'${state}'`), `probe state is missing: ${state}`);
}

assert(probe.includes("appendSwitch('force-device-scale-factor'"));
assert.match(probe, /offscreen:\s*true/);
assert(probe.includes('probe_studio_claude_preload.js'));
assert(probe.includes("'build', 'electron', 'renderer', 'studio.html'"));
assert.match(probe, /requestAnimationFrame\([\s\S]*requestAnimationFrame/,
  'capture must wait two animation frames after the state settles');
assert(probe.includes("webContents.on('console-message'"));
assert(probe.includes('capturePage()'));
assert(probe.includes('toPNG()'));
assert(probe.includes('consoleErrors'));
assert(probe.includes('geometry'));
assert(probe.includes('horizontalOverflow'));
assert(probe.includes('app.exit(process.exitCode || 0)'),
  'Electron must propagate a failed state witness to the CLI exit code');
assert(!probe.includes('app.quit();'),
  'app.quit() can erase the probe failure exit code on Windows');
assert(probe.includes('width: 747, previousWidth: 747'),
  'the 1560px reference pane spans x=805…1552 after its 8px right inset');

// A screenshot file is not evidence that its requested UI state actually
// rendered.  Every state in the matrix must publish and enforce a semantic
// witness before capture (the two missing witnesses previously let the error
// and thinking screenshots pass while showing neither state).
for (const metric of [
  'planRows',
  'permissionActions',
  'turnErrors',
  'thinkingRows',
  'expandedThinkingRows',
  'subagentRows',
  'settingsRows',
  'designRows',
  'browserHost',
  'composerBusy',
  'inspectorMaximized',
]) {
  assert(probe.includes(metric), `probe metadata must report state witness: ${metric}`);
}
for (const state of [
  'landing',
  'conversation-inspector',
  'running',
  'permission',
  'error',
  'inspector-maximized',
  'thinking-expanded',
  'subagent',
  'browser',
  'customize',
  'design',
  'minimum',
]) {
  assert(probe.includes(`invalid ${state} probe`),
    `probe must reject a ${state} capture whose requested UI is absent`);
}

for (const method of ['list', 'stats', 'get', 'onProgress', 'tree', 'readFile', 'environment']) {
  assert(preload.includes(`${method}:`), `fixture bridge is missing ${method}`);
}
assert(preload.includes('本机会话'));
assert(preload.includes("contextWindow: 128_000"), 'fixture ring uses the same real model-window contract as production');
assert(preload.includes("contextWindow: 1_000_000"), 'Claude Opus reference model keeps its measured million-token window');
for (const copy of [
  'Greeting', 'VisLexicon 视元', 'Found files, ran a command', 'Searched **/*.md',
  'Listed files in working directory', 'Read 2 files', 'VisLexicon-完整方案.md',
  'rebuttal.md', '读完了。', '1m 7s', '417', 'claude-opus-5 1M',
]) {
  assert(preload.includes(copy), `reference conversation fixture is missing: ${copy}`);
}
assert(preload.includes('`D:\\\\Desktop\\\\VisLexicon 视元`'),
  'reference answer keeps the project path as an inline-code span');
assert(preload.includes('magicPointerDashboard'));
const shellCss = require('node:fs').readFileSync('electron/renderer/claude_shell.css', 'utf8');
assert.match(shellCss, /\.mp-file-preview\.is-markdown \.mp-file-preview-content\s*\{[^}]*padding:\s*14px 24px 48px/s,
  'Markdown inspector uses the measured top and horizontal insets');
assert.match(shellCss, /\.mp-file-preview\.is-markdown \.dsh-markdown h1\s*\{[^}]*font-size:\s*23px/s,
  'Markdown inspector heading uses the measured reference scale');
assert.match(shellCss, /\.mp-file-preview\.is-markdown \.dsh-markdown h2\s*\{[^}]*font-size:\s*17px/s,
  'Markdown inspector section heading uses the measured reference scale');
assert.match(shellCss, /@media \(max-width:\s*1020px\)[\s\S]*?\.dshw-foot\s*\{[^}]*margin-top:\s*auto/s,
  'the collapsed 44px rail keeps its footer at the window bottom');
assert.match(shellCss, /@media \(max-width:\s*1020px\)[\s\S]*?\.mp-account-footer > span[^}]*display:\s*none\s*!important/s,
  'responsive footer overrides the baseline account-row flex rule');
assert.match(shellCss, /@media \(max-width:\s*1020px\)[\s\S]*?\.mp-account-footer > \.mp-account-mark[^}]*display:\s*block\s*!important/s,
  'the collapsed rail retains the local account mark');

for (const [name, source, globalName] of [
  ['search', searchModule, 'StudioSearch'],
  ['inspector state', inspectorModule, 'StudioInspectorState'],
]) {
  assert(!/^export\s/m.test(source), `${name} is loaded as a classic script and cannot contain ESM exports`);
  assert(source.includes('(() => {') && source.trimEnd().endsWith('})();'),
    `${name} must isolate its lexical declarations from later classic scripts`);
  assert(source.includes('module.exports'), `${name} must remain directly testable in Node`);
  assert(source.includes(`.${globalName}`), `${name} must expose ${globalName} before studio.ts boots`);
}

console.log('studio render probe contract ok');
