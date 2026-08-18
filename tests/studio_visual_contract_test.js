'use strict';

const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const css = fs.readFileSync('electron/renderer/dsh_web.css', 'utf8');
const tokens = fs.readFileSync('electron/renderer/dsh_tokens.css', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const settings = fs.readFileSync('electron/renderer/settings.ts', 'utf8');
const main = fs.readFileSync('electron/main.ts', 'utf8');
const preload = fs.readFileSync('electron/preload.ts', 'utf8');
const data = fs.readFileSync('electron/renderer/data.ts', 'utf8');

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
assert(html.includes('Magic Pointer'), 'the DSH-shaped shell must retain the Magic Pointer brand');
assert(html.includes('>MP</span>'), 'the product mark must remain MP rather than copying the DSH logo');
assert(!html.includes('DeepSeek'), 'the visible shell must not copy the DSH product brand');
assert(!html.includes('class="chat-blank"'), 'the old blank state must be gone');
assert(!html.includes('LOCAL AGENT HARNESS'), 'the sidebar must not show a robotic product subtitle');
assert(!html.includes('id="hero"'));
assert(!html.includes('hero.mp4'));
assert(!html.includes('你指过的每一处'));

/* ---- 主题：双档完整，Studio 首屏默认与参考图一致为 DSH dark ---- */
assert(tokens.includes('body[data-ds-dark-theme]'), 'the dark alias block must exist (DSH full platform)');
assert(tokens.includes('--dsw-specific-bubble: rgb(237, 243, 254)'), 'light user bubble = DeepSeek-50');
assert(tokens.includes('--dsw-specific-bubble: rgb(44, 44, 46)'), 'dark user bubble = bluish-850');
assert(source.includes("document.body.setAttribute('data-ds-dark-theme', '')"),
  'Studio must paint the reference dark shell before settings hydrate');
assert(settings.includes("document.body.toggleAttribute('data-ds-dark-theme'"),
  'the settings theme control must flip the DSH dark flag');
assert.match(css, /body\[data-ds-dark-theme\]\s*\{[^}]*--ink:\s*#F2F1ED/s,
  'aux pages must remap their oreo tokens in the dark theme');

/* ---- 输入卡与统计行 ---- */
assert.match(html, /<form class="dshw-input-form"[\s\S]*?<div class="dshw-card">[\s\S]*?<\/div>\s*<div class="dshw-stats" id="stats-line"[\s\S]*?<\/form>/,
  'the real StatsLine must be the InputBar footer below the card');
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
assert(html.includes('id="composer-permission"'), 'the permission dropdown must exist');
assert(html.includes('id="composer-model"'), 'the model switcher must exist');
assert(html.includes('id="composer-context"'), 'the context ring must exist');
assert(html.includes('dshw-ring-track'), 'the context ring must draw its track');
assert(html.includes('M8.3125 0.980183'), 'the send button must carry the exact DSH arrow path');
assert(source.includes('Data.models()'), 'the model switcher must load the real gateway catalog');
assert(source.includes('Data.selectModel(modelId)'), 'the model switcher must select through the real config write');

/* ---- 回车发送（InputBar 同款分派：组合态 / Shift 放行） ---- */
assert(source.includes("e.key !== 'Enter' || e.shiftKey || e.isComposing"),
  'Enter must send only outside IME composition and without Shift');
assert(source.includes('.requestSubmit()'),
  'Enter and the send button must share one submit path');

/* ---- 聊天渲染 ---- */
assert(source.includes("flow.className = 'dsh-flow'"), 'the chat transcript must render through the DSH chat model');
assert(source.includes('DshChat.userNode('), 'user messages must use the DSH right-aligned bubble');
assert(source.includes('DshChat.assistantTurnNode('), 'assistant turns must render DSH text + Think + tool rows');

/* ---- 侧栏会话行 = DSH 行（无头像色块、无副标题小字） ---- */
assert(html.includes('class="dshw-workspace-browser"'),
  'the conversation region must use the DSH WorkspaceBrowser shell');
assert(html.includes('class="dshw-workspace-header"'),
  'the conversation browser needs the DSH 36px section header');
assert(html.includes('id="side-search-toggle"'),
  'search must disclose inline from the WorkspaceBrowser header');
assert(html.includes('id="side-search-clear"'),
  'the expanded inline search must have the DSH clear affordance');
assert(html.includes('>工作区</span>'), 'the DSH browser section label must be 工作区');
assert(html.includes('id="workspace-filter"'), 'the DSH workspace header needs its filter action');
assert(html.includes('id="workspace-add"'), 'the DSH workspace header needs its add action');
assert(!html.includes('class="dshw-destinations"'),
  'the rejected five-destination custom nav must not occupy the DSH sidebar');
assert(!html.includes('class="local-status"'), 'the DSH footer contains only the settings action');
assert(source.includes("head.className = 'dshw-project-row'"), 'conversations must be grouped below 34px project rows');
assert(html.includes('class="dshw-session-list-seat"'),
  'only the conversation-list seat should scroll beneath the fixed header');
assert(source.includes("classList.add('is-searching')"),
  'clicking the header search icon must expand the inline search');
assert(source.includes("classList.remove('is-searching')"),
  'clearing an empty search must collapse the inline search');
assert(source.includes("row.className = 'side-item'"), 'the session row is the DSH 32px row');
assert(source.includes('className = \'side-dot\''), 'the row leads with the DSH state dot');
assert(source.includes('className = \'side-title\''), 'the row title is a single 14px line');
assert(source.includes('className = \'side-time\''), 'the row trails with DSH relative time');
assert(!source.includes('mark.innerHTML = objectMark(c.objectKey'), 'the C1-style avatar block must be gone from sidebar rows');
assert(!source.includes('text.append(title, sub)'), 'the old title+subtitle stack must be gone');

/* ---- DSH ConversationSession 页头、标签与轨迹 ---- */
assert(html.includes('class="dshw-agent-preset"'), 'the title row needs the DSH static agent preset label');
assert(html.includes('data-conversation-tab="chat"'), 'the header needs the 对话 tab');
assert(html.includes('data-conversation-tab="trajectory"'), 'the header needs the 轨迹 tab');
assert(html.includes('id="session-log"'), 'the header needs the DSH Session log pill');
assert(html.includes('id="mp-surface-menu"'), 'auxiliary MP pages must live in the compact header tag menu');
assert(html.includes('id="trajectory"'), 'the conversation root must own a trajectory seat');
assert(source.includes('DshTrajectory.render('), 'trajectory must render from stored turn data');
assert(source.includes('modelUsage'), 'stats must consume real model usage when available');
assert(source.includes('toolTimeMs'), 'stats must aggregate real tool timing');

/* ---- 实时过程链：request id → Python phase → correlated renderer row ---- */
assert(preload.includes("onProgress: (callback: PayloadCallback) => onPayload('conversations:progress'"),
  'preload must expose the live conversation progress channel');
assert(preload.includes('requestId: String(payload?.requestId'), 'send payload must preserve its correlation id');
assert(main.includes("event.sender.send('conversations:progress'"),
  'main must forward Python progress to the invoking Studio only');
assert(main.includes('requestId, record'), 'forwarded progress must retain the correlation id');
assert(source.includes('Data.onConversationProgress('), 'Studio must subscribe before a turn is sent');
assert(data.includes('onProgress?(cb:'), 'the renderer data contract must expose conversation progress');
assert(source.includes('DshChat.liveActivityNode('), 'live progress must render DSH Think/tool disclosures');

/* ---- 窄窗页头：真实截图缩略图与独立 context tag，不显示项目路径 ---- */
assert(html.includes('id="chat-source-thumb"'),
  'the header source affordance must be the captured image thumbnail');
assert(html.includes('id="mp-context-tag"'),
  'the ZCode-style context tag must be independent from the thumbnail');
assert(!html.includes('id="chat-origin-text"'),
  'the rejected project/folder path label must not return');
assert.match(css, /\.dshw-source-thumb\s*\{[^}]*width:\s*36px[^}]*height:\s*28px/s,
  'the source thumbnail must stay a compact fixed-size header control');
assert.match(css, /\.dshw-origin\s*>\s*span:not\(\.dshw-context-dot\)\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/s,
  'only the independent context tag may ellipsize at narrow widths');

/* ---- 设置保存、DSH 紧凑页头与原位展开表单 ---- */
assert(settings.includes('class="settings-section-toggle"'),
  'each Magic Pointer setting group must use the DSH disclosure-card header');
assert(settings.includes('aria-expanded="${open}"'),
  'settings disclosure state must be announced');
assert(settings.includes('data-settings-section="${escSetting(sectionId)}"'),
  'settings disclosure buttons need stable section identities');
assert(settings.includes("closest<HTMLElement>('[data-settings-section]')"),
  'clicking a settings section must open it in place');
assert.match(css, /\.dshw-settings-options \.settings-page-head h2\s*\{[^}]*font-size:\s*16px/s,
  'settings page titles must use the DSH 16/24 hierarchy, not the old 27px hero');
assert.match(css, /\.dshw-settings-options \.settings-row\s*\{[^}]*padding:\s*16px\s+0/s,
  'settings rows must use DSH 16px vertical density and hairline separation');
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
