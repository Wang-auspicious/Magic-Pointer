const commandInput = document.getElementById('command');
const runButton = document.getElementById('run');
const result = document.getElementById('result');
const inlineRail = document.getElementById('inline-action-rail');
const railStateIcon = document.getElementById('rail-state-icon');
const primaryIntentButton = document.getElementById('primary-intent');
const commandRow = document.getElementById('command-row');

let currentActionProposals = [];
let currentSelectionSessionToken = null;
let currentPanelLayoutNonce = null;
let currentPrimaryCommand = null;
let submitting = false;

function computeRailWidth(text) {
  const content = String(text || '');
  const textWidth = Array.from(content).reduce((width, character) => (
    width + (character.codePointAt(0) > 0x7f ? 14 : 8)
  ), 0);
  return Math.max(88, Math.min(360, Math.round(68 + textWidth)));
}

function syncPanelSize() {
  const selectionSessionToken = currentSelectionSessionToken;
  const layoutNonce = currentPanelLayoutNonce;
  requestAnimationFrame(() => {
    if (
      !selectionSessionToken
      || !layoutNonce
      || selectionSessionToken !== currentSelectionSessionToken
      || layoutNonce !== currentPanelLayoutNonce
    ) return;
    const primaryIntent = primaryIntentButton.hidden
      ? (commandInput.value || commandInput.placeholder)
      : primaryIntentButton.textContent;
    window.magicPointerPanel?.resize({
      width: computeRailWidth(primaryIntent),
      height: 44,
      selectionSessionToken,
      layoutNonce,
    });
  });
}

function setRailState(state, label = null) {
  const nextState = ['ready', 'input', 'running', 'success', 'error'].includes(state) ? state : 'ready';
  inlineRail.dataset.state = nextState;
  railStateIcon.textContent = {
    ready: '✦',
    input: '✦',
    running: '…',
    success: '✓',
    error: '!',
  }[nextState];
  if (label !== null) {
    primaryIntentButton.textContent = String(label);
    primaryIntentButton.hidden = false;
    commandRow.hidden = true;
  }
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
  currentActionProposals = Array.isArray(payload.actionProposals) ? payload.actionProposals.slice(0, 5) : [];
  if (payload.ok === null) {
    result.hidden = true;
    setRailState('running', payload.status || '正在处理…');
    return;
  }
  if (payload.ok) {
    const answer = String(payload.answer || '').slice(0, 2600);
    const proposalHtml = renderActionProposals(currentActionProposals);
    const needsSecondaryReader = Boolean(proposalHtml) || answer.length > 42 || /\r?\n/.test(answer);
    if (needsSecondaryReader) {
      result.hidden = true;
      result.innerHTML = '';
      window.magicPointerPanel?.openSecondaryResult({
        ...payload,
        answer,
        actionProposals: currentActionProposals,
        selectionSessionToken: currentSelectionSessionToken,
      });
      setRailState('success', proposalHtml ? '查看结果并确认' : '结果已在侧边打开');
      return;
    }
    result.hidden = true;
    setRailState('success', answer.split(/\r?\n/, 1)[0].slice(0, 42) || '完成');
  } else {
    currentActionProposals = [];
    result.hidden = true;
    setRailState('error', payload.error || '未能完成当前操作');
  }
  syncPanelSize();
}

function submitCommand(commandOverride = null) {
  if (submitting) return;
  const command = String(commandOverride || commandInput.value).trim();
  if (!command || !currentSelectionSessionToken) return;
  commandInput.value = command;
  submitting = true;
  showResult({ ok: null, status: '正在处理…' });
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

function renderPrimaryIntent(summary, suggestedCommands = []) {
  const safeSummary = summary && typeof summary === 'object' ? summary : {};
  const commands = safeSummary.hasContent === true ? suggestedCommands.slice(0, 1) : [];
  const primary = commands[0] || null;
  currentPrimaryCommand = primary?.command || null;
  if (currentPrimaryCommand) {
    primaryIntentButton.textContent = primary.label || primary.command;
    primaryIntentButton.hidden = false;
    commandRow.hidden = true;
  } else {
    primaryIntentButton.hidden = true;
    commandRow.hidden = false;
  }
  setRailState('ready');
}

runButton.addEventListener('click', () => submitCommand());
commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitCommand();
  }
});
commandInput.addEventListener('input', () => {
  setRailState('input');
});
primaryIntentButton.addEventListener('click', () => {
  if (currentPrimaryCommand) submitCommand(currentPrimaryCommand);
});
result.addEventListener('click', (e) => {
  const actionButton = e.target.closest('[data-action-index]');
  if (!actionButton) return;
  e.preventDefault();
  executeActionProposal(Number(actionButton.dataset.actionIndex));
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.magicPointerPanel?.hide();
});
window.magicPointerPanel?.onShow((payload = {}) => {
  submitting = false;
  currentSelectionSessionToken = payload.selectionSessionToken || null;
  currentPanelLayoutNonce = payload.panelLayoutNonce || null;
  currentActionProposals = [];
  currentPrimaryCommand = null;
  commandInput.value = '';
  result.hidden = true;
  result.innerHTML = '';
  renderPrimaryIntent(payload.captureSummary, payload.suggestedCommands || []);
  syncPanelSize();
});
window.magicPointerPanel?.onHide(() => {
  currentSelectionSessionToken = null;
  currentPanelLayoutNonce = null;
  currentActionProposals = [];
  currentPrimaryCommand = null;
  submitting = false;
});
window.magicPointerPanel?.onResult(showResult);
