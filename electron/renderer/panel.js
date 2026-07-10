const commandInput = document.getElementById('command');
const runButton = document.getElementById('run');
const closeButton = document.getElementById('close');
const result = document.getElementById('result');
const capture = document.getElementById('capture');
const captureLabel = document.getElementById('capture-label');
const captureDetail = document.getElementById('capture-detail');
const captureExcerpt = document.getElementById('capture-excerpt');
const suggestions = document.getElementById('suggestions');
const inputRow = document.querySelector('.panel-input-row');

let currentActionProposals = [];
let currentSelectionSessionToken = null;
let submitting = false;

function syncPanelSize() {
  requestAnimationFrame(() => {
    const resultHeight = result.hidden ? 0 : Math.min(result.scrollHeight + 8, 224);
    const contentHeight = 54
      + capture.scrollHeight
      + suggestions.scrollHeight
      + inputRow.scrollHeight
      + resultHeight;
    window.magicPointerPanel?.resize({ height: Math.max(188, Math.min(380, contentHeight)) });
  });
}

function resizeCommandInput() {
  commandInput.style.height = '42px';
  commandInput.style.height = `${Math.min(72, Math.max(42, commandInput.scrollHeight))}px`;
  syncPanelSize();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderSafeMarkdown(value) {
  const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let inList = false;

  lines.forEach((line, index) => {
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${renderSafeMarkdownInline(listMatch[1])}</li>`;
      return;
    }
    if (inList) {
      html += '</ul>';
      inList = false;
    }
    if (line.length > 0) html += renderSafeMarkdownInline(line);
    if (index < lines.length - 1) html += '<br>';
  });

  if (inList) html += '</ul>';
  return html;
}

function renderSafeMarkdownInline(text, options = {}) {
  const allowBold = options.allowBold !== false;
  let html = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        html += `<code>${escapeHtml(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (allowBold && text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end !== -1 && end > i + 2) {
        html += `<strong>${renderSafeMarkdownInline(text.slice(i + 2, end), { allowBold: false })}</strong>`;
        i = end + 2;
        continue;
      }
    }
    html += escapeHtml(text[i]);
    i += 1;
  }
  return html;
}

function actionProposalLabel(proposal) {
  switch (proposal?.action_type) {
    case 'copy_text_to_clipboard':
      return '复制路径';
    case 'office_replace_selection':
      return '替换当前选区';
    case 'office_undo_last_action':
      return '恢复上次修改';
    default:
      return String(proposal?.action_type || 'run action').replaceAll('_', ' ');
  }
}

function renderActionPreview(proposal) {
  const params = proposal?.parameters || {};
  if (proposal?.action_type === 'office_replace_selection') {
    const document = params.document || proposal?.target?.description || 'Word document';
    const before = params.expected_text_excerpt || '';
    const after = params.replacement_text_excerpt || '';
    return [
      '<div class="action-preview danger">',
      '<div class="action-preview-title">Word write preview</div>',
      `<div><strong>Document:</strong> ${escapeHtml(document)}</div>`,
      `<div><strong>Before:</strong><pre>${escapeHtml(before)}</pre></div>`,
      `<div><strong>After:</strong><pre>${escapeHtml(after)}</pre></div>`,
      '<div class="muted">Will re-check the active Word document, range, and original text hash before writing.</div>',
      '</div>',
    ].join('');
  }
  if (proposal?.action_type === 'office_undo_last_action') {
    const document = params.document || proposal?.target?.description || 'Word document';
    return [
      '<div class="action-preview warning">',
      '<div class="action-preview-title">Precise Magic Pointer restore</div>',
      `<div><strong>Document:</strong> ${escapeHtml(document)}</div>`,
      '<div class="muted">Restores this Magic Pointer edit from local history; it does not press Ctrl+Z.</div>',
      '</div>',
    ].join('');
  }
  return '';
}

function renderActionProposals(proposals) {
  const executable = proposals.filter((proposal) => typeof proposal?.action_token === 'string' && proposal.action_token.length > 0);
  if (!executable.length) return '';
  const previews = executable.map((proposal) => renderActionPreview(proposal)).join('');
  const buttons = executable.map((proposal, index) => {
    const label = actionProposalLabel(proposal);
    const confirm = proposal.confirmation_required === true ? '确认' : '';
    return `<button class="action-chip" type="button" data-action-index="${index}">${escapeHtml(confirm + label)}</button>`;
  }).join('');
  return `${previews}<div class="actions">${buttons}</div>`;
}

function showResult(payload) {
  submitting = false;
  if (!payload) return;
  if (
    payload.selectionSessionToken
    && currentSelectionSessionToken
    && payload.selectionSessionToken !== currentSelectionSessionToken
  ) return;
  result.hidden = false;
  currentActionProposals = Array.isArray(payload.actionProposals) ? payload.actionProposals.slice(0, 5) : [];
  if (payload.ok === null) {
    result.innerHTML = `<div class="title">处理中</div><div class="muted">${escapeHtml(payload.status || '正在处理 THIS…')}</div>`;
    syncPanelSize();
    return;
  }
  if (payload.ok) {
    const answer = String(payload.answer || '').slice(0, 2600);
    result.innerHTML = `<div class="title">${escapeHtml(payload.prompt || 'Result')}</div><div>${renderSafeMarkdown(answer)}</div>${renderActionProposals(currentActionProposals)}`;
  } else {
    currentActionProposals = [];
    result.innerHTML = `<div class="title">未完成</div><div class="muted">${escapeHtml(payload.error || '未能完成当前操作')}</div>`;
  }
  syncPanelSize();
}

function submitCommand(commandOverride = null) {
  if (submitting) return;
  const command = String(commandOverride || commandInput.value).trim();
  if (!command || !currentSelectionSessionToken) return;
  commandInput.value = command;
  resizeCommandInput();
  submitting = true;
  showResult({ ok: null, status: '正在处理 THIS…' });
  window.magicPointerPanel?.submitSelectionCommand({
    command,
    selectionSessionToken: currentSelectionSessionToken,
  });
}

function executeActionProposal(index) {
  const proposal = currentActionProposals[index];
  if (!proposal || typeof proposal.action_token !== 'string') return;
  const actionToken = proposal.action_token;
  currentActionProposals = [];
  showResult({ ok: null, status: '正在校验并执行…' });
  window.magicPointerPanel?.executeAction({
    actionToken,
    proposalId: proposal.id,
    confirmed: true,
    selectionSessionToken: currentSelectionSessionToken,
  });
}

function renderCaptureSummary(summary, suggestedCommands = []) {
  const safeSummary = summary && typeof summary === 'object' ? summary : {};
  captureLabel.textContent = safeSummary.label || 'THIS 暂不可用';
  captureDetail.textContent = safeSummary.detail || '';
  captureExcerpt.textContent = safeSummary.excerpt || '';
  captureExcerpt.hidden = !safeSummary.excerpt;

  const commands = suggestedCommands.slice(0, 4);
  suggestions.innerHTML = commands.map((item, index) => (
    `<button type="button" class="suggestion-chip" data-suggestion-index="${index}">${escapeHtml(item.label || item.command || '')}</button>`
  )).join('');
  suggestions.hidden = commands.length === 0;
  suggestions.dataset.commands = JSON.stringify(commands);
  syncPanelSize();
}

runButton.addEventListener('click', () => submitCommand());
closeButton.addEventListener('click', () => window.magicPointerPanel?.hide());
commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitCommand();
  }
});
commandInput.addEventListener('input', resizeCommandInput);
result.addEventListener('click', (e) => {
  const actionButton = e.target.closest('[data-action-index]');
  if (!actionButton) return;
  e.preventDefault();
  executeActionProposal(Number(actionButton.dataset.actionIndex));
});
suggestions.addEventListener('click', (e) => {
  const button = e.target.closest('[data-suggestion-index]');
  if (!button) return;
  let commands = [];
  try { commands = JSON.parse(suggestions.dataset.commands || '[]'); } catch (_) {}
  const item = commands[Number(button.dataset.suggestionIndex)];
  if (!item?.command) return;
  submitCommand(item.command);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.magicPointerPanel?.hide();
});
window.magicPointerPanel?.onShow((payload = {}) => {
  submitting = false;
  currentSelectionSessionToken = payload.selectionSessionToken || null;
  currentActionProposals = [];
  result.hidden = true;
  result.innerHTML = '';
  renderCaptureSummary(payload.captureSummary, payload.suggestedCommands || []);
  window.magicPointerPanel?.resize({ height: 188 });
  resizeCommandInput();
  if (payload.focusInput !== false) {
    commandInput.focus();
    commandInput.select();
  }
});
window.magicPointerPanel?.onHide(() => {
  currentSelectionSessionToken = null;
  currentActionProposals = [];
  submitting = false;
});
window.magicPointerPanel?.onResult(showResult);
