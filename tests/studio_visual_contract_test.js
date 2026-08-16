'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/dsh_web.css', 'utf8');
const tokens = fs.readFileSync('electron/renderer/dsh_tokens.css', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const settings = fs.readFileSync('electron/renderer/settings.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');

/* ---- DSH Web 外壳（deepseek-harness 100% 移植） ---- */
assert.strictEqual((html.match(/class="dshw-frame"/g) || []).length, 1, 'shell must be the DSH three-column frame');
assert(html.includes('class="dshw-sidebar"'), 'the left column must be the DSH sidebar');
assert(html.includes('class="dshw-new-session"'), 'the sidebar must carry the DSH new-session bar');
assert(html.includes('class="dshw-conversation"'), 'chat must be the DSH conversation column');
assert(html.includes('class="dshw-composer-seat"'), 'the composer must sit in the DSH sticky seat');
assert(html.includes('id="stats-line"'), 'the DSH stats line must exist under the input');
assert(html.includes('class="dshw-input-form"'), 'the composer must be the DSH input card form');
assert(html.includes('class="dshw-primary"'), 'the send button must be the DSH blue circle');
assert(html.includes('class="dshw-settings-overlay"'), 'settings must open as the DSH centered modal');
assert(html.includes('class="dshw-settings-panel"'), 'the settings panel must be the DSH 800px dialog');
assert(html.includes('data-settings-close'), 'the mask and close button must close the modal');
assert(html.includes('id="settings-search"'), 'the settings search field must live in the modal nav');
assert(html.includes('id="set-nav"'), 'the settings nav must render inside the modal');
assert(html.includes('id="set-body"'), 'the settings options must render inside the modal');
assert(html.includes('id="side-convos"'), 'the session list must stay in the sidebar region');
assert(!html.includes('class="chat-blank"'), 'the old blank state must be gone');
assert(!html.includes('LOCAL AGENT HARNESS'), 'the sidebar must not show a robotic product subtitle');
assert(!html.includes('id="hero"'));
assert(!html.includes('hero.mp4'));
assert(!html.includes('你指过的每一处'));

/* ---- 主题：双档完整，默认 system（黑底白字 / 白底黑字都对） ---- */
assert(tokens.includes('body[data-ds-dark-theme]'), 'the dark alias block must exist (DSH full platform)');
assert(tokens.includes('--dsw-specific-bubble: rgb(237, 243, 254)'), 'light user bubble = DeepSeek-50');
assert(tokens.includes('--dsw-specific-bubble: rgb(44, 44, 46)'), 'dark user bubble = bluish-850');
assert(source.includes("toggleAttribute('data-ds-dark-theme'"), 'Studio must boot the DSH theme before first paint');
assert(source.includes("matchMedia('(prefers-color-scheme: dark)')"), 'the default must follow the system like DSH');
assert(settings.includes("document.body.toggleAttribute('data-ds-dark-theme'"),
  'the settings theme control must flip the DSH dark flag');
assert.match(css, /body\[data-ds-dark-theme\]\s*\{[^}]*--ink:\s*#F2F1ED/s,
  'aux pages must remap their oreo tokens in the dark theme');

/* ---- 输入卡与统计行 ---- */
assert.match(css, /\.dshw-card\s*\{[^}]*border-radius:\s*22px/s, 'the input card keeps the DSH 22px radius');
assert.match(css, /\.dshw-input\s*\{[^}]*min-height:\s*52px/s, 'the textarea keeps the DSH 2-line floor');
assert.match(css, /\.dshw-primary\s*\{[^}]*background:\s*var\(--dsw-alias-button-info-fill\)/s,
  'the send circle rides the DSH info-fill token');
assert.match(css, /\.dshw-stats\s*\{[^}]*font-size:\s*12px/s, 'the stats line is the DSH 12/20 strip');
assert(source.includes('fitComposer('), 'the DSH composer must auto-grow');
assert(source.includes('Math.min(336, ta.scrollHeight)'), 'the composer must cap at the DSH 14-line height');
assert(source.includes('renderStatsLine('), 'the stats line must render real turn/step counts');
assert(!source.includes('form.workspace-composer'), 'the old Oreo composer wiring must be gone');

/* ---- 内嵌控制栏（DSH InputBar 1:1） ---- */
assert(html.includes('id="composer-add"'), 'the + expand control must exist');
assert(html.includes('id="composer-model"'), 'the model switcher must exist');
assert(html.includes('id="composer-context"'), 'the context ring must exist');
assert(html.includes('dshw-ring-track'), 'the context ring must draw its track');
assert(html.includes('M8.3125 0.980183'), 'the send button must carry the exact DSH arrow path');
assert(source.includes('modelStatus?.displayName'), 'the model switcher must show the real active model');

/* ---- 回车发送（InputBar 同款分派：组合态 / Shift 放行） ---- */
assert(source.includes("e.key !== 'Enter' || e.shiftKey || e.isComposing"),
  'Enter must send only outside IME composition and without Shift');
assert(source.includes('form.requestSubmit()'),
  'Enter and the send button must share one submit path');

/* ---- 聊天渲染 ---- */
assert(source.includes("flow.className = 'dsh-flow'"), 'the chat transcript must render through the DSH chat model');
assert(source.includes('DshChat.userNode('), 'user messages must use the DSH right-aligned bubble');
assert(source.includes('DshChat.assistantTurnNode('), 'assistant turns must render DSH text + Think + tool rows');

/* ---- 设置保存与页头 ---- */
assert(source.includes('if (view !== \'settings\') lastNonSettingsView = view'),
  'closing the settings modal must return to the previous view');
assert(source.includes("closest('[data-settings-close]')"),
  'the mask and close button must close the modal');

/* ---- 收藏箱/记忆保留 ---- */
assert(html.includes('id="canvas"'), 'the stash canvas must stay');
assert(html.includes('id="mem-list"'), 'the memory page must stay');
assert(html.includes('id="art-list"'), 'the artifacts page must stay');
assert(html.includes('id="tl"'), 'the timeline page must stay');
assert(source.includes('<article class="mem-row enter"'),
  'read-only memories must not pretend to be clickable buttons');
assert.match(source, /const summaryHeight = it\.summary \? 66 : 0/,
  'stash layout must reserve space for the visible image summary');

/* ---- 主进程契约（沿用） ---- */
assert.match(main, /function createDashboardWindow\(initialView = 'chat'\)/,
  'the first dashboard window must know which Studio view was requested');
assert.match(source, /if \(initialView !== 'chat'\) \{\s*show\(initialView\);\s*return;/s,
  'conversation hydration must not overwrite a requested settings or stash first view');
assert(!source.includes('\nboot();'), 'Studio boot must receive the requested initial view');

console.log('studio visual contract test ok');
