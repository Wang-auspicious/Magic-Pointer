'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const DshIcons = require('../electron/renderer/dsh_icons');
const DshChat = require('../electron/renderer/dsh_chat');
const PermissionPresets = require('../electron/renderer/permission_presets');

// These are copied verbatim from deepseek-harness ui-primitives/icons/index.tsx.
// A visually-similar 24px stroke glyph is not an acceptable substitute.
const THINK_PATH = 'M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z';
const EDIT_PATH = 'M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942';
const API_PATH = 'M11.4818 5.57813C11.4818 4.45301 11.4807 3.66237 11.4075 3.05908';
const COPY_PATH = 'M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598';
const SEND_PATH = 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418';
const PERSONALIZATION_PATH = 'M10.3232 9.18164C11.2868 9.18164 12.0985 9.82833';
const PROJECT_ADD_PATH = 'M3.55246 0L3.55246 2.44252L6 2.44252';
const FOLDER_CLOSE_PATH = 'M5.05582 0.518756L4.50669 0.86654L5.05582 0.518756';
const SETTINGS_PATH = 'M14.0861 5.51366C13.8717 5.0575 13.588 4.58542';
const AGENT_PRESET_PATH = 'M12.2881 11.0425C12.6002 11.3723 13.0413 11.5786';
const DOWNLOAD_PATH = 'M15.3695 11.411L15.1234 12.8866C14.8869 14.3042';

assert(DshIcons.node('think', 14).outerHTML.includes(THINK_PATH), 'Think must use the exact DSH fill glyph');
assert(DshIcons.node('edit', 14).outerHTML.includes(EDIT_PATH), 'Edit must use the exact DSH fill glyph');
assert(DshIcons.node('api', 14).outerHTML.includes(API_PATH), 'Pwsh must use DSH IconApiOutline14');
assert(DshIcons.node('copy', 16).outerHTML.includes(COPY_PATH), 'Copy must use the exact DSH glyph');
assert(DshIcons.node('send', 16).outerHTML.includes(SEND_PATH), 'Send must use the exact DSH input-bar glyph');
assert(!DshIcons.node('think', 14).outerHTML.includes('stroke-width="1.5"'), 'DSH fill icons must not regress to homemade stroke icons');

const pwsh = DshChat.toolRowModel('pwsh', '{"command":"Get-Process"}', { text: 'ok' });
assert.strictEqual(pwsh.title, 'Pwsh', 'pwsh uses the shell family but retains the DSH Pwsh title');
assert(DshChat.toolRowNode(pwsh).outerHTML.includes(API_PATH), 'Pwsh row must render IconApiOutline14');

const workspace = PermissionPresets.optionOf('workspace-write');
const workspaceSvg = PermissionPresets.presetSvg(workspace);
assert(workspaceSvg.includes('M8.08887 0.251709'), 'workspace-write must use the DSH shield body');
assert(workspaceSvg.includes('M8.14852 14.1308'), 'workspace-write must include the DSH pencil layer');
assert.strictEqual((workspaceSvg.match(/<path/g) || []).length, 5, 'workspace-write is the complete five-path DSH glyph');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const sprite = fs.readFileSync('electron/renderer/icons.ts', 'utf8');
const shellCss = fs.readFileSync('electron/renderer/dsh_web.css', 'utf8');
const studioSource = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const tokens = fs.readFileSync('electron/renderer/dsh_tokens.css', 'utf8');
assert(html.includes('id="chat-source-thumb"'), 'the header must own an actual source thumbnail');
assert(html.includes('id="mp-context-tag"'), 'the ZCode-style source tag must be independent from preview');
assert(!html.includes('id="chat-origin-text"'), 'the header must not paint a project/folder path into the preview control');
assert(html.indexOf('dsh_icons.js') < html.indexOf('dsh_chat.js'), 'exact DSH icons must load before the chat renderer');

for (const [id, path] of [
  ['ic-dsh-personalization', PERSONALIZATION_PATH],
  ['ic-dsh-project-add', PROJECT_ADD_PATH],
  ['ic-dsh-folder-close', FOLDER_CLOSE_PATH],
  ['ic-dsh-settings', SETTINGS_PATH],
  ['ic-dsh-agent-preset', AGENT_PRESET_PATH],
  ['ic-dsh-download', DOWNLOAD_PATH],
]) {
  assert(sprite.includes(`id="${id}"`), `${id} must be present in the DSH shell sprite`);
  assert(sprite.includes(path), `${id} must preserve the exact DSH path data`);
}

assert(html.includes('<use href="#ic-dsh-personalization"'), 'Workspace filter must use IconPersonalizationOutline16');
assert(html.includes('<use href="#ic-dsh-project-add"'), 'Workspace create must use IconProjectAddOutline16');
assert(html.includes('<use href="#ic-dsh-settings"'), 'Settings must use IconSettingsOutline16');
assert(html.includes('<use href="#ic-dsh-agent-preset"'), 'Header preset label must use IconAgentPresetOutline16');
assert(html.includes('<use href="#ic-dsh-download"'), 'Session log must use IconDownloadOutline16');
assert(!html.includes('class="dshw-agent-mark"'), 'Header preset must not fall back to a homemade MP badge');

assert(shellCss.includes('background: transparent;\n  color: var(--dsw-alias-label-primary);'), 'Session log must preserve the source transparent/primary treatment');
assert(shellCss.includes('.dshw-session-log svg { width: 12px; height: 12px; }'), 'Session log download glyph is source-sized at 12px');
assert(tokens.includes('--dsw-alias-label-dimmed: rgb(225, 229, 238);'), 'light tokens must include the source label-dimmed value');
assert(tokens.includes('--dsw-alias-label-dimmed: rgb(67, 69, 74);'), 'dark tokens must include the source label-dimmed value');
assert(tokens.includes('--dsw-alias-border-inverted: rgba(255, 255, 255, 0.06);'), 'dark border-inverted must match DSH exactly');
assert(studioSource.includes("group.items.some((conversation) => conversation.id === active)"), 'the expanded current workspace must drive DSH folder-active state');
assert(studioSource.includes('?? list[0]?.id'), 'initial workspace rendering must anticipate the first opened conversation');
assert(shellCss.includes(".dshw-project.is-active[data-open='true'] .dshw-project-folder"), 'current expanded workspace folder must use the DSH business color');

console.log('studio DSH source parity test ok');
