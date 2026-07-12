const titleNode = document.getElementById('reader-title');
const contextNode = document.getElementById('reader-context');
const contentNode = document.getElementById('reader-content');
const actionsNode = document.getElementById('reader-actions');
const closeButton = document.getElementById('reader-close');

let currentActionProposals = [];
let currentSelectionSessionToken = '';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderSafeMarkdown(value) {
  let html = escapeHtml(value).replace(/\r\n?/g, '\n');
  const codeBlocks = [];
  html = html.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_match, code) => {
    const index = codeBlocks.push(`<pre><code>${code.trimEnd()}</code></pre>`) - 1;
    return `@@CODE_BLOCK_${index}@@`;
  });
  html = html
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(?:<li>.*<\/li>\n?)+/g, (list) => `<ul>${list}</ul>`)
    .split(/\n{2,}/)
    .map((block) => block.startsWith('<h') || block.startsWith('<ul>') || block.startsWith('@@CODE_BLOCK_') ? block : `<p>${block.replaceAll('\n', '<br>')}</p>`)
    .join('');
  return html.replace(/@@CODE_BLOCK_(\d+)@@/g, (_match, index) => codeBlocks[Number(index)] || '');
}

function proposalPreview(proposal) {
  const preview = proposal?.preview || {};
  const parameters = proposal?.parameters || {};
  if (preview.before || preview.after) return `${preview.before || ''}\n→\n${preview.after || ''}`.trim();
  if (preview.destination) return `目标：${preview.destination}`;
  if (preview.text) return preview.text;
  if (parameters.expected_text_excerpt || parameters.replacement_text_excerpt) {
    return `${parameters.expected_text_excerpt || ''}\n→\n${parameters.replacement_text_excerpt || ''}`.trim();
  }
  if (parameters.destination) return `目标：${parameters.destination}`;
  return '执行前会再次校验当前选区与目标窗口。';
}

function proposalLabel(proposal) {
  if (proposal?.label) return proposal.label;
  if (proposal?.action_type === 'office_replace_selection') return '替换当前选区';
  if (proposal?.action_type === 'office_undo_last_action') return '恢复上次修改';
  if (proposal?.action_type === 'copy_text_to_clipboard') return '复制路径';
  return String(proposal?.action_type || proposal?.type || '待确认操作').replaceAll('_', ' ');
}

function renderProposals(proposals) {
  currentActionProposals = Array.isArray(proposals) ? proposals : [];
  actionsNode.replaceChildren();
  actionsNode.hidden = currentActionProposals.length === 0;
  currentActionProposals.forEach((proposal, index) => {
    const card = document.createElement('section');
    card.className = 'proposal-card';
    card.innerHTML = `<div class="proposal-title">${escapeHtml(proposalLabel(proposal))}</div><div class="proposal-preview">${escapeHtml(proposalPreview(proposal))}</div>`;
    contentNode.appendChild(card);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reader-action';
    button.dataset.actionIndex = String(index);
    button.textContent = proposal.confirmLabel || `确认${proposalLabel(proposal)}`;
    actionsNode.appendChild(button);
  });
}

function renderPayload(payload = {}) {
  currentSelectionSessionToken = payload.selectionSessionToken || currentSelectionSessionToken;
  titleNode.textContent = payload.title || payload.primaryIntent || '处理结果';
  contextNode.textContent = payload.sourceApp || payload.prompt || '';

  if (payload.ok === false) {
    contentNode.innerHTML = `<p class="reader-error">${escapeHtml(payload.error || '处理失败，请重试。')}</p>`;
    renderProposals([]);
    return;
  }
  if (payload.ok === null) {
    contentNode.innerHTML = '<p class="reader-empty">正在处理并校验当前上下文…</p>';
    renderProposals([]);
    return;
  }

  const answer = payload.answer || payload.message || '';
  contentNode.innerHTML = answer ? renderSafeMarkdown(answer) : '<p class="reader-empty">结果已生成，请确认下一步操作。</p>';
  renderProposals(payload.actionProposals);
  contentNode.scrollTop = 0;
}

actionsNode.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action-index]');
  if (!button) return;
  const proposal = currentActionProposals[Number(button.dataset.actionIndex)];
  if (!proposal) return;
  for (const actionButton of actionsNode.querySelectorAll('button')) actionButton.disabled = true;
  button.textContent = '正在校验并执行…';
  window.magicPointerReader?.executeAction({
    selectionSessionToken: currentSelectionSessionToken,
    actionToken: proposal.actionToken || proposal.action_token,
    proposalId: proposal.proposalId || proposal.id,
    confirmed: true,
  });
});

closeButton.addEventListener('click', () => window.magicPointerReader?.hide());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.magicPointerReader?.hide();
});

window.magicPointerReader?.onShow((payload) => renderPayload(payload));
window.magicPointerReader?.onHide(() => {
  currentActionProposals = [];
  currentSelectionSessionToken = '';
});
window.magicPointerReader?.onResult((payload) => {
  if (payload.selectionSessionToken && currentSelectionSessionToken && payload.selectionSessionToken !== currentSelectionSessionToken) return;
  renderPayload(payload);
});
