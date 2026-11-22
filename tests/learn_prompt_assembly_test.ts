import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  buildSystemPrompt,
  LEARN_PROMPT_VERSION,
  runAgent,
} from '../electron/runtime/agent';
import {initialToolNames} from '../electron/runtime/agent_services';
import {generativeUiPlugin} from '../electron/runtime/generative_ui';
import {runRuntime} from '../electron/runtime/index';
import {
  buildLearnCourseMemoryBlock,
  buildLearnPrimingMessages,
  buildLearnVoicePrompt,
  classifyLearnTurn,
  CORE_LEARN_SYSTEM,
  detectLearnTopicDomain,
  selectLivingExcerpts,
} from '../electron/runtime/learn_voice';
import {modelPayload} from '../electron/runtime/model';
import {PromptSections} from '../electron/runtime/plugin_context';
import {withProjectSettings} from '../electron/runtime/project_settings';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';
import {withWorkspaceSettings} from '../electron/runtime/workspace_settings';

test('Learn buildSystemPrompt uses compact Living Voice Engine with 3-master uncompressed excerpts and zero engineering bloat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-learn-sys-'));
  try {
    const learnSys = await buildSystemPrompt({
      userDataDir: root,
      workMode: 'learn',
      workspace: root,
      permissionMode: 'accept_reversible',
      instruction: '解释一下 Transformer 的多头注意力机制',
    });
    assert.equal(LEARN_PROMPT_VERSION, 'learn-v4.0-cognitive-studio-20261122');
    assert.match(learnSys, /发消息聊天/);
    assert.match(learnSys, /参考下面三段真实人类讲课时的说话呼吸与直觉切入感/);
    assert.match(CORE_LEARN_SYSTEM, /一字不省/);
    assert.match(learnSys, /一字不省/);
    assert.match(CORE_LEARN_SYSTEM, /FK\.fig/);
    assert.match(learnSys, /FK\.fig/);
    assert.match(learnSys, /FK\.plot/);
    assert.match(learnSys, /FK\.heat/);
    assert.match(learnSys, /FK\.tokens/);
    assert.match(learnSys, /reader-kit/);
    assert.match(learnSys, /Probe摸底/);
    assert.match(learnSys, /单节点四拍/);
    assert.match(learnSys, /严禁橙色装饰框/);
    assert.ok(learnSys.length < 2900, `Learn system prompt should stay compact & non-bloated (<2900), got ${learnSys.length}`);
    assert.ok(learnSys.length < 3200, `Learn system prompt must stay under 3200 chars, got ${learnSys.length}`);
    assert.ok(!learnSys.includes('EgoBrowser.open'), 'Learn prompt must not include EgoBrowser rules');
    assert.ok(!learnSys.includes('verification.matched=true'), 'Learn prompt must not include browser receipt rules');
    assert.ok(!learnSys.includes('Todo completed'), 'Learn prompt must not include Todo engineering rules');
    assert.ok(!learnSys.includes('已给出具体文件名时直接 Read'), 'Learn prompt must not include IDE editing rules');
    assert.ok(!learnSys.includes('当前权限模式'), 'Learn prompt must not repeat permission boilerplate');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Living Voice domain routing selects 3 distinct masters and clean non-list short-chat priming', () => {
  assert.equal(detectLearnTopicDomain('解释一下hadoop这门课要掌握什么'), 'systems_code');
  assert.equal(detectLearnTopicDomain('Transformer 里的位置编码咋回事'), 'ai_paper');
  assert.equal(detectLearnTopicDomain('微积分里特征值向量咋理解'), 'math');
  assert.equal(classifyLearnTurn('嗯行，那节点挂了咋办'), 'chat');
  assert.equal(classifyLearnTurn('帮我写份完整的 Hadoop 期末复习笔记，详细列出全部考点'), 'deep_deliverable');
  assert.equal(classifyLearnTurn('/teach 反向传播'), 'guided_teach');

  for (const domain of ['systems_code', 'ai_paper', 'math', 'general'] as const) {
    const excerpts = selectLivingExcerpts(domain);
    assert.equal(excerpts.length, 3);
    assert.deepEqual(
      excerpts.map(e => e.source),
      ['xia', 'muli', '3b1b'],
    );
  }

  const priming = buildLearnPrimingMessages('解释一下hadoop这门课要掌握什么');
  assert.equal(priming.length, 6);
  const assistantTurns = priming.filter(m => m.role === 'assistant');
  assert.equal(assistantTurns.length, 3);
  for (const turn of assistantTurns) {
    const text = String(turn.content || '');
    assert.ok(text.length <= 220, `Priming reply must stay short like texting, got ${text.length}`);
    assert.ok(!/^#+\s/m.test(text), 'Priming reply must not use Markdown headers');
    assert.ok(!/^\s*[-*]\s/m.test(text), 'Priming reply must not use bullet lists');
    assert.ok(!/^\s*\d+\.\s/m.test(text), 'Priming reply must not use 1. 2. 3. numbered lists');
    assert.ok(!text.includes('顺带问一句'));
    assert.ok(!text.includes('好问题'));
  }

  assert.deepEqual(
    buildLearnPrimingMessages('给我完整大纲并详细列出全部考点'),
    [],
    'Explicit long deliverable request skips short-chat priming',
  );
});

test('generativeUiPlugin suppresses OpenUI prompt in Learn mode and keeps it in Code mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-genui-mode-'));
  try {
    const prompt = new PromptSections();
    const registry = new ToolRegistry();
    const plugin = generativeUiPlugin();
    await plugin.apply(
      {
        get: (key: string) => (key === 'prompt' ? prompt : registry),
        registerTool: (spec: Parameters<ToolRegistry['register']>[0]) =>
          registry.register(spec),
      } as never,
      {},
    );
    const learnText = await prompt.build({
      root,
      userDataDir: root,
      workMode: 'learn',
    } as never);
    const codeText = await prompt.build({
      root,
      userDataDir: root,
      workMode: 'code',
    } as never);
    assert.equal(learnText, '');
    assert.match(codeText, /UI\.describe/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('initialToolNames loads lightweight Learn tools instead of 8 IDE coding tools', () => {
  const learnTools = initialToolNames({
    workspace: 'C:/work/DiskSentry',
    permissionMode: 'accept_reversible',
    workMode: 'learn',
  });
  assert.ok(learnTools.includes('AskUser'));
  assert.ok(learnTools.includes('Search'));
  assert.ok(learnTools.includes('Fetch'));
  assert.ok(learnTools.includes('Knowledge.search'));
  assert.ok(!learnTools.includes('Bash'));
  assert.ok(!learnTools.includes('Edit'));
  assert.ok(!learnTools.includes('Patch'));
  assert.ok(!learnTools.includes('Write'));

  const codeTools = initialToolNames({
    workspace: 'C:/work/DiskSentry',
    permissionMode: 'accept_reversible',
    workMode: 'code',
  });
  assert.ok(codeTools.includes('Read'));
  assert.ok(codeTools.includes('Edit'));
  assert.ok(codeTools.includes('Bash'));
});

test('withProjectSettings skips empty null project and anchors non-null settings at prefix for KV cache stability', () => {
  const turn1 = [{role: 'user' as const, content: 'Q1'}];
  assert.deepEqual(withProjectSettings(turn1, null), turn1);

  const project = {
    id: 'p1',
    root: 'C:/proj',
    name: 'Proj',
    instructions: 'Be concise.',
  };
  const m1 = withProjectSettings(turn1, project);
  const m2 = withProjectSettings(
    [
      {role: 'user', content: 'Q1'},
      {role: 'assistant', content: 'A1'},
      {role: 'user', content: 'Q2'},
    ],
    project,
  );
  assert.equal(m1[0].content, m2[0].content);
  assert.equal(m1[1].content, m2[1].content);

  const ws1 = withWorkspaceSettings(turn1, {
    root: 'C:/proj',
    additionalFolders: [],
  });
  const ws2 = withWorkspaceSettings(
    [
      {role: 'user', content: 'Q1'},
      {role: 'assistant', content: 'A1'},
      {role: 'user', content: 'Q2'},
    ],
    {root: 'C:/proj', additionalFolders: []},
  );
  assert.equal(ws1[0].content, ws2[0].content);
  assert.equal(ws1[1].content, ws2[1].content);
});

test('Learn freezePrompt upgrades legacy frozen prompt when LEARN_PROMPT_VERSION changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-freeze-ver-'));
  try {
    const session = await EventSession.open(root, 'legacy-learn');
    await session.freezePrompt('OLD LEGACY LEARN PROMPT');
    let capturedSystem = '';
    await runAgent({
      root,
      userDataDir: root,
      workMode: 'learn',
      instruction: '你好',
      session,
      registry: new ToolRegistry(),
      model: async request => {
        capturedSystem = request.system;
        return {text: '你好', tool_calls: []};
      },
    });
    assert.ok(!capturedSystem.includes('OLD LEGACY LEARN PROMPT'));
    assert.match(capturedSystem, /发消息聊天/);
    const frozen = [...session.events]
      .reverse()
      .find(event => event.type === 'prompt/frozen');
    assert.equal(frozen?.data.promptVersion, LEARN_PROMPT_VERSION);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('modelPayload forwards temperature and presence_penalty on DeepSeek chat-completions and omits them on o3/gpt-5', () => {
  const deepseekBody = modelPayload(
    {model: 'deepseek-v4.1-flash', apiMode: 'chat-completions'},
    {
      system: 'sys',
      messages: [{role: 'user', content: 'hi'}],
      tools: [],
      temperature: 1.1,
      presencePenalty: 0.15,
    },
  );
  assert.equal(deepseekBody.temperature, 1.1);
  assert.equal(deepseekBody.presence_penalty, 0.15);

  const gpt5Body = modelPayload(
    {model: 'gpt-5.4', apiMode: 'chat-completions'},
    {
      system: 'sys',
      messages: [{role: 'user', content: 'hi'}],
      tools: [],
      temperature: 1.1,
      presencePenalty: 0.15,
    },
  );
  assert.equal(gpt5Body.temperature, undefined);
  assert.equal(gpt5Body.presence_penalty, undefined);
});

test('3-turn Learn runRuntime prepends KV-stable native priming without persisting it to session history', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mp-3turn-living-'));
  const userDataDir = join(base, 'userdata');
  const workspaceDir = join(base, 'DiskSentry');
  await mkdir(userDataDir, {recursive: true});
  await mkdir(workspaceDir, {recursive: true});

  const bodies: Array<Record<string, any>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body || '{}')));
    const payload = [
      `data: ${JSON.stringify({
        id: 'cmpl-test',
        object: 'chat.completion.chunk',
        choices: [{index: 0, delta: {role: 'assistant', content: '明白，我们顺着这条线往下聊。'}, finish_reason: null}],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: 'cmpl-test',
        object: 'chat.completion.chunk',
        choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
      })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    return new Response(payload, {
      status: 200,
      headers: {'Content-Type': 'text/event-stream'},
    });
  }) as typeof fetch;

  try {
    const sessionId = 'agent-studio-conv-living3turn01';
    const common = {
      workMode: 'learn',
      conversationId: 'conv-living-3turn',
      agentSessionId: sessionId,
      workspaceRoot: workspaceDir,
      projectContext: null,
      additionalFolders: [],
      permissionPreset: 'auto',
      effort: 'medium',
      modelRuntime: {
        model: 'deepseek-v4.1-flash',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiMode: 'chat-completions',
        credential: 'sk-test-local',
      },
    };
    const questions = [
      '解释一下hadoop这门课到底需要掌握什么啊',
      '<quoted_reply turn="0">客户端 → DN1 → DN2 → DN3</quoted_reply>\n\n为啥要串联？',
      '嗯行，那节点写一半挂了咋办？',
    ];
    for (let i = 0; i < questions.length; i++) {
      await runRuntime(
        {...common, question: questions[i], taskInput: {inputId: `q-${i + 1}`}},
        {root: join(__dirname, '..'), userDataDir},
      );
    }
    assert.equal(bodies.length, 3);
    // Turn 1: [system, 6 native priming turns (u/a/u/a/u/a), U1] = 8 messages
    assert.deepEqual(
      bodies[0].messages.map((m: {role: string}) => m.role),
      ['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'],
    );
    // Turn 2: + [A1, U2] = 10 messages
    assert.deepEqual(
      bodies[1].messages.map((m: {role: string}) => m.role),
      ['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'],
    );
    // Turn 3: + [A2, U3] = 12 messages
    assert.deepEqual(
      bodies[2].messages.map((m: {role: string}) => m.role),
      ['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user'],
    );
    // KV prefix cache stability: Turn 1 prefix is byte-identical in Turn 2, Turn 2 prefix is byte-identical in Turn 3!
    assert.deepEqual(bodies[1].messages.slice(0, 8), bodies[0].messages);
    assert.deepEqual(bodies[2].messages.slice(0, 10), bodies[1].messages);

    // Priming messages must NEVER leak into persisted session history!
    const persisted = await EventSession.open(userDataDir, sessionId);
    const derived = persisted.deriveMessages();
    assert.equal(derived.length, 6, 'Persisted session must contain only the 3 real user/assistant pairs');
    assert.ok(!JSON.stringify(derived).includes('B+ 树'));

    // Zero noise guarantees
    const allTurn3 = JSON.stringify(bodies[2].messages);
    assert.ok(!allTurn3.includes('MAGIC_POINTER_EVIDENCE'));
    assert.ok(!allTurn3.includes('[Project settings]'));
    assert.ok(!allTurn3.includes('[Workspace folders]'));
    assert.ok(!allTurn3.includes('UI.describe'));
    assert.equal(bodies[0].temperature, 1.1);
    assert.equal(bodies[0].presence_penalty, 0.15);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(base, {recursive: true, force: true});
  }
});

test('buildLearnCourseMemoryBlock formats stuck concepts, annotations, and Dream bridge cleanly while ignoring empty/null input', () => {
  assert.equal(buildLearnCourseMemoryBlock(null), '');
  assert.equal(buildLearnCourseMemoryBlock(undefined), '');
  assert.equal(buildLearnCourseMemoryBlock({}), '');
  assert.equal(
    buildLearnCourseMemoryBlock({
      courseTitle: '   ',
      stuckConcepts: [],
      recentAnnotations: [],
      latestDreamSummary: '',
    }),
    '',
  );

  const plainPrompt = buildLearnVoicePrompt({
    topicText: '解释一下 Softmax 数值稳定性',
    localDate: '2026-11-22',
    platform: 'win32',
    courseMemory: null,
  });
  assert.ok(!plainPrompt.includes('<learn_course_memory>'));

  const courseMemory = {
    courseTitle: 'CS336 语言模型从零构建',
    currentNodeTitle: 'FlashAttention Tiling',
    stuckConcepts: [
      {
        concept: 'Online Softmax Rescaling',
        lastAngle: '纯代数公式推导',
        evidence: '连续两轮追问分母何时重缩放',
      },
    ],
    recentAnnotations: [
      {
        type: 'confused',
        quote: '为什么要维护 running max m_i',
        note: '两块合并那步没看明白',
        section: '核心递推',
      },
      {
        type: 'verbose',
        quote: '前面动机铺垫太长了',
        section: '引言',
      },
    ],
    latestDreamSummary:
      '上一轮已掌握分块动机，本轮直接用 4x4 矩阵手算走通 online softmax 再进代码。',
  };

  const block = buildLearnCourseMemoryBlock(courseMemory);
  assert.ok(block.startsWith('<learn_course_memory>'));
  assert.ok(block.endsWith('</learn_course_memory>'));
  assert.match(block, /CS336 语言模型从零构建/);
  assert.match(block, /FlashAttention Tiling/);
  assert.match(block, /Online Softmax Rescaling/);
  assert.match(block, /纯代数公式推导/);
  assert.match(block, /换用不同于“上次角度”的全新切入方式/);
  assert.match(block, /连续两轮追问分母何时重缩放/);
  assert.match(block, /✎/);
  assert.match(block, /\[confused\]/);
  assert.match(block, /为什么要维护 running max m_i/);
  assert.match(block, /两块合并那步没看明白/);
  assert.match(block, /\[verbose\]/);
  assert.match(block, /前面动机铺垫太长了/);
  assert.match(
    block,
    /上一轮已掌握分块动机，本轮直接用 4x4 矩阵手算走通 online softmax 再进代码。/,
  );

  const promptWithCourse = buildLearnVoicePrompt({
    topicText: '带我继续学 FlashAttention 分块归约',
    localDate: '2026-11-22',
    platform: 'win32',
    courseMemory,
  });
  const memIdx = promptWithCourse.indexOf('<learn_course_memory>');
  const langIdx = promptWithCourse.indexOf('使用用户的语言回答。');
  assert.ok(memIdx > 0, 'Course memory block must be injected into voice prompt');
  assert.ok(
    memIdx < langIdx,
    'Course memory block must appear cleanly before the language line',
  );
});
