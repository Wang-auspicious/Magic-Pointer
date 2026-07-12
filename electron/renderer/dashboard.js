const itemsRoot = document.getElementById('shopping-items');
const emptyState = document.getElementById('shopping-empty');
const remainingCount = document.getElementById('remaining-count');
const summaryLabel = document.getElementById('summary-label');
const listMeta = document.getElementById('list-meta');
const notice = document.getElementById('dashboard-notice');

let currentState = { revision: 0, items: [] };
let highlightItemId = null;
let highlightTimer = null;
const pendingItems = new Set();

function showNotice(message) {
  notice.textContent = String(message || '操作未完成，请刷新后重试。');
  notice.hidden = false;
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = '';
}

function sourceLabel(item) {
  const app = String(item?.source?.app || '').trim();
  const title = String(item?.source?.window_title || '').trim();
  if (app && title) return `来自 ${app} · ${title}`;
  if (app) return `来自 ${app}`;
  return '由 Magic Pointer 添加';
}

function renderItem(item) {
  const row = document.createElement('div');
  row.className = 'shopping-item';
  row.dataset.itemId = item.id;
  if (item.checked) row.classList.add('is-checked');
  if (item.id === highlightItemId) row.classList.add('is-highlighted');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'item-check';
  checkbox.checked = item.checked === true;
  checkbox.disabled = pendingItems.has(item.id);
  checkbox.setAttribute('aria-label', `${checkbox.checked ? '取消完成' : '标记完成'}：${item.text}`);
  checkbox.addEventListener('change', () => {
    pendingItems.add(item.id);
    checkbox.disabled = true;
    clearNotice();
    window.magicPointerDashboard.setChecked({
      itemId: item.id,
      checked: checkbox.checked,
      expectedUpdatedAt: item.updated_at,
    });
  });

  const copy = document.createElement('div');
  copy.className = 'item-copy';
  const text = document.createElement('span');
  text.className = 'item-text';
  text.textContent = item.text;
  text.title = item.text;
  const source = document.createElement('span');
  source.className = 'item-source';
  source.textContent = sourceLabel(item);
  copy.append(text, source);

  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'item-undo';
  undo.textContent = '撤销添加';
  undo.disabled = pendingItems.has(item.id);
  undo.setAttribute('aria-label', `撤销添加：${item.text}`);
  undo.addEventListener('click', () => {
    pendingItems.add(item.id);
    undo.disabled = true;
    clearNotice();
    window.magicPointerDashboard.undoAdd({
      itemId: item.id,
      receiptId: item.add_receipt_id,
      expectedUpdatedAt: item.updated_at,
    });
  });

  row.append(checkbox, copy, undo);
  return row;
}

function renderState(state) {
  currentState = state && Array.isArray(state.items) ? state : { revision: 0, items: [] };
  itemsRoot.replaceChildren(...currentState.items.map(renderItem));
  emptyState.hidden = currentState.items.length > 0;
  const remaining = currentState.items.filter((item) => !item.checked).length;
  remainingCount.textContent = String(remaining);
  summaryLabel.textContent = currentState.items.length
    ? `${currentState.items.length} 件商品，${remaining} 件待完成`
    : '准备好添加第一件商品';
  listMeta.textContent = `本地即时保存 · 版本 ${currentState.revision || 0}`;
}

window.magicPointerDashboard.onShow((payload = {}) => {
  clearNotice();
  highlightItemId = payload.highlightItemId || null;
  window.magicPointerDashboard.requestState();
});

window.magicPointerDashboard.onState((payload = {}) => {
  pendingItems.clear();
  if (!payload.ok) showNotice(payload.error);
  if (payload.state) renderState(payload.state);
  if (highlightTimer) clearTimeout(highlightTimer);
  if (highlightItemId) {
    const highlighted = itemsRoot.querySelector(`[data-item-id="${CSS.escape(highlightItemId)}"]`);
    highlighted?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    highlightTimer = setTimeout(() => {
      highlightItemId = null;
      document.querySelectorAll('.shopping-item.is-highlighted').forEach((row) => row.classList.remove('is-highlighted'));
    }, 1600);
  }
});

document.getElementById('dashboard-close').addEventListener('click', () => window.magicPointerDashboard.hide());
document.getElementById('dashboard-refresh').addEventListener('click', () => {
  clearNotice();
  window.magicPointerDashboard.requestState();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.magicPointerDashboard.hide();
});

renderState(currentState);
