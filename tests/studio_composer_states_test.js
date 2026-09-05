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
assert(source.includes("form?.setAttribute('aria-busy', 'true')")
  && source.includes("form?.removeAttribute('aria-busy')"),
  'the shared running-state transition must keep its accessibility state in sync');
assert(source.includes("use?.setAttribute('href', running ? '#ic-stop' : '#ic-send')"));
assert(source.includes("setComposerSettledState('success')"));
assert(source.includes("setComposerSettledState('error')"));
assert(source.includes('if (studioComposerBusy)'));
assert(source.includes('await steerActiveConversation(question, textarea)'));
assert(html.includes('class="dshw-primary" title="Send" aria-label="Send" disabled'));
assert(source.includes('function syncComposerSubmitState()'));
assert(source.includes("submit.disabled = !studioComposerBusy && !textarea.value.trim()"));
assert.match(css, /\.dshw-primary:disabled\s*\{[^}]*opacity:\s*1[^}]*background:\s*transparent/s);
assert.match(css, /#composer-permission\s*\{[^}]*order:\s*-2/s);
assert.match(css, /#composer-mention\s*\{[^}]*display:\s*none/s);
assert(source.includes('contextRow.hidden = !visible && Boolean(activeProjectRoot)'));
assert(source.includes("textarea.placeholder = visible ? 'Describe a task or ask a question' : 'Type / for commands'"));
assert(source.includes("title.textContent = 'Plan'"));
assert(source.includes("card.className = 'dshw-perm-ask-card'"));
assert(source.includes("actions.className = 'dshw-perm-ask-actions'"));
assert(source.includes('host.replaceChildren(card)'));
assert(!html.includes('id="stats-line"'), 'Claude composer has no second telemetry text row beneath its toolbar');
assert(!source.includes('function renderStatsLine('), 'usage remains in the context control, not loose bottom text');
assert(html.includes('id="composer-effort"'), 'composer exposes the direct effort trigger');
assert(html.includes('id="composer-effort-menu"'), 'composer exposes the direct five-level effort popup');
assert(html.includes('id="composer-effort-label">Extra</span>'), 'Extra is the selected effort label');
assert(!html.includes('id="composer-options"') && !html.includes('id="composer-style"'),
  'the former response-style nesting is removed');
assert(!html.includes('Response style'), 'effort is not presented as a writing style');
assert.match(html, /id="composer-effort-menu"[^>]*><\/div>[\s\S]*?id="composer-voice"[\s\S]*?id="composer-context"/,
  'voice is a separate trailing action after the direct effort popup');
assert(source.includes('const effortLevels = (globalThis as { EffortLevels?: EffortLevelsModule }).EffortLevels!'));
assert(source.includes("let composerEffort = 'xhigh'"));
assert(source.includes('function openEffortMenu()'));
assert(source.includes('positionAnchoredPopover('));
assert(source.includes('closeStudioPopovers('));
for (const selector of [
  '.dshw-perm-row',
  '.dshw-perm-row-glyph',
  '.dshw-perm-row-text',
  '.dshw-perm-check',
]) {
  assert(css.includes(selector), `missing complete popup row style: ${selector}`);
}
for (const selector of [
  '.dshw-model-row',
  '.dshw-model-name',
  '.dshw-model-tag',
  '.dshw-model-group',
  '.dshw-model-note',
]) {
  assert(css.includes(selector), `missing complete model popup style: ${selector}`);
}
assert.match(css, /\.dshw-perm-check\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s,
  'selected checks have explicit SVG dimensions');
assert.match(css, /\.dshw-perm-row-glyph\s*\{[^}]*width:\s*20px[^}]*height:\s*20px/s,
  'permission glyphs cannot fall back to intrinsic SVG dimensions');
assert.match(css, /\.dshw-model-menu\s*\{[^}]*width:\s*280px/s,
  'model names and capability tags receive the measured non-overlapping menu width');
assert.match(css, /\.dshw-model-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 16px/s,
  'model rows reserve a stable trailing slot for the selected check');
assert(html.includes('class="mp-context-track"') && html.includes('class="mp-context-value"'));
assert(source.includes('const contextWindow = Number(currentModel?.contextWindow) || 0'));
assert(source.includes("button.style.setProperty('--mp-context-progress', String(contextProgress))"));
assert(source.includes('button.hidden = false'));
assert.match(css, /\.mp-context-value\s*\{[^}]*stroke-dasharray:\s*var\(--mp-context-progress\) 100/s);
assert.match(css, /\.mp-shell\[data-inspector="open"\] \.dsh-flow,[\s\S]*?\.mp-shell\[data-inspector="open"\] \.dshw-composer-stack\s*\{[^}]*padding-inline:\s*40px/s,
  'the docked Inspector leaves the measured 40px conversation/composer gutters');

console.log('studio composer states test ok');
