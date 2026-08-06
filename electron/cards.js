'use strict';

// ============================================================================
// 卡片契约
// ----------------------------------------------------------------------------
// 划完线得到的东西是一张卡，不是一段话。三个界面——指针旁的胶囊、随行窗、
// 工作室——渲染的是同一张卡，所以这份契约必须在渲染层之外、在主进程和渲染
// 进程之间都成立。这里只有纯函数：没有 DOM，没有 IPC，没有 fs。
//
// 两个关键判断，先写在这里，免得后面被改坏：
//
// 1. **卡是活的，不是结果的快照。** 它在工作开始的那一刻就出现，一路更新，
//    最后就地变成结果。所以 `kind` 从第一帧就定下来（这将是一张图 / 一份
//    提案 / 一段话），`state` 才是它走到哪一步了。渲染层因此可以在还没有
//    结果时就画出对的形状，而不是先转一个通用的圈、再整块替换。
//
// 2. **进度不许编。** 有已知阶段就按阶段走，没有就是 null——渲染成一条来回
//    扫的不定量条，配上真实的秒数。一个从 0 平滑爬到 90% 再卡住的假进度条
//    比转圈更糟：它在撒谎。
// ============================================================================

const KINDS = Object.freeze([
  'prose',      // 一段话
  'facts',      // 已确认的事实行
  'metric',     // 一个大数字 + 细分
  'image',      // 一张图（生成 / 修改 / 截取）
  'proposal',   // 要你点头才做的事，带渲染式预览
  'diff',       // 写回预览：改之前 / 改之后
  'table',      // 对比表
  'calendar',   // 日程草稿
  'prompt',     // 交给别的 agent 的提示词草稿
  'steps',      // 只有过程没有产物（整理了三个文件夹这类）
]);

const STATES = Object.freeze(['running', 'done', 'failed']);

// 旧的 result.kind → 新的卡片 kind。stage_contract.js 还在用旧名字，
// 两套名字并存的时间里，翻译只发生在这一个地方。
const LEGACY_KIND = Object.freeze({
  inline: 'prose',
  'text-draft': 'diff',
  'table-compare': 'table',
  'calendar-draft': 'calendar',
  'agent-prompt-draft': 'prompt',
});

function normalizeKind(raw) {
  const key = String(raw || '').trim();
  if (KINDS.includes(key)) return key;
  if (LEGACY_KIND[key]) return LEGACY_KIND[key];
  return 'prose';   // 认不出来的一律当成一段话渲染，绝不留白屏
}

// ---------------------------------------------------------------------------
// 桥送上来的 `@@mp phase=… ms=…` 变成一行人话。
//
// 这些阶段桥一直在报，主进程一直只挑走 `pixels_frozen` 一个、其余全丢掉，
// 于是界面上只剩一个秒数在跳。有真实的步骤可说，就不该让人盯着秒数。
// ---------------------------------------------------------------------------
const PHASE_TEXT = Object.freeze({
  payload_read: '收到了你要问的',
  settings_loaded: '读了设置',
  windows_enumerated: '过了一遍窗口',
  pixels_frozen: '冻住了这块画面',
  structured_read: '读窗口里的文字',
  context_from_snapshot: '凑上下文',
  enrich_screen_region: '补屏幕上的信息',
  route_recipe: '挑了能用的能力',
  model_request: '交给模型',
  model_response: '模型答完了',
  action_planned: '排好了要做的事',
  action_executed: '做完了',
  verify: '回读确认',
  total: '完成',
});

// 常规一次问答会经过的阶段数。用来把「已完成 N 步」换算成进度。
// 不是所有路线都走满，所以它是估计值——因此进度条**不允许倒退**，
// 也不允许在没到终态时显示 100%。
const TYPICAL_PHASES = 7;

function phaseStep(record = {}) {
  const phase = String(record.phase || '').trim();
  if (!phase) return null;
  const label = PHASE_TEXT[phase] || phase.replace(/_/g, ' ');
  const fields = record.fields && typeof record.fields === 'object' ? record.fields : {};
  // 阶段自己带的事实比阶段名有用得多：「冻住了这块画面 2950×1200」
  // 比「冻住了这块画面」更能说明它真的看见了东西。
  let note = '';
  if (fields.w && fields.h) note = `${fields.w}×${fields.h}`;
  else if (fields.hit) note = String(fields.hit);
  else if (fields.recipe) note = String(fields.recipe);
  else if (fields.tier) note = String(fields.tier);
  return {
    phase,
    label,
    note,
    ms: Number.isFinite(record.ms) ? record.ms : null,
    state: 'done',
  };
}

// 已完成步数 → 0..1。走满了估计值也只封到 0.92：剩下那一段留给真正的终态，
// 这样「条走到头了但还没出结果」这种画面不会出现。
function progressFromSteps(steps = [], typical = TYPICAL_PHASES) {
  const done = steps.filter((s) => s && s.state === 'done').length;
  if (!done) return null;
  return Math.min(0.92, done / Math.max(1, typical));
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------
let counter = 0;

function newCardId(seed) {
  counter += 1;
  return `c${seed || 0}-${counter.toString(36)}`;
}

function normalizeCard(raw = {}, options = {}) {
  const kind = normalizeKind(raw.kind);
  const state = STATES.includes(raw.state) ? raw.state : 'done';
  const steps = Array.isArray(raw.steps) ? raw.steps.filter(Boolean) : [];
  const explicit = Number.isFinite(raw.progress) ? clamp01(raw.progress) : null;
  return {
    ...raw,
    id: raw.id || options.id || newCardId(options.seed),
    kind,
    state,
    title: String(raw.title || ''),
    subtitle: String(raw.subtitle || ''),
    steps,
    // 终态一律是满的；失败停在断掉的地方（没有已知进度就是 null，
    // 别按步数估——那会让一次失败看起来像走了一半的成功）；
    // 运行中优先用显式进度，没有就按步数估，再没有就 null。
    progress: state === 'done'
      ? 1
      : (explicit ?? (state === 'failed' ? null : progressFromSteps(steps))),
    stage: String(raw.stage || ''),
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    source: raw.source && typeof raw.source === 'object' ? raw.source : null,
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

// ---------------------------------------------------------------------------
// 打补丁
//
// 三条规矩：
// - 进度只增不减。一条往回缩的进度条会让人以为出错了。
// - 到了终态就锁死。迟到的补丁不能把一张已经失败的卡改活。
// - steps 按 phase 合并，同一个阶段报两次不会出现两行。
// ---------------------------------------------------------------------------
function applyPatch(card, patch = {}) {
  const base = normalizeCard(card);
  if (base.state !== 'running') return base;

  const next = { ...base };

  if (Array.isArray(patch.steps) && patch.steps.length) {
    const byPhase = new Map(next.steps.map((s) => [s.phase || s.label, s]));
    for (const step of patch.steps) {
      if (!step) continue;
      byPhase.set(step.phase || step.label, { ...byPhase.get(step.phase || step.label), ...step });
    }
    next.steps = [...byPhase.values()];
  }

  for (const [key, value] of Object.entries(patch)) {
    if (key === 'steps' || key === 'id' || key === 'progress') continue;
    if (value === undefined) continue;
    next[key] = value;
  }

  if (STATES.includes(patch.state)) next.state = patch.state;
  if (next.state === 'done') {
    next.progress = 1;
  } else if (next.state === 'failed') {
    next.progress = base.progress;   // 停在断掉的地方，别归零也别补满
  } else {
    const proposed = Number.isFinite(patch.progress)
      ? clamp01(patch.progress)
      : progressFromSteps(next.steps);
    next.progress = pickForward(base.progress, proposed);
  }

  return normalizeCard(next, { id: next.id });
}

function pickForward(current, proposed) {
  if (!Number.isFinite(proposed)) return current;
  if (!Number.isFinite(current)) return proposed;
  return Math.max(current, proposed);
}

// ---------------------------------------------------------------------------
// 运行中该说什么。这句话是这张卡在等待期间唯一有信息量的东西，
// 所以宁可具体到「读窗口里的文字」，也不要「正在处理」。
// ---------------------------------------------------------------------------
const RUNNING_HINT = Object.freeze({
  image: '正在出图',
  proposal: '正在想该怎么改',
  diff: '正在算改动',
  table: '正在对比',
  calendar: '正在读时间',
  prompt: '正在写提示词',
  metric: '正在算',
  facts: '正在核对',
  steps: '正在做',
  prose: '正在想',
});

function runningLabel(card = {}) {
  if (card.stage) return card.stage;
  const last = [...(card.steps || [])].reverse().find((s) => s && s.label);
  if (last) return last.label;
  return RUNNING_HINT[normalizeKind(card.kind)] || '正在处理';
}

// 一张卡还能不能接补丁。渲染层用它决定要不要继续跑计时器。
function isSettled(card = {}) {
  return card.state === 'done' || card.state === 'failed';
}

const CardModel = {
  KINDS,
  STATES,
  LEGACY_KIND,
  PHASE_TEXT,
  TYPICAL_PHASES,
  normalizeKind,
  normalizeCard,
  applyPatch,
  phaseStep,
  progressFromSteps,
  runningLabel,
  isSettled,
};

// 主进程 require 它，渲染层当 classic script 加载它——同一份契约，两种加载方式。
// 少了这个双出口，主进程和界面就会各自维护一份「什么算一张卡」，
// 那正是三个界面长得不一样的起点。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CardModel;
} else if (typeof globalThis !== 'undefined') {
  globalThis.CardModel = CardModel;
}
