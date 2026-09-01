'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');

assert.strictEqual((html.match(/id="composer-form"/g) || []).length, 1, 'landing and transcript share one composer');
assert(html.indexOf('id="composer-permission-ask"') < html.indexOf('class="dshw-composer-seat"'),
  'pending input attaches immediately above the composer');
assert.match(css, /\.dshw-primary:hover:not\(:disabled\)/);
assert.match(css, /\.dshw-primary:active:not\(:disabled\)/);
assert.match(css, /\.dshw-primary:disabled/);
assert.match(css, /\.dshw-input-root:focus-within \.dshw-scroll/);
assert.match(css, /\.dshw-input-form\[data-state="running"\] \.dshw-scroll/);
assert.match(css, /\.dshw-input-form\[data-state="error"\] \.dshw-scroll/);
assert.match(css, /\.dshw-input-form\[data-state="success"\] \.dshw-scroll/);
assert(source.includes("form?.setAttribute('data-state', running ? 'running' : 'idle')"));
assert(source.includes("use?.setAttribute('href', running ? '#ic-stop' : '#ic-send')"));
assert(source.includes("setComposerSettledState('success')"));
assert(source.includes("setComposerSettledState('error')"));
assert(source.includes('if (studioComposerBusy)'));
assert(source.includes('await steerActiveConversation(question, textarea)'));

console.log('studio composer states test ok');
