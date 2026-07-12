const surface = document.getElementById('contextual-result');
const intentNode = document.getElementById('result-intent');
const sourceNode = document.getElementById('result-source');
const contentNode = document.getElementById('result-content');
const closeButton = document.getElementById('result-close');
const expandButton = document.getElementById('result-expand');

let currentPayload = null;
let currentSessionToken = '';
let autoDismissTimer = null;

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
    .map((block) => block.startsWith('<h') || block.startsWith('<ul>') || block.startsWith('@@CODE_BLOCK_')
      ? block
      : `<p>${block.replaceAll('\n', '<br>')}</p>`)
    .join('');
  return html.replace(/@@CODE_BLOCK_(\d+)@@/g, (_match, index) => codeBlocks[Number(index)] || '');
}

function clearAutoDismiss() {
  if (autoDismissTimer) window.clearTimeout(autoDismissTimer);
  autoDismissTimer = null;
}

function renderPayload(payload = {}) {
  clearAutoDismiss();
  currentPayload = payload;
  currentSessionToken = payload.selectionSessionToken || '';
  const mode = payload.resultMode || (payload.ok === false ? 'inline-error' : 'inline');
  surface.dataset.mode = mode;
  intentNode.textContent = payload.prompt || payload.primaryIntent || (mode === 'inline-error' ? '未能处理' : '结果');
  sourceNode.textContent = payload.sourceLabel || payload.sourceWindow?.title || payload.selectionContext?.label || '';
  const body = payload.ok === false ? payload.error : payload.answer;
  contentNode.innerHTML = renderSafeMarkdown(body || (mode === 'inline-error' ? '当前对象不可用。' : '已完成。'));
  const proposals = Array.isArray(payload.actionProposals) ? payload.actionProposals : [];
  expandButton.hidden = mode !== 'expandable';
  expandButton.textContent = proposals.length ? '查看并确认' : '展开';
  if (mode === 'inline-error') {
    autoDismissTimer = window.setTimeout(() => window.magicPointerResult?.hide(), 1800);
  }
  window.requestAnimationFrame(() => {
    window.magicPointerResult?.ready({
      selectionSessionToken: currentSessionToken,
      width: Math.ceil(surface.scrollWidth),
      height: Math.ceil(surface.scrollHeight),
    });
  });
}

closeButton.addEventListener('click', () => window.magicPointerResult?.hide());
expandButton.addEventListener('click', () => {
  if (currentPayload) window.magicPointerResult?.expand(currentPayload);
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.magicPointerResult?.hide();
});

window.magicPointerResult?.onShow((payload) => renderPayload(payload));
window.magicPointerResult?.onHide(() => {
  clearAutoDismiss();
  currentPayload = null;
  currentSessionToken = '';
});
window.magicPointerResult?.onResult((payload) => {
  if (payload.selectionSessionToken && currentSessionToken && payload.selectionSessionToken !== currentSessionToken) return;
  renderPayload(payload);
});
