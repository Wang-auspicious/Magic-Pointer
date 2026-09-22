
const { captureProof, proofSummary } = require('./capture_proof_policy');

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : {};
}

function pendingInputFromBridge(value: unknown): UnknownRecord | null {
  const pending = recordOf(value);
  const question = String(pending.question || '').trim().slice(0, 1000);
  if (pending.kind === 'plan' && pending.plan) {
    return { kind: 'plan', question, tool: 'ExitPlanMode', plan: String(pending.plan).slice(0, 32000),
      requestId: String(pending.requestId || ''), options: pending.options };
  }
  if (pending.kind === 'permission' && String(pending.tool || '').trim()) {
    return { kind: 'permission', question, tool: String(pending.tool), prefix: String(pending.prefix || ''),
      requestId: String(pending.requestId || ''), actionPreview: String(pending.actionPreview || '') };
  }
  const options = Array.isArray(pending.options)
    ? pending.options.map(String).map((item) => item.trim().slice(0, 200)).filter(Boolean).slice(0, 4)
    : [];
  const questions = Array.isArray(pending.questions) ? pending.questions.slice(0, 4).map((value) => {
    const item = recordOf(value);
    return {
      question: String(item.question || '').slice(0, 1000),
      ...(item.header ? { header: String(item.header).slice(0, 100) } : {}),
      ...(typeof item.multiSelect === 'boolean' ? { multiSelect: item.multiSelect } : {}),
      options: (Array.isArray(item.options) ? item.options : []).slice(0, 4).map((value) => {
        const option = recordOf(value);
        return { label: String(option.label || '').slice(0, 200),
          ...(option.description ? { description: String(option.description).slice(0, 1000) } : {}),
          ...(option.preview ? { preview: String(option.preview).slice(0, 16000) } : {}) };
      }),
    };
  }) : undefined;
  return question && options.length >= 2 ? { question, options,
    ...(pending.requestId ? { requestId: String(pending.requestId) } : {}),
    ...(questions ? { questions } : {}) } : null;
}

function modelUsageFromBridge(value: unknown): UnknownRecord | null {
  const raw = recordOf(value);
  const usage: UnknownRecord = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'turnsReported', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const count = Number(raw[key]);
    if (Number.isFinite(count) && count >= 0) usage[key] = Math.floor(count);
  }
  return Object.keys(usage).length ? usage : null;
}

function ledgerFromBridge(value: unknown): UnknownRecord | null {
  const raw = recordOf(value);
  if (!Object.keys(raw).length) return null;
  const ledger: UnknownRecord = {};
  const turns = Number(raw.turns);
  if (Number.isFinite(turns) && turns >= 0) ledger.turns = Math.floor(turns);
  for (const key of ['tokensText', 'tokensVision'] as const) {
    const count = Number(raw[key]);
    if (Number.isFinite(count) && count >= 0) ledger[key] = Math.floor(count);
  }
  if (typeof raw.succeeded === 'boolean') ledger.succeeded = raw.succeeded;
  if (raw.failureType !== undefined) ledger.failureType = raw.failureType;
  return Object.keys(ledger).length ? ledger : null;
}

const CHIP_COMMANDS = Object.freeze({
  rewrite: '改写这段文字',
  translate: '把这段文字翻译成中文',
  summarize: '总结这段文字',
  compare: '对比这个和上一个对象',
  tidy: '整理这个对象',
});

const ACTION_LABELS = Object.freeze({
  copy_text_to_clipboard: '确认复制',
  office_replace_selection: '确认替换',
  office_undo_last_action: '撤回本次修改',
  paste_text_to_foreground: '填入草稿',
  fabric_recipe_execute: '确认执行',
});

const STATUS_LABELS = Object.freeze({
  accepted: '已受理，排队中',
  succeeded: '已执行并验证',
  failed: '执行失败',
  skipped: '尚未执行',
  verification_failed: '验证未通过',
  confirmation_required: '等待确认',
});

function commandForChip(chipId: unknown): string | null {
  return (CHIP_COMMANDS as Readonly<Record<string, string>>)[String(chipId || '')] || null;
}

function selectionSourceForReason(reason: unknown): string | null {
  const value = String(reason || '').toLowerCase();
  return value.includes('click') ? 'click' : value.includes('wiggle') ? 'wiggle' : value || null;
}

function inferObjectKind(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const snapshotRecord = recordOf(snapshot);
  const sourceKind = String(snapshotRecord.source_kind || '').toLowerCase();
  if (/(visual|image|screenshot|region)/.test(sourceKind)) return 'image';
  const context = recordOf(snapshotRecord.context);
  const content = String(context.content || '').trim();
  if (!content) return null;
  if (
    /(?:20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日)/.test(content)
    || /(?:上午|下午|晚上)?\s*\d{1,2}\s*(?::|：|点)\s*\d{0,2}/.test(content)
  ) return 'date';
  return 'text';
}

function proposalActions(parsed: UnknownRecord): UnknownRecord[] {
  const proposals = Array.isArray(parsed?.actionProposals) ? parsed.actionProposals : [];
  return proposals.slice(0, 3).flatMap((proposal): UnknownRecord[] => {
    if (!proposal || typeof proposal !== 'object') return [];
    const proposalRecord = recordOf(proposal);
    const actionToken = String(proposalRecord.action_token || '');
    const id = String(proposalRecord.id || '');
    if (!actionToken || !id) return [];
    const actionType = String(proposalRecord.action_type || '');
    return [{
      kind: 'proposal',
      id,
      actionToken,
      label: (ACTION_LABELS as Readonly<Record<string, string>>)[actionType]
        || (proposalRecord.confirmation_required ? '确认执行' : '执行'),
      confirmationRequired: proposalRecord.confirmation_required === true,
    }];
  });
}

function executionReceipt(parsed: UnknownRecord) {
  const execution = recordOf(parsed.executionResult);
  const output = recordOf(execution.output);
  const fabricReceipt = recordOf(output.fabric_receipt);
  const task = recordOf(fabricReceipt.output);
  const executionStatus = String(execution.status || '');
  const rawStatus = String(fabricReceipt.status || (
    executionStatus === 'pending' ? 'accepted' : executionStatus
  ));
  const status = rawStatus || null;
  const verified = fabricReceipt.verified === true || output.verified === true;
  return {
    status,
    statusLabel: status ? ((STATUS_LABELS as Readonly<Record<string, string>>)[status] || status) : '',
    verified,
    taskId: String(task.taskId || ''),
    provider: String(task.provider || fabricReceipt.provider || ''),
  };
}

function routeResult(parsed: UnknownRecord, actions: UnknownRecord[]) {
  const route = recordOf(parsed.routeDraft);
  const origin = String(route.origin || '');
  const destination = String(route.destination || '');
  return {
    kind: 'inline',
    answer: origin && destination ? `${origin} → ${destination}` : String(parsed.answer || '路线信息不完整。'),
    detail: '路线草稿，尚未打开外部地图。',
    status: 'draft',
    statusLabel: '草稿',
    actions: [{
      kind: 'context',
      id: 'open-route-draft',
      label: '用 Google 地图打开',
    }, ...actions].slice(0, 3),
  };
}

function textDraftResult(
  parsed: UnknownRecord,
  proposal: UnknownRecord,
  actions: UnknownRecord[],
  receipt: UnknownRecord,
) {
  const parameters = recordOf(proposal.parameters);
  return {
    kind: 'text-draft',
    title: '替换预览',
    original: String(parameters.expected_text_excerpt || ''),
    proposed: String(parameters.replacement_text_excerpt || ''),
    answer: String(parsed.answer || ''),
    ...receipt,
    actions,
  };
}

const ERROR_MESSAGES = Object.freeze({
  bridge_timeout: '这次处理超时停下了。已完成步骤的记录都保留在会话里；可以重试或换一个更小的范围。',
  bridge_cancelled: '这次处理已停下。已完成的部分都记录在会话里，不会再有新动作。',
  bridge_spawn_error: '本地处理进程没能启动，什么都没有执行。请重启 Magic Pointer 再试。',
  bridge_stdin_error: '本地处理进程中断了。已完成的部分记录在会话里；请再试一次。',
  bridge_invalid_json: '本地处理返回了看不懂的结果，已停下。已完成的部分记录在会话里。',
  bridge_output_limit: '结果太大了，为了不卡住已经停下。已完成的部分记录在会话里；请缩小选区再试。',
  payload_too_large: '这次请求在本地传递时超出了上限，已经停下，没有发出任何动作，也没有交给模型。请重试一次；如果反复出现，请保留这次的会话记录。',
  capture_missing: '没有拿到这块屏幕的画面，因此没有把任何内容交给模型。',
  capture_policy_denied: '当前隐私设置不允许截取这块内容，已停下。可在「隐私与权限」里调整。',
  structured_context_unavailable: '没能从这个窗口读到可靠的文字，已停下没有猜测内容。',
  no_frozen_object: '当前没有锁定的对象。请先划一下或指一下要处理的东西。',
  unknown_target_objects: '这次指到的对象已经过期了，请重新选择一次。',
  reference_label_binding_failed: '没能把这个引用绑到刚才的对象上，请重新选择一次。',
  confirmation_required: '这一步需要你确认后才会执行。',
  recipe_disabled: '这项能力当前在设置里是关闭状态，可在「能力库」里打开。',
  unknown_recipe: '没有找到对应的能力，已用通用方式回答。',
  model_profile_not_found: '还没有配置可用的模型。请在「模型与网络」里填好端点和密钥。',
  model_profile_disabled: '当前模型配置是关闭状态。请在「模型与网络」里启用。',
  credential_missing: '缺少模型密钥。请在「模型与网络」里补上。',
  model_gateway_unauthorized: '模型端点拒绝了这次请求（密钥无效）。请在「模型与网络」里更新密钥。',
  model_gateway_payment_required: '模型端点余额不足，所有需要模型的能力都会失败。请充值或换一个端点。',
  model_gateway_unreachable: '连不上模型端点。已用本地能力尽力回答。',
  agent_prompt_context_missing: '没能读到可交给 Agent 的上下文，因此没有生成任务。',
  agent_prompt_plan_failed: '没能把这次请求编成 Agent 任务，已停下没有发送。',
  agent_prompt_draft_expired: '这份草稿已经过期了，请重新选择一次。',
  agent_sessions_unavailable: '没有找到正在运行的 Agent 会话。',
  unauthorized_stage_sender: '这次请求来源不可信，已拒绝。',
  invalid_request_id: '这次结果已经过期了，请再试一次。',
  tool_not_implemented: '这项能力还没接通，没有执行任何动作。',
  multi_tool_plan_not_supported: '这次请求需要多步组合，当前还没接通，没有执行任何动作。',
  runtime_empty_response: '模型没有返回内容，没有改动任何东西。',
  invalid_plan: '这一步的计划校验没通过，已停下没有执行。',
  invalid_plan_signature: '这一步的计划签名对不上，已停下没有执行。',
  invalid_model_plan: '模型给出的计划不合法，已停下没有执行。',
});

const CODE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function humanErrorMessage(raw: unknown, fallback = '这次没能完成。已完成的部分记录在会话里。'): string {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return fallback;
  const messages = ERROR_MESSAGES as Readonly<Record<string, string>>;
  if (messages[value]) return messages[value];
  if (CODE_SHAPE.test(value)) {
    return fallback;
  }
  return value;
}

function captureProofFromBridge(value: unknown) {
  const parsed = recordOf(value);
  const selectionContext = recordOf(parsed.selectionContext);
  const artifacts = recordOf(selectionContext.artifacts);
  const geometryKind = String(artifacts.selection_geometry_kind || '');
  const structured = geometryKind === 'pointer_anchor'
    ? []
    : (Array.isArray(artifacts.selection_rectangles) ? artifacts.selection_rectangles : []);
  const captured = Array.isArray(artifacts.captured_rects) ? artifacts.captured_rects : [];
  const source = String(artifacts.captured_rects_source || 'pixel');
  return captureProof({
    structured,
    textRange: source === 'text_range' ? captured : [],
    pixel: source === 'pixel' ? captured : [],
  });
}

function stagePresentationFromBridge(value: unknown) {
  const parsed = recordOf(value);
  if (!value || typeof value !== 'object') {
    return { type: 'ERROR', error: { message: '未收到可用结果。' } };
  }
  const actions = proposalActions(parsed);
  if (parsed.ok === false && actions.length === 0) {
    return {
      type: 'ERROR',
      error: {
        message: humanErrorMessage(parsed.error, humanErrorMessage(parsed.answer, '这次没能完成。已完成的部分记录在会话里。')),
      },
    };
  }
  if (parsed.kind === 'agent-prompt-draft') {
    return {
      type: 'RESULT',
      result: {
        kind: 'agent-prompt-draft',
        prompt: String(parsed.contextPrompt || parsed.answer || '').slice(0, 60000),
        generatedBy: String(parsed.generatedBy || 'grounded_fallback'),
        modelError: String(parsed.modelError || ''),
      },
    };
  }
  if (parsed.intentKind === 'route_draft' && parsed.routeDraft) {
    return { type: 'RESULT', result: routeResult(parsed, actions) };
  }
  const replaceProposalValue = (Array.isArray(parsed.actionProposals) ? parsed.actionProposals : [])
    .find((proposal) => recordOf(proposal).action_type === 'office_replace_selection');
  const replaceProposal = recordOf(replaceProposalValue);
  const receipt = executionReceipt(parsed) as UnknownRecord & { status?: unknown; verified?: unknown };
  const proof = captureProofFromBridge(parsed);
  const screenPoints = (Array.isArray(parsed.screenPoints) ? parsed.screenPoints : [])
    .map(recordOf)
    .filter((point) => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)))
    .slice(0, 6)
    .map((point, index) => ({
      x: Math.round(Number(point.x)),
      y: Math.round(Number(point.y)),
      order: Number(point.order) || index + 1,
    }));
  const proofFields = {
    ...(proof.length ? { captureProof: proof, captureProofSummary: proofSummary(proof) } : {}),
    ...(screenPoints.length ? { screenPoints } : {}),
  };
  const pendingInput = pendingInputFromBridge(parsed.pendingInput);
  const awaitingUserInput = parsed.awaitingUserInput === true && pendingInput !== null;
  const modelUsage = modelUsageFromBridge(parsed.modelUsage);
  const ledger = ledgerFromBridge(parsed.interactionLedger);
  if (parsed.ok === true && receipt.status === 'succeeded' && receipt.verified) {
    return {
      type: 'COMPLETE',
      outcome: { status: receipt.status, verified: true },
      ...proofFields,
    };
  }
  if (replaceProposalValue) {
    return {
      type: 'RESULT',
      result: textDraftResult(parsed, replaceProposal, actions, receipt),
      ...proofFields,
    };
  }
  return {
    type: 'RESULT',
    result: {
      kind: 'inline',
      presentation: 'answer-card',
      answer: String(parsed.answer || parsed.status || '已处理。'),
      detail: humanErrorMessage(parsed.detail || parsed.error, ''),
      answerShape: String(parsed.answerShape || recordOf(parsed.route).answerShape || ''),
      awaitingUserInput,
      ...(pendingInput ? { pendingInput } : {}),
      ...(modelUsage ? { modelUsage } : {}),
      ...(ledger ? { ledger } : {}),
      ...receipt,
      actions,
    },
    ...proofFields,
  };
}

function stageEventFromBridge(value: unknown) {
  const event = stagePresentationFromBridge(value);
  const parsed = recordOf(value);
  const runtime: UnknownRecord = {};
  for (const key of [
    'answer', 'agentSessionId', 'hasPendingWork', 'thinking', 'trajectory',
    'activities', 'events', 'receipts', 'usedBackend', 'timingMs', 'taskContext',
  ]) {
    if (parsed[key] !== undefined) runtime[key] = parsed[key];
  }
  const usage = modelUsageFromBridge(parsed.modelUsage);
  if (usage) runtime.modelUsage = usage;
  const pendingInput = pendingInputFromBridge(parsed.pendingInput);
  if (pendingInput) runtime.pendingInput = pendingInput;
  return Object.keys(runtime).length
    ? { ...event, result: { ...recordOf('result' in event ? event.result : null), ...runtime } }
    : event;
}

module.exports = {
  captureProofFromBridge,
  commandForChip,
  humanErrorMessage,
  inferObjectKind,
  selectionSourceForReason,
  stageEventFromBridge,
};
