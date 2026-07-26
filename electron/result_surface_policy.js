function captureEligibility({ snapshot = null, summary = null, reason = '' } = {}) {
  const safeSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const safeSummary = summary && typeof summary === 'object' ? summary : {};
  const state = String(safeSummary.state || safeSnapshot.status || 'unsupported');
  const targetPoint = safeSnapshot.target_point;
  const targetHwnd = Number(safeSnapshot?.source_window?.hwnd);
  const targetPid = Number(safeSnapshot?.source_window?.process_id || safeSnapshot?.source_window?.pid);
  const contextTarget = safeSummary.hasActiveContext === true;
  const reviewTarget = safeSummary.hasActiveReview === true;
  const targetCoordinatesReady = Boolean(
    Number.isInteger(targetHwnd)
    && targetHwnd > 0
    && Number.isInteger(targetPid)
    && targetPid > 0
    && targetPoint
    && Number.isFinite(Number(targetPoint.x))
    && Number.isFinite(Number(targetPoint.y))
  );
  const runtimeDelivery = reason === 'runtime-delivery';
  const runtimeIssueTarget = Boolean(
    contextTarget && safeSummary.activeContextWorkflowKind === 'runtime_issue'
  );
  if (runtimeDelivery) {
    if (!runtimeIssueTarget) {
      return {
        commandReady: false,
        state: 'no-runtime-issue',
        message: '没有待交付的现场任务，请先按 Ctrl+Alt+M 圈出问题',
        autoDismissMs: 1800,
      };
    }
    if (targetCoordinatesReady) {
      return {
        commandReady: true,
        state: 'runtime-issue-target',
        message: '',
        autoDismissMs: null,
      };
    }
    return {
      commandReady: false,
      state: 'runtime-target-unavailable',
      message: '未能锁定 Agent 输入目标，请把鼠标放在输入框内重试',
      autoDismissMs: 1800,
    };
  }
  const deliveryTargetReady = Boolean(
    (contextTarget || reviewTarget) && targetCoordinatesReady
  );
  if (deliveryTargetReady) {
    return { commandReady: true, state: contextTarget ? 'context-target' : 'review-target', message: '', autoDismissMs: null };
  }
  const commandReady = (
    state === 'ready'
    && safeSnapshot.status === 'ready'
    && (safeSummary.hasContent === true || (
      safeSummary.hasVisual === true
      && safeSnapshot.source_kind === 'screen_region'
      && typeof safeSnapshot.capture_path === 'string'
      && safeSnapshot.capture_path.length > 0
    ))
  );
  if (commandReady) {
    return {
      commandReady: true,
      state: safeSummary.hasVisual === true ? 'visual-ready' : 'ready',
      message: '',
      autoDismissMs: null,
    };
  }

  const title = String(safeSnapshot?.source_window?.title || safeSummary.label || '当前应用').trim();
  let message = `未能从「${title}」读取可靠选中内容`;
  if (/obsidian/i.test(title)) message = 'Obsidian PDF 暂不支持读取选中文字';
  else if (state === 'empty') message = `「${title}」中未检测到选中内容`;

  return { commandReady: false, state, message, autoDismissMs: 1800 };
}

function normalizeResultPreference(value = 'inline') {
  return value === 'reader' ? 'reader' : 'inline';
}

function classifyResult(payload = {}, preference = 'inline') {
  if (payload.ok !== true) return 'inline-error';
  if (normalizeResultPreference(preference) === 'reader') return 'reader';
  const answer = String(payload.answer || '');
  const proposals = Array.isArray(payload.actionProposals) ? payload.actionProposals : [];
  const lineCount = answer ? answer.split(/\r?\n/).length : 0;
  if (proposals.length > 0 || answer.length > 280 || lineCount > 4) return 'expandable';
  return 'inline';
}

module.exports = { captureEligibility, classifyResult, normalizeResultPreference };
