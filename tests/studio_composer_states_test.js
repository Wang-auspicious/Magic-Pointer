'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/claude_chat.css', 'utf8');
const plan = fs.readFileSync('electron/renderer/plan_list.ts', 'utf8');
const decisionCard = fs.readFileSync('electron/renderer/decision_card.ts', 'utf8');

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
/* 发送键空闲时是 Claude 的 send 字形（字体图标），运行时换成自绘的方块停止键：
   字体里没有停止的码位，所以只有这一态走 svg。两态外形差别够大，值得留这个例外。 */
assert(source.includes("submit.querySelector('use[href=\"#ic-stop\"]')"),
  'the send button swaps glyph markup per state instead of only retargeting a <use>');
assert(source.includes("api.CdsIcons.html('code-send')"),
  'the idle state restores the original Code ArrowReturn font glyph');
assert(source.includes("document.getElementById('composer-context')?.setAttribute('data-state', running ? 'running' : 'idle')"),
  'the usage ring must switch to its running state with the turn');
assert(source.includes("setComposerSettledState(awaiting.awaitingUserInput ? 'idle' : 'success')"),
  'a suspended question or approval must not be announced as a completed task');
assert(source.includes("setComposerSettledState('error')"));
assert(source.includes('if (studioComposerBusy)'));
assert(source.includes('await steerActiveConversation(question, textarea)'));
assert(html.includes('class="dshw-primary" title="Send" aria-label="Send" disabled'));
assert(source.includes('function syncComposerSubmitState()'));
assert(source.includes("submit.disabled = !studioComposerBusy && !textarea.value.trim()"));
/* 空输入时发送键整颗压到 .4，底色保持透明。这条以前钉的是 opacity: 1
   （把图标本身换成弱色），2026-09-17 抓到的 claude.ai composer.send 明确是
   「空输入禁用态 opacity .4」，以抓到的为准。 */
assert.match(css, /\.dshw-primary:disabled\s*\{[^}]*opacity:\s*\.4[^}]*background:\s*transparent/s,
  'an empty composer dims the whole send button rather than recolouring its glyph');
/* 参考的左半边读作 `＋ 🎤 ⌄ Auto`：附件和语音先出现，模式名跟在它们后面，
   前面带一个 chevron。所以模式触发器不再被提到行首。 */
assert.match(css, /#composer-permission \.dshw-perm-chev\s*\{[^}]*order:\s*-1/s,
  'the mode trigger reads as a leading chevron plus the current mode name');
assert(!/#composer-permission\s*\{[^}]*order:\s*-2/s.test(css),
  'attach and mic come first; the mode name is not hoisted to the front');
assert(source.includes('contextRow.hidden = !visible && Boolean(activeProjectRoot)'));
/* 占位语现在经过一层：会话里优先显示联想词，其余情况回到这两句静态提示。 */
assert(source.includes("const COMPOSER_PLACEHOLDER_HOME = 'Describe a task or ask a question'"));
assert(source.includes("const COMPOSER_PLACEHOLDER_THREAD = 'Type / for commands'"));
assert(source.includes('textarea.placeholder = !home && composerSuggestion ? composerSuggestion : base'),
  'the unaccepted suggestion stays a placeholder until the user explicitly accepts it');
assert(source.includes('void refreshComposerSuggestion('),
  'the suggestion is fetched after the turn settles and does not block the composer');
assert(source.includes('clearComposerSuggestion();'), 'a consumed or stale suggestion is dropped');
assert(plan.includes("heading.textContent = 'Plan'"));
assert(source.includes("document.getElementById('project-plan')"), 'the plan lives in the task rail');
assert(source.includes('PlanList.render(host, composerPlan,'));
assert(decisionCard.includes("element('section', 'mp-decision-card')"));
assert(decisionCard.includes("element('div', 'mp-decision-actions')"));
assert(decisionCard.includes('host.replaceChildren(card)'));
assert(source.includes('DecisionCard.render(host,'), 'the composer must mount the shared decision component');
assert(!html.includes('id="stats-line"'), 'Claude composer has no second telemetry text row beneath its toolbar');
assert(!source.includes('function renderStatsLine('), 'usage remains in the context control, not loose bottom text');
assert(html.includes('id="composer-effort"'), 'composer exposes the direct effort trigger');
assert(html.includes('id="composer-effort-menu"'), 'composer exposes the direct five-level effort popup');
assert(html.includes('id="composer-effort-label">Extra</span>'), 'Extra is the selected effort label');
assert(!html.includes('id="composer-options"') && !html.includes('id="composer-style"'),
  'the former response-style nesting is removed');
assert(!html.includes('Response style'), 'effort is not presented as a writing style');
/* 语音在参考里属于左半边（`＋ 🎤 ⌄ Auto`），和附件同组；右半边只放模型、
   effort 和用量环。 */
assert.match(html, /id="composer-mention"[\s\S]*?id="composer-voice"[\s\S]*?id="composer-permission"/,
  'voice sits with attach on the left, between the mention and mode controls');
assert.match(html, /id="composer-effort-menu"[^>]*><\/div>[\s\S]*?id="composer-context"/,
  'the usage ring stays the last trailing control');
assert(source.includes('const effortLevels = (globalThis as { EffortLevels?: EffortLevelsModule }).EffortLevels!'));
assert(source.includes('const EFFORT_STORAGE_KEY'), 'the effort level outlives the session');
assert(source.includes('function persistEffort()'));
assert(source.includes('function openEffortMenu()'));
assert(source.includes('positionAnchoredPopover('));
assert(source.includes('closeStudioPopovers('));
/* 行首图标没有了：参考里的 Mode 菜单是「两行文字 + 行尾编号」，不放图标。
   这条以前钉的是 .dshw-perm-row-glyph 必须在，现在反过来。 */
for (const selector of [
  '.dshw-perm-row',
  '.dshw-perm-row-text',
  '.dshw-perm-check',
  '.dshw-perm-key',
  '.dshw-perm-heading',
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
/* 勾现在优先用 Claude 的字体字形（check U+E03B），尺寸由 .cds-icon 的字号档
   决定；只有在字体模块缺失、退回自绘 svg 时才需要一个显式尺寸。
   所以钉的是「退回路径仍有尺寸」，而不是「这个类永远写死 16」。 */
assert.match(css, /\.dshw-perm-check svg\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s,
  'the svg fallback check keeps explicit dimensions; the glyph sizes itself');

// Actual Chromium size and input regression: scripts/probe_model_menu.cjs.
/* 尾列不再写死 16px：选中勾现在是字体字形（20px 那档），写死 16 会把它压扁。
   用 auto，让槽跟着字形走。 */
assert.match(css, /\.dshw-model-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s,
  'model rows reserve a trailing slot that follows the glyph rather than a fixed 16px');
assert(html.includes('class="mp-context-track"') && html.includes('class="mp-context-value"'));
assert(source.includes('Number(latestUsage?.contextWindow) || Number(currentModel?.contextWindow) || 0'));
assert(source.includes("button.style.setProperty('--mp-context-progress', String(contextProgress))"));
assert(source.includes('button.hidden = false'));
assert.match(css, /\.mp-context-value\s*\{[^}]*stroke-dasharray:\s*var\(--mp-context-progress\) 100/s);
assert.match(css, /\.mp-shell\[data-task-surface="background"\] \.dshw-composer-stack\s*\{[^}]*padding-inline:\s*40px/s,
  'the supplied Background tasks surface leaves a 40px composer gutter');
assert.match(css, /\.mp-shell\[data-task-surface="background"\] \.dsh-flow,[\s\S]*?padding-inline:\s*50px/s,
  'Background tasks reserves the separate measured 50px transcript gutter');

console.log('studio composer states test ok');
