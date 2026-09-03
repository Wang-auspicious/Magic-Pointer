const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('electron/renderer/panel.ts', 'utf8');
const html = fs.readFileSync('electron/renderer/panel.html', 'utf8');
const css = fs.readFileSync('electron/renderer/panel.css', 'utf8');

assert(source.includes('function syncCapsuleSize'));
assert(source.includes('function scheduleVoiceAutoSubmit'));
assert(source.includes("payload.defaultInputMode === 'text' ? 'text' : 'voice'"));
assert(source.includes("api.startDictation()"));
assert(source.includes("commandInput.addEventListener('input'"));
assert(source.includes("event.key === 'Enter'"));
assert(source.includes('captureEligibility.commandReady !== false'));
assert(!source.includes('payload.sessionExpiresAt'),
  '定格住的一刻不会过期，面板不该在用户还在想问什么的时候自己消失');
assert(source.includes('replaceChildren'));
assert(!source.includes('renderSuggestionChips'));
assert(!source.includes('suggestedCommands.slice'));
assert(!source.includes('innerHTML'));

assert(html.includes('id="inline-action-rail"'));
assert(html.includes('id="voice-glyph"'));
assert(html.includes('id="command"'));
assert(html.includes('id="result"'));
assert(!html.includes('id="suggestion-row"'));
assert(!html.includes('id="dictation"'));
assert(!html.includes('id="panel-close"'));
assert(!html.includes('id="run"'));

assert(css.includes('--google-blue: #0b57d0'));
assert(css.includes('.command-capsule'));
assert(css.includes('[data-input-mode="voice"]'));
assert(css.includes('[data-state="running"]'));
assert(css.includes('transition: width'));
assert(css.includes('@media (prefers-reduced-motion: reduce)'));

console.log('panel static test ok');
