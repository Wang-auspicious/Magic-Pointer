function captureEligibility({ snapshot = null, summary = null } = {}) {
  const safeSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const safeSummary = summary && typeof summary === 'object' ? summary : {};
  const state = String(safeSummary.state || safeSnapshot.status || 'unsupported');
  const commandReady = (
    state === 'ready'
    && safeSnapshot.status === 'ready'
    && safeSummary.hasContent === true
  );
  if (commandReady) {
    return { commandReady: true, state: 'ready', message: '', autoDismissMs: null };
  }

  const title = String(safeSnapshot?.source_window?.title || safeSummary.label || '当前应用').trim();
  let message = `未能从「${title}」读取可靠选中内容`;
  if (/obsidian/i.test(title)) message = 'Obsidian PDF 暂不支持读取选中文字';
  else if (state === 'empty') message = `「${title}」中未检测到选中内容`;

  return { commandReady: false, state, message, autoDismissMs: 1800 };
}

module.exports = { captureEligibility };
