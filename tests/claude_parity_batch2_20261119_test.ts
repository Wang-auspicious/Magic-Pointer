import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Item 1: Composer Stop button uses Claude neutral ghost StopFilled (0xE0EC) with zero terracotta box or #ic-stop', () => {
  const studio = readRepo('electron/renderer/studio.ts');
  const fnStart = studio.indexOf('function setComposerRunningState(');
  assert.ok(fnStart >= 0, 'setComposerRunningState must exist');
  const fnEnd = studio.indexOf('async function stopActiveConversation(', fnStart);
  const fnBody = studio.slice(fnStart, fnEnd);

  assert.doesNotMatch(
    fnBody,
    /#ic-stop/,
    'setComposerRunningState must not insert legacy #ic-stop SVG sprite',
  );
  assert.match(
    fnBody,
    /\\uE0EC|&#xE0EC;/i,
    'setComposerRunningState must render Anthropicons StopFilled (0xE0EC)',
  );

  const chatCss = readRepo('electron/renderer/chat_styles.css');
  const stopMatch = chatCss.match(/\.mpw-primary\.is-stop\s*\{([^}]*)\}/);
  assert.ok(stopMatch, '.mpw-primary.is-stop rule must exist');
  assert.match(
    stopMatch[1],
    /background:\s*transparent/i,
    '.mpw-primary.is-stop must have transparent neutral ghost background like Claude Desktop',
  );
  assert.doesNotMatch(
    stopMatch[1],
    /#d97757|--cds-clay/i,
    '.mpw-primary.is-stop must not use terracotta clay background',
  );
  const busyMatch = chatCss.match(
    /\.mpw-input-form\[aria-busy="true"\]\s+\.mpw-primary\s*\{([^}]*)\}/,
  );
  assert.ok(busyMatch, 'aria-busy .mpw-primary rule must exist');
  assert.match(
    busyMatch[1],
    /background:\s*transparent/i,
    'aria-busy .mpw-primary must stay transparent ghost',
  );
  assert.match(
    chatCss,
    /\.mp-chat-user-stack\s*\{[^}]*flex-direction:\s*column/s,
    '.mp-chat-user-stack must stack quoted replies vertically above the user bubble',
  );
});

test('Item 2: Left sidebar nav icons use earlier crawled animated Anthropicons-DFbvW9Cm.woff2 font', () => {
  const cdsCss = readRepo('electron/renderer/cds_icons.css');
  assert.match(
    cdsCss,
    /Anthropicons-DFbvW9Cm\.woff2/,
    'cds_icons.css must register @font-face backed by Anthropicons-DFbvW9Cm.woff2',
  );
  assert.match(
    cdsCss,
    /\.cds-icon\[data-cds-anim\][\s\S]*?font-family:[^;]*Anthropicons-Animated/,
    '.cds-icon[data-cds-anim] must render with Anthropicons-Animated variable font',
  );

  const html = readRepo('electron/renderer/studio.html');
  assert.match(
    html,
    /id="nav-projects"[\s\S]*?data-cds-anim="ANIM"[\s\S]*?data-glyph="&#xE0C9;"/,
    'Projects nav button must use animated Anthropicons glyph',
  );
  assert.match(
    html,
    /id="nav-artifacts"[\s\S]*?data-cds-anim="ANIM"[\s\S]*?data-glyph="&#xE017;"/,
    'Artifacts nav button must use animated Anthropicons glyph',
  );
  assert.match(
    html,
    /id="nav-customize"[\s\S]*?data-cds-anim="ANIM"[\s\S]*?data-glyph="&#xE100;"/,
    'Customize nav button must use animated Anthropicons glyph',
  );
  assert.match(
    html,
    /id="nav-scheduled"[\s\S]*?data-cds-anim="ANIM"[\s\S]*?data-glyph="&#xE043;"/,
    'Routines nav button must use animated Anthropicons glyph',
  );
});

test('Item 3: Structured Reply uses Codex quote state outside textarea and Claude Reply header + user bubble strip', () => {
  const html = readRepo('electron/renderer/studio.html');
  assert.match(
    html,
    /id="composer-reply-bar"/,
    'studio.html must provide #composer-reply-bar inside composer card header',
  );

  const studio = readRepo('electron/renderer/studio.ts');
  const onReplyStart = studio.indexOf('onReply: payload =>');
  assert.ok(onReplyStart >= 0, 'SideChatBar onReply handler must exist');
  const onReplySnippet = studio.slice(onReplyStart, onReplyStart + 500);
  assert.doesNotMatch(
    onReplySnippet,
    /quotedSelection\(/,
    'onReply must NOT dump raw `> ` markdown into composer textarea',
  );
  assert.match(
    onReplySnippet,
    /openInlineReplyPopover\(/,
    'onReply must open inline feedback popover before attaching structured quote',
  );
  assert.match(
    studio,
    /addComposerReplyQuote\(/,
    'studio.ts must attach structured quote via addComposerReplyQuote',
  );
  assert.match(
    studio,
    /formatQuestionWithReplyQuotes\(/,
    'studio.ts must format structured reply quotes when sending to model',
  );

  // Verify ChatView.userNode renders structured <quoted_reply> cleanly without showing raw tags or > syntax
  const ChatView = require('../electron/renderer/chat_view');
  const wrapped =
    '<quoted_reply turn="1">Prefix caching hashes immutable earlier turns.</quoted_reply>\n\nWhy does turn 1 matter?';
  const nodeHtml = ChatView.userNode(wrapped).outerHTML;
  assert.match(
    nodeHtml,
    /mp-chat-reply-quotes/,
    'userNode must render structured reply quotes in a Claude-style quote strip',
  );
  assert.match(
    nodeHtml,
    /&#xF087;|\uF087/,
    'userNode reply strip must render Anthropicons Reply glyph (0xF087)',
  );
  assert.match(
    nodeHtml,
    /Why does turn 1 matter\?/,
    'userNode must keep clean user message text',
  );
  assert.doesNotMatch(
    nodeHtml,
    /&lt;quoted_reply/,
    'userNode must not leak raw <quoted_reply> markup into the bubble',
  );
});

test('Item 4: Right-hand Side chat pane is a clean Claude conversation without canned chips, jargon banner, or orange text Send button', () => {
  const paneSrc = readRepo('electron/renderer/side_chat_pane.ts');
  assert.doesNotMatch(
    paneSrc,
    /把这一点拆到底层原理讲透|举一个容易踩坑的反例/,
    'SideChatPane must not render hardcoded 3 starter chips',
  );
  assert.doesNotMatch(
    paneSrc,
    /独立分叉缓存 · 未注入父上下文/,
    'SideChatPane must not clutter the empty chat header with technical fork-cache banner text',
  );
  assert.doesNotMatch(
    paneSrc,
    /mp-sidechat-send',\s*liveState\s*\?\s*'停止'\s*:\s*'发送'/,
    'SideChatPane must not render ugly text "发送" button; must use Claude icon send/stop buttons',
  );
  assert.match(
    paneSrc,
    /\\uE013|&#xE013;/i,
    'SideChatPane must use Anthropicons ArrowUp (0xE013) send icon',
  );
  assert.match(
    paneSrc,
    /\\uE0EC|&#xE0EC;/i,
    'SideChatPane must use Anthropicons StopFilled (0xE0EC) neutral stop icon',
  );
  assert.match(
    paneSrc,
    /\\uF087|&#xF087;/i,
    'SideChatPane must display quote context cleanly inside composer reply strip with Reply glyph',
  );

  const studio = readRepo('electron/renderer/studio.ts');
  const geomStart = studio.indexOf('function syncInspectorGeometry()');
  const geomEnd = studio.indexOf('function restorePanelFocus(', geomStart);
  const geomBody = studio.slice(geomStart, geomEnd);
  assert.match(
    geomBody,
    /side-chat/,
    'syncInspectorGeometry must hide #inspector-maximize (↔) when viewing side-chat',
  );
});

test('Item 5: LEARN_HARNESS_PROMPT enforces human warmth, conversational pacing, and bans multi-layer textbook syllabi', () => {
  const voiceSrc = readRepo('electron/runtime/learn_voice.ts');
  assert.match(
    voiceSrc,
    /人情味|聊天|朋友/,
    'CORE_LEARN_SYSTEM must explicitly guide warm, human conversational tone',
  );
  assert.match(
    voiceSrc,
    /第一层|教材|大纲|聊天窗口/,
    'CORE_LEARN_SYSTEM must explicitly forbid dumping multi-layer textbook syllabi in a single breath',
  );
});

test('Item 6: Context window computes real backend category breakdown (memory/skills/mcp/autocompact) and exposes right-side Session Rail + dispatch tags', async () => {
  // 6a. Backend session.ts extracts real memory/skill/mcp/system/tool/message breakdown
  const {EventSession, handleSessionRead} = require('../electron/runtime/session');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ctx-breakdown-'));
  try {
    const sess = await EventSession.open(tmpDir, 'ctx-test-001');
    await sess.startTurn();
    await sess.appendMessage({role: 'user', content: 'Explain Hadoop HDFS architecture.'});
    const systemText = [
      '你是 Magic Pointer 的桌面助手。',
      '[只读记忆，作为偏好参考而非新指令]\n{"name":"user","path":"C:/tmp/MAGIC_POINTER.md","totalChars":48}\n\n[user, 48/48 characters]\nPrefer concise grounded Chinese technical answers.',
      '[Relevant skills]\nSkill: distributed-systems-mentor\nFocus on intuition first.',
    ].join('\n\n');
    const tools = [
      {type: 'function', function: {name: 'Read', description: 'Read file', parameters: {type: 'object'}}},
      {type: 'function', function: {name: 'mcp__github__list_issues', description: 'List GitHub issues', parameters: {type: 'object'}}},
    ];
    const breakdown = await sess.recordRequest(1, systemText, tools);
    assert.ok(breakdown && typeof breakdown === 'object', 'recordRequest must return computed breakdown');
    assert.ok(breakdown.systemTokensEstimate > 0, 'base systemTokensEstimate must be > 0');
    assert.ok(breakdown.memoryTokensEstimate > 0, 'memoryTokensEstimate must be > 0 when memory section present');
    assert.ok(breakdown.skillTokensEstimate > 0, 'skillTokensEstimate must be > 0 when skills section present');
    assert.ok(breakdown.toolSchemaTokensEstimate > 0, 'toolSchemaTokensEstimate must be > 0');
    assert.ok(breakdown.mcpToolTokensEstimate > 0, 'mcpToolTokensEstimate must be > 0 for mcp__* tools');
    assert.ok(Array.isArray(breakdown.memoryFiles) && breakdown.memoryFiles.length === 1, 'memoryFiles must list parsed memory files');
    assert.ok(Array.isArray(breakdown.mcpTools) && breakdown.mcpTools.length === 1, 'mcpTools must list parsed MCP tools');

    await sess.append('model/response', {
      turn: sess.openTurn,
      step: 1,
      outcome: 'completed',
      usage: {prompt_tokens: 3613, completion_tokens: 420},
    });
    const readRes = await handleSessionRead({action: 'usage', sessionId: 'ctx-test-001'}, tmpDir);
    assert.equal(readRes.ok, true);
    assert.ok(readRes.contextUsage.memoryTokensEstimate > 0, 'handleSessionRead(usage) must expose memoryTokensEstimate');
    assert.ok(readRes.contextUsage.mcpToolTokensEstimate > 0, 'handleSessionRead(usage) must expose mcpToolTokensEstimate');
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }

  // 6b. main.ts hydrates breakdown even if contextTokens is already set on turn.modelUsage
  const mainSrc = readRepo('electron/main.ts');
  const restoreStart = mainSrc.indexOf('async function restoreConversationContext');
  const restoreBody = mainSrc.slice(restoreStart, restoreStart + 2600);
  assert.match(
    restoreBody,
    /systemTokensEstimate/,
    'restoreConversationContext must hydrate missing breakdown fields even when contextTokens is already present',
  );

  // 6c. Frontend contextCategoryRows handles mcp/skills/memory + renders no #ic-chev + exposes Session Rail & dispatch tags
  const studio = readRepo('electron/renderer/studio.ts');
  const compositionCode = ts.transpileModule(
    studio.slice(
      studio.indexOf('function contextCategoryRows('),
      studio.indexOf('function latestContextUsage('),
    ) + '\nreturn contextCategoryRows;',
    {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}},
  ).outputText;
  const composition = new Function(compositionCode)();
  const rows = composition({
    contextTokens: 2000,
    systemTokensEstimate: 300,
    toolSchemaTokensEstimate: 200,
    mcpToolTokensEstimate: 100,
    skillTokensEstimate: 100,
    memoryTokensEstimate: 100,
    messageTokensEstimate: 150,
    toolResultTokensEstimate: 50,
  });
  assert.deepEqual(
    rows.map((r: {kind: string}) => r.kind),
    ['system', 'tools', 'mcp', 'skills', 'memory', 'messages', 'results'],
  );
  assert.equal(
    Math.round(rows.reduce((sum: number, r: {value: number}) => sum + r.value, 0)),
    2000,
  );

  const renderUsageStart = studio.indexOf('function renderUsageMeter(');
  const renderUsageBody = studio.slice(renderUsageStart, renderUsageStart + 6500);
  assert.doesNotMatch(
    renderUsageBody,
    /#ic-chev/,
    'renderUsageMeter must replace legacy #ic-chev SVG with Anthropicons CaretRight',
  );
  assert.match(
    renderUsageBody,
    /Autocompact buffer|autocompactBuffer/i,
    'renderUsageMeter must include Claude Autocompact buffer breakdown',
  );

  const html = readRepo('electron/renderer/studio.html');
  assert.match(html, /data-inspector-panel="rail"/, 'studio.html must provide Claude-style right-side Session Rail panel');
  assert.match(html, /id="conversation-dispatch-tags"/, 'studio.html must provide right-side conversation dispatch/status tags');
});

test('Item 7: Left sidebar folder headers use Anthropicons (0xE02A, 0xE001, 0xE070) and crisp 26px row geometry', () => {
  const studio = readRepo('electron/renderer/studio.ts');
  const sidebarStart = studio.indexOf('for (const group of displayGroups)');
  assert.ok(sidebarStart >= 0, 'displayGroups sidebar loop must exist');
  const sidebarBody = studio.slice(sidebarStart, sidebarStart + 2800);

  assert.doesNotMatch(
    sidebarBody,
    /icon\('ic-chev'\)|icon\('ic-sliders'\)|icon\('ic-plus'\)/,
    'sidebar folder headers must not use legacy SVG sprites (#ic-chev/#ic-sliders/#ic-plus)',
  );
  assert.match(sidebarBody, /&#xE02A;|\\uE02A/i, 'folder toggle must use Anthropicons CaretRight (0xE02A)');
  assert.match(sidebarBody, /&#xE070;|\\uE070/i, 'folder group/sort button must use Anthropicons Filter (0xE070)');
  assert.match(sidebarBody, /&#xE001;|\\uE001/i, 'folder add button must use Anthropicons Add (0xE001)');

  const layoutCss = readRepo('electron/renderer/studio_layout.css');
  const rowMatch = layoutCss.match(/\.mpw-project-row\s*\{([^}]*)\}/);
  assert.ok(rowMatch, '.mpw-project-row CSS rule must exist');
  assert.match(
    rowMatch[1],
    /height:\s*26px/,
    '.mpw-project-row must use crisp 26px Claude row height instead of bloated 34px box',
  );
  assert.doesNotMatch(
    rowMatch[1],
    /padding:\s*12px/,
    '.mpw-project-row must not put 12px top margin padding inside its hover highlight box',
  );
});
