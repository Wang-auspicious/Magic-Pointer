const itemsRoot = document.getElementById('shopping-items');
const emptyState = document.getElementById('shopping-empty');
const remainingCount = document.getElementById('remaining-count');
const summaryLabel = document.getElementById('summary-label');
const listMeta = document.getElementById('list-meta');
const notice = document.getElementById('dashboard-notice');
const workspace = document.querySelector('.workspace');
const viewTitle = document.getElementById('view-title');
const calendarView = document.getElementById('calendar-view');
const shoppingViews = Array.from(document.querySelectorAll('[data-shopping-view]'));
const calendarForm = document.getElementById('calendar-event-form');
const calendarTitle = document.getElementById('calendar-title');
const calendarDate = document.getElementById('calendar-date');
const calendarStart = document.getElementById('calendar-start');
const calendarEnd = document.getElementById('calendar-end');
const calendarTimezone = document.getElementById('calendar-timezone');
const calendarLocation = document.getElementById('calendar-location');
const calendarNotes = document.getElementById('calendar-notes');
const calendarCreate = document.getElementById('calendar-create');
const calendarFormStatus = document.getElementById('calendar-form-status');
const calendarWarning = document.getElementById('calendar-warning');
const calendarConflictsRoot = document.getElementById('calendar-conflicts');
const calendarEventsRoot = document.getElementById('calendar-events');
const calendarEmpty = document.getElementById('calendar-empty');
const upcomingCount = document.getElementById('upcoming-count');
const calendarDraftSource = document.getElementById('calendar-draft-source');

let currentState = { revision: 0, items: [] };
let highlightItemId = null;
let highlightTimer = null;
const pendingItems = new Set();
let activeView = 'shopping-list';
let calendarState = { revision: 0, events: [] };
let calendarSource = {};
let calendarIdempotencyKey = null;
let calendarConflicts = [];
let conflictConfirmationArmed = false;
let calendarPending = false;
let calendarPreviewTimer = null;
let highlightEventId = null;

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

function setActiveView(view) {
  activeView = view === 'calendar' ? 'calendar' : 'shopping-list';
  workspace.dataset.view = activeView;
  viewTitle.textContent = activeView === 'calendar' ? '日历' : '购物清单';
  calendarView.hidden = activeView !== 'calendar';
  shoppingViews.forEach((element) => { element.hidden = activeView === 'calendar'; });
  document.querySelectorAll('[data-view-target]').forEach((button) => {
    const selected = button.dataset.viewTarget === activeView;
    button.classList.toggle('is-active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (activeView === 'calendar') window.magicPointerDashboard.calendarRequestState();
  else window.magicPointerDashboard.requestState();
}

function calendarEventFromForm() {
  const title = calendarTitle.value.trim();
  const date = calendarDate.value;
  const start = calendarStart.value;
  const end = calendarEnd.value;
  if (!title || !date || !start || !end) return null;
  if (end <= start) return null;
  return {
    title,
    start_at: `${date}T${start}:00+08:00`,
    end_at: `${date}T${end}:00+08:00`,
    timezone: calendarTimezone.value || 'Asia/Shanghai',
    location: calendarLocation.value.trim(),
    notes: calendarNotes.value.trim(),
    all_day: false,
  };
}

function resetConflictConfirmation() {
  conflictConfirmationArmed = false;
  calendarCreate.textContent = calendarConflicts.length ? '仍然创建' : '创建事件';
}

function renderCalendarConflicts(conflicts = []) {
  calendarConflicts = Array.isArray(conflicts) ? conflicts : [];
  calendarConflictsRoot.replaceChildren();
  calendarConflictsRoot.hidden = calendarConflicts.length === 0;
  if (calendarConflicts.length) {
    const strong = document.createElement('strong');
    strong.textContent = `与 ${calendarConflicts.length} 个事件时间重叠`;
    const detail = document.createElement('span');
    detail.textContent = calendarConflicts.map((event) => event.title).join('、');
    calendarConflictsRoot.append(strong, detail);
  }
  resetConflictConfirmation();
}

function updateCalendarForm({ preview = true, identityChanged = false } = {}) {
  if (identityChanged) calendarIdempotencyKey = crypto.randomUUID();
  const event = calendarEventFromForm();
  const complete = Boolean(event);
  calendarCreate.disabled = !complete || calendarPending;
  if (!complete) {
    const filled = calendarTitle.value && calendarDate.value && calendarStart.value && calendarEnd.value;
    calendarFormStatus.textContent = filled ? '结束时间必须晚于开始时间' : '填写完整时间后可创建';
    renderCalendarConflicts([]);
    return;
  }
  calendarFormStatus.textContent = calendarConflicts.length ? '检测到冲突，需要再次确认' : '创建前会再次核验时间冲突';
  if (!preview) return;
  if (calendarPreviewTimer) clearTimeout(calendarPreviewTimer);
  calendarPreviewTimer = setTimeout(() => {
    window.magicPointerDashboard.calendarPreview({ event });
  }, 180);
}

function applyCalendarDraft(draft = {}) {
  calendarTitle.value = draft.title || '';
  calendarDate.value = draft.date || '';
  calendarStart.value = draft.start_time || '';
  calendarEnd.value = draft.end_time || '';
  calendarTimezone.value = draft.timezone || 'Asia/Shanghai';
  calendarLocation.value = draft.location || '';
  calendarNotes.value = draft.notes || '';
  calendarSource = draft.source && typeof draft.source === 'object' ? draft.source : {};
  calendarIdempotencyKey = draft.idempotency_key || crypto.randomUUID();
  const sourceApp = calendarSource.app || '选区';
  const sourceWindow = calendarSource.window_title || '';
  calendarDraftSource.textContent = sourceWindow ? `来自 ${sourceApp} · ${sourceWindow}` : `来自 ${sourceApp}`;
  const warnings = Array.isArray(draft.warnings) ? draft.warnings : [];
  const missing = Array.isArray(draft.missing_fields) ? draft.missing_fields : [];
  calendarWarning.hidden = warnings.length === 0 && missing.length === 0;
  calendarWarning.textContent = [...warnings, ...(missing.length ? [`请补充：${missing.join('、')}`] : [])].join(' ');
  renderCalendarConflicts([]);
  updateCalendarForm({ preview: true, identityChanged: false });
}

function clearCalendarDraft() {
  calendarForm.reset();
  calendarTimezone.value = 'Asia/Shanghai';
  calendarSource = {};
  calendarIdempotencyKey = crypto.randomUUID();
  calendarDraftSource.textContent = '手动创建本地事件';
  calendarWarning.hidden = true;
  calendarWarning.textContent = '';
  renderCalendarConflicts([]);
  updateCalendarForm({ preview: false });
}

function formatEventTime(event) {
  const start = new Date(event.start_at);
  const end = new Date(event.end_at);
  const day = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' }).format(start);
  const timeRange = `${start.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} – ${end.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  return `${day} · ${timeRange}`;
}

function renderCalendarEvent(event) {
  const card = document.createElement('article');
  card.className = 'calendar-event';
  card.dataset.eventId = event.id;
  if (event.id === highlightEventId) card.classList.add('is-highlighted');
  const title = document.createElement('span');
  title.className = 'calendar-event-title';
  title.textContent = event.title;
  const time = document.createElement('span');
  time.className = 'calendar-event-time';
  time.textContent = formatEventTime(event);
  const location = document.createElement('span');
  location.className = 'calendar-event-location';
  location.textContent = event.location || '未填写地点';
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'calendar-event-undo';
  undo.textContent = '↶';
  undo.title = '撤销这次创建';
  undo.setAttribute('aria-label', `撤销创建：${event.title}`);
  undo.addEventListener('click', () => {
    undo.disabled = true;
    window.magicPointerDashboard.calendarUndoCreate({
      eventId: event.id,
      receiptId: event.create_receipt_id,
      expectedUpdatedAt: event.updated_at,
    });
  });
  card.append(title, time, location, undo);
  return card;
}

function renderCalendarState(state) {
  calendarState = state && Array.isArray(state.events) ? state : { revision: 0, events: [] };
  calendarEventsRoot.replaceChildren(...calendarState.events.map(renderCalendarEvent));
  calendarEmpty.hidden = calendarState.events.length > 0;
  upcomingCount.textContent = String(calendarState.events.length);
}

window.magicPointerDashboard.onShow((payload = {}) => {
  clearNotice();
  highlightItemId = payload.highlightItemId || null;
  highlightEventId = payload.highlightEventId || null;
  if (payload.view === 'calendar' || (!payload.view && activeView === 'calendar')) {
    setActiveView('calendar');
    if (payload.calendarDraft) applyCalendarDraft(payload.calendarDraft);
  } else {
    setActiveView('shopping-list');
  }
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

window.magicPointerDashboard.onCalendarState((payload = {}) => {
  calendarPending = false;
  if (payload.state) renderCalendarState(payload.state);
  if (payload.normalizedEvent) renderCalendarConflicts(payload.conflicts || []);
  const actionType = payload.executionResult?.action_type;
  if (payload.ok && actionType === 'calendar_event_create') {
    highlightEventId = payload.executionResult?.output?.event?.id || null;
    clearCalendarDraft();
    renderCalendarState(payload.state);
  } else if (!payload.ok) {
    if (Array.isArray(payload.conflicts) && payload.conflicts.length) renderCalendarConflicts(payload.conflicts);
    calendarWarning.hidden = false;
    calendarWarning.textContent = payload.error || '日历操作未完成，请检查字段后重试。';
  }
  updateCalendarForm({ preview: false });
});

document.querySelectorAll('[data-view-target]').forEach((button) => {
  button.addEventListener('click', () => setActiveView(button.dataset.viewTarget));
});

calendarForm.querySelectorAll('input:not([readonly]), textarea').forEach((input) => {
  input.addEventListener('input', () => {
    calendarWarning.hidden = true;
    renderCalendarConflicts([]);
    updateCalendarForm({ preview: true, identityChanged: true });
  });
});

calendarForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const calendarEvent = calendarEventFromForm();
  if (!calendarEvent || calendarPending) return;
  if (calendarConflicts.length && !conflictConfirmationArmed) {
    conflictConfirmationArmed = true;
    calendarCreate.textContent = '确认仍然创建';
    calendarFormStatus.textContent = '再次点击将创建重叠事件';
    return;
  }
  calendarPending = true;
  calendarCreate.disabled = true;
  calendarCreate.textContent = '正在创建…';
  window.magicPointerDashboard.calendarCreate({
    event: calendarEvent,
    idempotencyKey: calendarIdempotencyKey || crypto.randomUUID(),
    source: calendarSource,
    allowConflict: calendarConflicts.length > 0,
    confirmed: true,
  });
});

document.getElementById('calendar-refresh').addEventListener('click', () => window.magicPointerDashboard.calendarRequestState());

document.getElementById('dashboard-close').addEventListener('click', () => window.magicPointerDashboard.hide());
document.getElementById('dashboard-refresh').addEventListener('click', () => {
  clearNotice();
  window.magicPointerDashboard.requestState();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.magicPointerDashboard.hide();
});

renderState(currentState);
renderCalendarState(calendarState);
clearCalendarDraft();
