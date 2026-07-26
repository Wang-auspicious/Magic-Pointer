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

function stageEventFromBridge(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { type: 'ERROR', error: { message: '未收到可用结果。' } };
  }
  const actions = proposalActions(parsed);
  if (parsed.ok === false && actions.length === 0) {
    return {
      type: 'ERROR',
      error: { message: String(parsed.error || parsed.answer || '执行失败。') },
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
      answer: String(parsed.answer || parsed.status || '已处理。'),
      detail: String(parsed.detail || parsed.error || ''),
      ...receipt,
      actions,
    },
  };
}

module.exports = {
  commandForChip,
  inferObjectKind,
  selectionSourceForReason,
  stageEventFromBridge,
};
