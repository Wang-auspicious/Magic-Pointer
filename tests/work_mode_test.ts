import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildSystemPrompt} from '../electron/runtime/agent';
import {modelPayload} from '../electron/runtime/model';
import {EventSession} from '../electron/runtime/session';
const {createConversationStore} = require('../electron/conversation_store');
const ChatMarkdown = require('../electron/renderer/chat_markdown');

test('Learn and Code use distinct task instructions on the same runtime', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mp-learn-mode-'));
  const learn = await buildSystemPrompt({
    userDataDir,
    workspace: '',
    workMode: 'learn',
  } as Parameters<typeof buildSystemPrompt>[0]);
  const legacyWork = await buildSystemPrompt({
    userDataDir,
    workspace: '',
    workMode: 'work',
  } as Parameters<typeof buildSystemPrompt>[0]);
  const code = await buildSystemPrompt({
    userDataDir,
    workspace: '',
    workMode: 'code',
  } as Parameters<typeof buildSystemPrompt>[0]);
  assert.match(learn, /工作模式：Learn/);
  assert.equal(learn, legacyWork);
  assert.match(code, /工作模式：Code/);
  assert.notEqual(learn, code);
});

test('conversation learn tree, highlights, dock, and promote survive reopen', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'mp-learn-session-'));
  const store = createConversationStore({baseDir});
  const conversation = store.appendTurn({
    question: 'Prove Radon-Nikodym',
    workMode: 'learn',
    answer: 'Main proof',
  });
  const appended = store.appendBranchTurn({
    conversationId: conversation.id,
    parentBranchId: null,
    parentTurnIndex: 0,
    anchor: {
      kind: 'term',
      label: 'σ-有限测度',
      snippet: 'σ-有限测度',
      gloss: '可拆成可数个有限测度集之并',
    },
    agentSessionId: 'agent-branch-1',
    forkMessageCount: 2,
    question: '为什么必须假设 σ-有限？',
  });
  assert.ok(appended);
  store.updateBranchTurn({
    conversationId: conversation.id,
    branchId: appended.branch.id,
    turnIndex: 0,
    answer: '否则计数测度会给出反例。',
    outcome: '已完成',
    runtimeTurn: 2,
  });
  store.updateBranchMeta(conversation.id, appended.branch.id, {docked: true});
  store.toggleUserHighlight(conversation.id, {
    branchId: null,
    turnIndex: 0,
    quote: 'Main proof',
  });
  store.flush();

  const reopened = createConversationStore({baseDir});
  const loaded = reopened.get(conversation.id);
  assert.equal(loaded.workMode, 'learn');
  assert.equal(loaded.branches.length, 1);
  assert.equal(loaded.branches[0].docked, true);
  assert.equal(loaded.userHighlights.length, 1);

  const promoted = reopened.promoteBranch(conversation.id, appended.branch.id);
  assert.ok(promoted);
  assert.equal(promoted.turns.length, 2);
  assert.equal(promoted.workMode, 'learn');
});

test('EventSession fork records forkMessageCount and pins 4th prompt-cache breakpoint', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mp-fork-cache-'));
  const root = await EventSession.open(userDataDir, 'agent-root', true);
  await root.startTurn(1);
  await root.appendMessage({role: 'user', content: 'Root Q'});
  await root.appendMessage({role: 'assistant', content: 'Root A'});
  await root.endTurn('completed');

  const child = await root.fork(userDataDir, 'agent-child', 1);
  assert.equal(child.forkMessageCount(), 2);

  const payload = modelPayload(
    {
      provider: 'anthropic',
      apiMode: 'messages',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test',
      model: 'claude-sonnet-4-20250514',
    } as Parameters<typeof modelPayload>[0],
    {
      system: 'Learn system prompt',
      tools: [{name: 'Read', description: 'read', parameters: {type: 'object'}}],
      forkMessageCount: 2,
      messages: [
        {role: 'user', content: 'Root Q'},
        {role: 'assistant', content: 'Root A'},
        {role: 'user', content: 'Branch Q1'},
        {role: 'assistant', content: 'Branch A1'},
        {role: 'user', content: 'Branch Q2'},
      ],
    },
  );
  // Breakpoint 1: system, Breakpoint 2: tools, Breakpoint 3: fork boundary (msg 1), Breakpoint 4: prior turn (msg 3)
  assert.ok(payload.system[0].cache_control);
  assert.ok(payload.tools[0].cache_control);
  assert.ok(payload.messages[1].content[0].cache_control);
  assert.ok(payload.messages[3].content[0].cache_control);
});

test('ChatMarkdown renders KaTeX math without underscore corruption plus cards, terms, and highlights', () => {
  const html = ChatMarkdown.render(
    [
      ':::card [P0] 核心收敛判据',
      '当 ==级数 $\\sum_{i=1}^n x_i + y_i$ 绝对收敛== 时，满足 [[一致可积|尾概率积分对全体指标一致趋于零]]。',
      '$$\\int_{\\Omega} f_n \\, d\\mu \\to \\int_{\\Omega} f \\, d\\mu$$',
      ':::',
    ].join('\n'),
  ).outerHTML;
  assert.match(html, /class="mp-learn-card"[^>]*data-priority="p0"/);
  assert.match(html, /class="mp-learn-mark"/);
  assert.match(html, /class="mp-learn-term"[^>]*data-mp-learn-gloss="尾概率积分对全体指标一致趋于零"/);
  assert.match(html, /class="katex"/);
  assert.doesNotMatch(html, /<em>i=1\^n x<\/em>/);
});
