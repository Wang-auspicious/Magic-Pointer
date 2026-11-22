import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('1. Scrollbars: settings and preview avoid blocky scrollbar-width:thin/gutter and define sleek webkit pill scrollbars', () => {
  const layoutCss = readRepo('electron/renderer/studio_layout.css');
  const tokensCss = readRepo('electron/renderer/theme_tokens.css');
  const rightCss = readRepo('electron/renderer/right_workspace.css');

  const settingsContentBlock = layoutCss.match(
    /\.mpw-settings-content\s*,\s*\.mp-directory-main\s*\{[^}]*\}/,
  );
  assert.ok(settingsContentBlock, 'must find .mpw-settings-content rule');
  assert.doesNotMatch(
    settingsContentBlock[0],
    /scrollbar-gutter:\s*stable/,
    'settings content must not reserve an ugly permanent Windows scrollbar gutter next to close button',
  );
  assert.doesNotMatch(
    settingsContentBlock[0],
    /scrollbar-width:\s*thin/,
    'settings content must not force Windows blocky scrollbar-width: thin',
  );
  assert.doesNotMatch(
    rightCss,
    /\.mp-file-preview-content\s*\{[^}]*scrollbar-width:\s*thin/s,
    'file preview must use custom webkit overlay-pill scrollbar, not scrollbar-width: thin',
  );
  assert.match(
    tokensCss,
    /::-webkit-scrollbar-thumb/,
    'theme_tokens.css must define sleek global ::-webkit-scrollbar-thumb styling',
  );
});

test('2. Settings Page: Claude Desktop 4.23118 fidelity (tonal rail, borderless divide-y rows, CDS blue switch, custom slider, distinct icons)', () => {
  const layoutCss = readRepo('electron/renderer/studio_layout.css');
  const settingsTs = readRepo('electron/renderer/settings.ts');
  const settingsModelTs = readRepo('electron/renderer/settings_model.ts');

  // Distinct icons: Account must not share ic-spark with Skills.
  const accountMatch = settingsModelTs.match(/id:\s*'account'[\s\S]{0,160}icon:\s*'([^']+)'/);
  const skillsMatch = settingsModelTs.match(/id:\s*'skills'[\s\S]{0,160}icon:\s*'([^']+)'/);
  assert.ok(accountMatch && skillsMatch);
  assert.notEqual(
    accountMatch[1],
    skillsMatch[1],
    'Account and Skills nav items must have distinct icons',
  );
  assert.match(
    settingsTs,
    /'ic-user':\s*'user-circle'/,
    'settings.ts must map ic-user to Anthropicons user-circle',
  );
  assert.match(
    settingsTs,
    /id === 'ic-chev'\s*\?\s*'xs'/,
    'settings select chevron must render at xs size instead of oversized large',
  );

  // Borderless divide-y rows like Claude c54b284f8.
  const listRule = layoutCss.match(/\.mp-settings-list\s*\{[^}]*\}/);
  assert.ok(listRule, 'must find .mp-settings-list rule');
  assert.match(listRule[0], /border:\s*0/, 'settings list must not wrap rows in cheap bordered boxes');

  // CDS Switch checked color uses accent blue instead of harsh black var(--mp-text).
  const switchOn = layoutCss.match(/\.settings-switch\.is-on\s*\{[^}]*\}/);
  assert.ok(switchOn, 'must find .settings-switch.is-on rule');
  assert.doesNotMatch(switchOn[0], /background:\s*var\(--mp-text\)/, 'switch must use CDS accent blue, not black');

  // Custom range slider styling instead of ugly native accent-color.
  assert.match(
    layoutCss,
    /\.settings-range input\[type='range'\]::-webkit-slider-thumb/,
    'settings range slider must use custom thumb styling',
  );
  assert.match(
    layoutCss,
    /\.settings-select\s*>\s*\.cds-icon/,
    'settings select must position .cds-icon chevron cleanly',
  );
});

test('3. Popovers & Cards: Account menu and Auto mode popover match compact Claude Desktop Menu.Popup dimensions', () => {
  const html = readRepo('electron/renderer/studio.html');
  const layoutCss = readRepo('electron/renderer/studio_layout.css');
  const chatCss = readRepo('electron/renderer/chat_styles.css');

  const accountMenuHtml = html.match(/<div class="mp-account-menu"[\s\S]*?<\/div>\s*<button type="button" class="mp-theme-toggle"/);
  assert.ok(accountMenuHtml, 'must find #account-menu block');
  assert.doesNotMatch(
    accountMenuHtml[0],
    /data-size="large"/,
    'Account menu icons must be compact small (15-16px), not oversized large (20px)',
  );

  const accountCss = layoutCss.match(/\.mp-account-menu\s*\{[^}]*\}/);
  assert.ok(accountCss);
  const widthMatch = accountCss[0].match(/width:\s*(\d+)px/);
  assert.ok(widthMatch && Number(widthMatch[1]) <= 228, 'Account menu width must be <= 228px');

  const permCss = chatCss.match(/#composer-permission-menu\s*\{[^}]*\}/);
  assert.ok(permCss);
  const permMax = permCss[0].match(/max-width:\s*min\((\d+)px/);
  assert.ok(permMax && Number(permMax[1]) <= 272, 'Auto mode permission menu max-width must be <= 272px');

  const compactCss = chatCss.match(/\.mp-compact-menu\s*\{[^}]*\}/);
  assert.ok(compactCss);
  const compactMin = compactCss[0].match(/min-width:\s*(\d+)px/);
  assert.ok(compactMin && Number(compactMin[1]) <= 220, 'Compact menus must have min-width <= 220px');
});

test('4. Right Sidebar: Claude Desktop file tree parity (carets, ChatFileIcons, CDS filter input, indent guides)', () => {
  const studioTs = readRepo('electron/renderer/studio.ts');
  const html = readRepo('electron/renderer/studio.html');
  const rightCss = readRepo('electron/renderer/right_workspace.css');

  assert.match(
    studioTs,
    /mp-file-tree-caret/,
    'renderProjectFileTree must include rotating caret for folders like Claude Desktop',
  );
  assert.match(
    studioTs,
    /ChatFileIcons[\s\S]{0,160}fileIconFor/,
    'renderProjectFileTree must render real file-type icons via ChatFileIcons.fileIconFor',
  );
  assert.match(
    rightCss,
    /\.mp-file-tree-row[\s\S]{0,300}height:\s*26px/,
    'file tree row height must match Claude 26px pitch',
  );
  assert.match(
    html,
    /id="header-files-toggle"[^>]*data-workspace-mode="code"|data-workspace-mode="code"[^>]*id="header-files-toggle"/,
    'Files header icon should scope to legacy Code mode so Learn header stays clean like Claude',
  );
});

test('5. Intelligence UI: eliminates infinite +6px height feedback loop and ships Claude-grade sandbox styling', () => {
  const sandboxHtml = readRepo('electron/renderer/iui_sandbox.html');
  const iuiTs = readRepo('electron/renderer/intelligence_ui.ts');

  assert.doesNotMatch(
    sandboxHtml,
    /document\.documentElement\.scrollHeight/,
    'iui_sandbox.html must NOT measure documentElement.scrollHeight (causes infinite growth to 686px blank void)',
  );
  assert.match(
    sandboxHtml,
    /root\.getBoundingClientRect\(\)/,
    'iui_sandbox.html must measure actual #mp-iui-root content height',
  );
  assert.doesNotMatch(
    iuiTs,
    /Math\.round\(h\)\s*\+\s*6/,
    'intelligence_ui.ts must NOT add +6px per resize feedback loop',
  );
  assert.match(
    sandboxHtml,
    /input\[type="range"\]::-webkit-slider-thumb/,
    'iui_sandbox.html must style range sliders cleanly instead of ugly native orange browser sliders',
  );
  assert.match(
    sandboxHtml,
    /scrollbar-width:\s*none/,
    'iui_sandbox.html must hide iframe scrollbars like Claude visual sandbox',
  );
});

test('6. System Prompt: natural human conversation with zero forced robotic closing quiz templates', () => {
  const agentSrc = readRepo('electron/runtime/agent.ts');
  const learnPromptMatch = agentSrc.match(/const LEARN_HARNESS_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\);/);
  assert.ok(learnPromptMatch, 'must locate LEARN_HARNESS_PROMPT');
  const promptBody = learnPromptMatch[1];

  assert.doesNotMatch(
    promptBody,
    /3~6\s*句|顺手抛.*1\s*个.*追问|轻追问或挑刺/,
    'LEARN_HARNESS_PROMPT must NOT muzzle replies to 3-6 sentences or force a robotic closing quiz question',
  );
  assert.match(
    promptBody,
    /严禁.*模板.*追问|严禁.*顺带问一句|严禁.*固定.*追问/,
    'LEARN_HARNESS_PROMPT must explicitly ban robotic closing quiz templates',
  );
  assert.match(
    promptBody,
    /独立成立|不依赖微件|不能用微件代替/,
    'LEARN_HARNESS_PROMPT must ensure prose stands on its own and never dumps just a widget + 1 sentence',
  );
});

test('7. Thought Process: bounded scrollable viewport prevents 2-3 screen floods during streaming and expansion', () => {
  const chatCss = readRepo('electron/renderer/chat_styles.css');
  const chatViewTs = readRepo('electron/renderer/chat_view.ts');

  assert.match(
    chatCss,
    /\.mp-chat-think-viewport\s*\{[^}]*max-height:/s,
    '.mp-chat-think-viewport must have a bounded max-height',
  );
  assert.match(
    chatCss,
    /\.mp-chat-think-viewport\s*\{[^}]*overflow-y:\s*auto/s,
    '.mp-chat-think-viewport must scroll cleanly inside its bounded height',
  );
  assert.match(
    chatCss,
    /\.mp-chat-think\[data-state=['"]running['"]\]\s+\.mp-chat-think-viewport/,
    'streaming thinking must use a compact bounded peek height',
  );
  assert.match(
    chatViewTs,
    /scrollTop\s*=\s*viewport\.scrollHeight/,
    'updateThinkingState must auto-scroll bounded streaming viewport to latest thought line',
  );
});
