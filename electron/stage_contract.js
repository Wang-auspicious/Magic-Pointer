// Pure contract between Electron main and PointerStage.
// It deliberately strips bridge payloads down to render-safe fields and action
// tokens; raw screenshots, native handles, prompts, and proposal parameters do
// not cross into the renderer.

const CHIP_COMMANDS = Object.freeze({
  rewrite: '改写这段文字',
  translate: '把这段文字翻译成中文',
  summarize: '总结这段文字',
  compare: '对比这个和上一个对象',
  tidy: '整理这个对象',
  'add-to-calendar': '添加到日历',
});

const ACTION_LABELS = Object.freeze({
  copy_text_to_clipboard: '确认复制',
  office_replace_selection: '确认替换',
  office_undo_last_action: '撤回本次修改',
  shopping_list_add: '加入购物清单',
  shopping_list_set_checked: '更新清单',
  shopping_list_undo_add: '撤回添加',
  calendar_event_create: '确认创建日程',
  calendar_event_undo_create: '撤回日程',
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

function commandForChip(chipId) {
  return CHIP_COMMANDS[String(chipId || '')] || null;
}

function selectionSourceForReason(reason) {
  const value = String(reason || '').toLowerCase();
  return value.includes('click') ? 'click' : value.includes('wiggle') ? 'wiggle' : value || null;
}

function inferObjectKind(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const sourceKind = String(snapshot.source_kind || '').toLowerCase();
  if (/(visual|image|screenshot|region)/.test(sourceKind)) return 'image';
  const context = snapshot.context && typeof snapshot.context === 'object' ? snapshot.context : {};
  const content = String(context.content || '').trim();
  if (!content) return null;
  if (
    /(?:20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日)/.test(content)
    || /(?:上午|下午|晚上)?\s*\d{1,2}\s*(?::|：|点)\s*\d{0,2}/.test(content)
  ) return 'date';
  return 'text';
}

function proposalActions(parsed) {
  const proposals = Array.isArray(parsed?.actionProposals) ? parsed.actionProposals : [];
  return proposals.slice(0, 3).flatMap((proposal) => {
    if (!proposal || typeof proposal !== 'object') return [];
    const actionToken = String(proposal.action_token || '');
    const id = String(proposal.id || '');
    if (!actionToken || !id) return [];
    const actionType = String(proposal.action_type || '');
    return [{
      kind: 'proposal',
      id,
      actionToken,
      label: ACTION_LABELS[actionType] || (proposal.confirmation_required ? '确认执行' : '执行'),
      confirmationRequired: proposal.confirmation_required === true,
    }];
  });
}

function executionReceipt(parsed) {
  const execution = parsed?.executionResult && typeof parsed.executionResult === 'object'
    ? parsed.executionResult : {};
  const output = execution.output && typeof execution.output === 'object' ? execution.output : {};
  const fabricReceipt = output.fabric_receipt && typeof output.fabric_receipt === 'object'
    ? output.fabric_receipt : {};
  const task = fabricReceipt.output && typeof fabricReceipt.output === 'object'
    ? fabricReceipt.output : {};
  const executionStatus = String(execution.status || '');
  const rawStatus = String(fabricReceipt.status || (
    executionStatus === 'pending' ? 'accepted' : executionStatus
  ));
  const status = rawStatus || null;
  const verified = fabricReceipt.verified === true || output.verified === true;
  return {
    status,
    statusLabel: status ? (STATUS_LABELS[status] || status) : '',
    verified,
    taskId: String(task.taskId || ''),
    provider: String(task.provider || fabricReceipt.provider || ''),
  };
}

function calendarResult(parsed, actions) {
  const draft = parsed.calendarDraft && typeof parsed.calendarDraft === 'object'
    ? parsed.calendarDraft : {};
  const event = draft.event && typeof draft.event === 'object' ? draft.event : {};
  const warnings = Array.isArray(draft.warnings) ? draft.warnings.map(String).filter(Boolean) : [];
  return {
    kind: 'calendar-draft',
    title: String(event.title || draft.title || '未命名日程'),
    start: String(event.start_at || [
      draft.date,
      draft.start_time,
    ].filter(Boolean).join(' ')),
    end: String(event.end_at || [
      draft.date,
      draft.end_time,
    ].filter(Boolean).join(' ')),
    location: String(event.location || draft.location || ''),
    conflict: warnings.join('；'),
    status: 'draft',
    statusLabel: '草稿，尚未创建',
    actions: [{
      kind: 'context',
      id: 'open-calendar-draft',
      label: '审核并创建',
    }, ...actions].slice(0, 3),
  };
}

function routeResult(parsed, actions) {
  const route = parsed.routeDraft && typeof parsed.routeDraft === 'object' ? parsed.routeDraft : {};
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

function textDraftResult(parsed, proposal, actions, receipt) {
  const parameters = proposal.parameters && typeof proposal.parameters === 'object'
    ? proposal.parameters : {};
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

// Every user-facing string in the bubble is written for a person. Bridge error
// codes are for the log; the acceptance run put `bridge_timeout` on screen and
// the user had no idea what had happened or what to do next. This is the one
// place a code becomes a sentence, so no surface can leak a raw identifier.
const ERROR_MESSAGES = Object.freeze({
  bridge_timeout: '这次处理超时了，没有改动任何东西。请再试一次，或换一个更小的选区。',
  bridge_cancelled: '这次处理被取消了，没有改动任何东西。',
  bridge_spawn_error: '本地处理进程没能启动。请重启 Magic Pointer 再试。',
  bridge_stdin_error: '本地处理进程中断了，没有改动任何东西。请再试一次。',
  bridge_invalid_json: '本地处理返回了看不懂的结果，已停下没有继续。请再试一次。',
  bridge_output_limit: '结果太大了，为了不卡住已经停下。请缩小选区再试。',
  payload_too_large: '这次选中的内容太大了。请缩小范围再试。',
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
  invalid_voice_session: '这次语音会话已经结束了，请重新按住说话。',
  voice_runtime_unavailable: '语音引擎没能启动。可以先用键盘输入，或到「语音」里检查设置。',
  voice_runtime_unconfigured: '还没有配置语音引擎。请到「语音」里选一个。',
  voice_worker_unavailable: '语音进程不在了，已切回键盘输入。',
  voice_worker_busy: '上一次语音还在处理，请稍等一下再说。',
  voice_worker_start_failed: '语音进程没能启动，已切回键盘输入。',
  voice_session_active: '已经在录音了。',
  legacy_voice_unavailable: '系统听写不可用，已切回键盘输入。',
  legacy_voice_start_failed: '系统听写没能启动，已切回键盘输入。',
  tool_not_implemented: '这项能力还没接通，没有执行任何动作。',
  multi_tool_plan_not_supported: '这次请求需要多步组合，当前还没接通，没有执行任何动作。',
  runtime_empty_response: '模型没有返回内容，没有改动任何东西。',
  invalid_plan: '这一步的计划校验没通过，已停下没有执行。',
  invalid_plan_signature: '这一步的计划签名对不上，已停下没有执行。',
  invalid_model_plan: '模型给出的计划不合法，已停下没有执行。',
});

// A code looks like a code: lowercase words joined by underscores, no spaces.
// Anything else is already a sentence somebody wrote on purpose.
const CODE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function humanErrorMessage(raw, fallback = '这次没能完成，也没有改动任何东西。') {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return fallback;
  if (ERROR_MESSAGES[value]) return ERROR_MESSAGES[value];
  if (CODE_SHAPE.test(value)) {
    // An unmapped code still must not reach the bubble as-is. Say the honest
    // thing and keep the identifier for the log only.
    return fallback;
  }
  return value;
}

function stageEventFromBridge(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { type: 'ERROR', error: { message: '未收到可用结果。' } };
  }
  const actions = proposalActions(parsed);
  if (parsed.ok === false && actions.length === 0) {
    return {
      type: 'ERROR',
      error: {
        message: humanErrorMessage(parsed.error, humanErrorMessage(parsed.answer, '这次没能完成，也没有改动任何东西。')),
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
  if (parsed.intentKind === 'calendar_event_draft' && parsed.calendarDraft) {
    return { type: 'RESULT', result: calendarResult(parsed, actions) };
  }
  if (parsed.intentKind === 'route_draft' && parsed.routeDraft) {
    return { type: 'RESULT', result: routeResult(parsed, actions) };
  }
  const replaceProposal = (Array.isArray(parsed.actionProposals) ? parsed.actionProposals : [])
    .find((proposal) => proposal?.action_type === 'office_replace_selection');
  const receipt = executionReceipt(parsed);
  if (parsed.ok === true && receipt.status === 'succeeded' && receipt.verified) {
    return {
      type: 'COMPLETE',
      outcome: { status: receipt.status, verified: true },
    };
  }
  if (replaceProposal) {
    return {
      type: 'RESULT',
      result: textDraftResult(parsed, replaceProposal, actions, receipt),
    };
  }
  return {
    type: 'RESULT',
    result: {
      kind: 'inline',
      presentation: 'answer-card',
      answer: String(parsed.answer || parsed.status || '已处理。'),
      detail: humanErrorMessage(parsed.detail || parsed.error, ''),
      ...receipt,
      actions,
    },
  };
}

module.exports = {
  commandForChip,
  humanErrorMessage,
  inferObjectKind,
  selectionSourceForReason,
  stageEventFromBridge,
};
