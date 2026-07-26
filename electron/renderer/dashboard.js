const api = window.magicPointerDashboard;
const views = Array.from(document.querySelectorAll('[data-fabric-view]'));
const navItems = Array.from(document.querySelectorAll('[data-view-target]'));
const title = document.getElementById('view-title');
const subtitle = document.getElementById('view-subtitle');
const saveState = document.getElementById('save-state');

const viewCopy = {
  activation: ['唤醒与对象锁定', '默认不可见。晃动时先冻结对象，再显示动作轨。'],
  agents: ['Agent 连接', '使用每个 Agent 的真实 RPC、JSONL、HTTP 或 CLI 协议。'],
  recipes: ['Recipe 目录', '一个对象协议，30 个可组合的跨应用动作。'],
  connections: ['目标连接器', '原生 API 优先，视觉和点击只做有边界的兜底。'],
  privacy: ['隐私与权限', '读取、写入、发送、删除和付款使用不同权限层级。'],
  activity: ['活动与回执', '只保存操作元数据；prompt、内容和截图路径默认脱敏。'],
  diagnostics: ['运行诊断', '显示真实可用能力和未验证边界。'],
  'shopping-list': ['本地兼容动作', '旧清单仅作为确定性动作回归夹具。'],
  calendar: ['核对日历事件', '创建前核对字段和冲突；不会静默提交。'],
  route: ['核对路线', '只绑定起终点，距离与时间交给地图服务计算。'],
};

let activeView = 'activation';
let settings = null;
let providers = [];
let recipes = [];
let auditEvents = [];
let conflictConfirmationArmed = false;
let calendarPreviewTimer = null;

function setActiveView(view) {
  activeView = viewCopy[view] ? view : 'activation';
  const copy = viewCopy[activeView];
  title.textContent = copy[0];
  subtitle.textContent = copy[1];
  views.forEach((element) => { element.hidden = element.dataset.fabricView !== activeView; });
  navItems.forEach((button) => {
    const selected = button.dataset.viewTarget === activeView;
    button.classList.toggle('is-active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (activeView === 'activity') fabricRequest('audit.tail', { limit: 120 });
  if (activeView === 'calendar') api.calendarRequestState();
  if (activeView === 'shopping-list') api.requestState();
}

function fabricRequest(operation, payload = {}) {
  api.fabricRequest(operation, payload);
}

function requestFabricState() {
  fabricRequest('settings.get');
  fabricRequest('catalog');
  fabricRequest('providers');
  fabricRequest('audit.tail', { limit: 120 });
}

function lines(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function valuesFromLines(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function setValue(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  if (element.type === 'checkbox') element.checked = value === true;
  else element.value = value ?? '';
}

function applySettings(value) {
  settings = structuredClone(value);
  const activation = settings.activation || {};
  const interaction = settings.interaction || {};
  const privacy = settings.privacy || {};
  const permissions = settings.permissions || {};
  const agents = settings.agents || {};
  setValue('wiggle-enabled', activation.wiggle_enabled);
  setValue('wiggle-sensitivity', Math.round(Number(activation.sensitivity || .55) * 100));
  setValue('default-input-mode', interaction.default_input_mode || 'voice');
  setValue('fallback-hotkey-enabled', activation.fallback_hotkey_enabled);
  setValue('fallback-hotkey', activation.fallback_hotkey);
  setValue('disabled-apps', lines(activation.disabled_apps));
  setValue('upload-screenshots', privacy.upload_screenshots);
  setValue('retain-captures-days', privacy.retain_captures_days);
  setValue('retain-audit-days', privacy.retain_audit_days);
  setValue('sensitive-apps', lines(privacy.sensitive_apps));
  setValue('permission-read', permissions.default_read);
  setValue('permission-write', permissions.default_write);
  setValue('permission-send', permissions.default_send);
  setValue('permission-destructive', permissions.default_destructive);
  setValue('permission-purchase', permissions.default_purchase);
  setValue('preferred-agent', agents.preferred || 'pi');
  document.getElementById('sensitivity-value').textContent = `${Math.round(Number(activation.sensitivity || .55) * 100)}%`;
  document.getElementById('diag-wiggle').textContent = activation.wiggle_enabled ? 'ON' : 'OFF';
}

function collectSettings() {
  if (!settings) return null;
  const next = structuredClone(settings);
  next.activation.wiggle_enabled = document.getElementById('wiggle-enabled').checked;
  next.activation.sensitivity = Number(document.getElementById('wiggle-sensitivity').value) / 100;
  next.interaction = { ...(next.interaction || {}) };
  next.interaction.default_input_mode = document.getElementById('default-input-mode').value === 'text' ? 'text' : 'voice';
  next.activation.fallback_hotkey_enabled = document.getElementById('fallback-hotkey-enabled').checked;
  next.activation.fallback_hotkey = document.getElementById('fallback-hotkey').value.trim() || 'Control+Alt+M';
  next.activation.disabled_apps = valuesFromLines(document.getElementById('disabled-apps').value);
  next.privacy.upload_screenshots = document.getElementById('upload-screenshots').checked;
  next.privacy.retain_captures_days = Number(document.getElementById('retain-captures-days').value);
  next.privacy.retain_audit_days = Number(document.getElementById('retain-audit-days').value);
  next.privacy.sensitive_apps = valuesFromLines(document.getElementById('sensitive-apps').value);
  next.permissions.default_read = document.getElementById('permission-read').value;
  next.permissions.default_write = document.getElementById('permission-write').value;
  next.permissions.default_send = document.getElementById('permission-send').value;
  next.permissions.default_destructive = document.getElementById('permission-destructive').value;
  next.permissions.default_purchase = document.getElementById('permission-purchase').value;
  next.agents.preferred = document.getElementById('preferred-agent').value || 'pi';
  next.recipe_enabled = { ...(next.recipe_enabled || {}) };
  document.querySelectorAll('[data-recipe-enabled]').forEach((toggle) => {
    next.recipe_enabled[toggle.dataset.recipeEnabled] = toggle.checked;
  });
  return next;
}

function saveFabricSettings() {
  const next = collectSettings();
  if (!next) return;
  saveState.textContent = '正在保存…';
  api.saveFabricSettings(next);
}

function renderProviders(items) {
  providers = Array.isArray(items) ? items : [];
  const root = document.getElementById('provider-list');
  const rows = providers.map((provider, index) => {
    const row = document.createElement('article');
    row.className = 'provider-row';
    const code = document.createElement('span');
    code.className = 'provider-code';
    code.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('strong');
    name.className = 'provider-name';
    name.textContent = provider.name || provider.id;
    const protocols = document.createElement('span');
    protocols.className = 'provider-protocols';
    protocols.textContent = `${(provider.protocols || []).join(' · ')}${provider.version ? ` / ${provider.version}` : ''}`;
    const state = document.createElement('b');
    state.className = `provider-state ${provider.available ? 'is-ready' : 'is-missing'}`;
    state.textContent = provider.available ? 'AVAILABLE' : 'MISSING';
    state.title = provider.available ? provider.executable || '' : provider.installHint || provider.reason || '';
    row.append(code, name, protocols, state);
    return row;
  });
  root.replaceChildren(...rows);
  const preferred = document.getElementById('preferred-agent');
  const selected = settings?.agents?.preferred || preferred.value || 'pi';
  const options = providers.map((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = `${provider.name}${provider.available ? '' : '（未安装）'}`;
    option.disabled = !provider.available;
    return option;
  });
  preferred.replaceChildren(...options);
  if (options.some((option) => option.value === selected && !option.disabled)) preferred.value = selected;
  else {
    const firstAvailable = providers.find((provider) => provider.available);
    if (firstAvailable) preferred.value = firstAvailable.id;
  }
  document.getElementById('diag-agents').textContent = `${providers.filter((item) => item.available).length}/${providers.length}`;
}

function renderRecipes(items = recipes) {
  recipes = Array.isArray(items) ? items : [];
  const query = document.getElementById('recipe-filter').value.trim().toLowerCase();
  const visible = recipes.filter((recipe) => {
    if (!query) return true;
    return `${recipe.id} ${recipe.title} ${recipe.description} ${(recipe.providerStrategies || []).join(' ')}`.toLowerCase().includes(query);
  });
  const rows = visible.map((recipe) => {
    const row = document.createElement('article');
    row.className = 'recipe-row';
    const number = document.createElement('span');
    number.className = 'recipe-number';
    number.textContent = String(recipes.indexOf(recipe) + 1).padStart(2, '0');
    const copy = document.createElement('div');
    copy.className = 'recipe-copy';
    const name = document.createElement('b');
    name.textContent = recipe.title;
    const description = document.createElement('p');
    description.textContent = recipe.description;
    const provider = document.createElement('span');
    provider.className = 'recipe-provider';
    provider.textContent = `${recipe.id} / ${(recipe.providerStrategies || []).join(' → ')}`;
    copy.append(name, description, provider);
    const controls = document.createElement('div');
    controls.className = 'recipe-controls';
    const risk = document.createElement('span');
    risk.className = 'risk';
    risk.dataset.risk = recipe.risk;
    risk.textContent = String(recipe.risk || 'read').toUpperCase();
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.dataset.recipeEnabled = recipe.id;
    enabled.checked = settings?.recipe_enabled?.[recipe.id] !== false;
    enabled.title = enabled.checked ? '已启用' : '已禁用';
    enabled.addEventListener('change', () => {
      if (settings) settings.recipe_enabled[recipe.id] = enabled.checked;
      enabled.title = enabled.checked ? '已启用' : '已禁用';
    });
    controls.append(risk, enabled);
    row.append(number, copy, controls);
    return row;
  });
  document.getElementById('recipe-list').replaceChildren(...rows);
  document.getElementById('diag-recipes').textContent = String(recipes.length || 0);
}

// Receipt statuses arrive verbatim from the fabric audit log and are rendered
// verbatim. 'accepted' means the agent task is queued and NOT finished; it is
// never re-mapped to a terminal state, and no synthetic progress is shown.
const RECEIPT_STATUS_COPY = {
  accepted: '已受理 · 排队中 · 尚未完成',
  succeeded: '执行成功',
  failed: '执行失败',
  denied: '权限拒绝',
  capability_unavailable: '能力缺失',
  verification_failed: '验证未通过',
  confirmation_required: '等待用户确认',
};

function buildActivityTimeline(events) {
  const entries = [];
  const open = [];
  events.forEach((event) => {
    const data = event.data || {};
    if (event.type === 'recipe.planned') {
      const entry = { planned: event, executed: null };
      entries.push(entry);
      open.push(entry);
    } else if (event.type === 'recipe.executed') {
      const index = open.findLastIndex((item) => {
        const planned = item.planned.data || {};
        return planned.recipeId === data.recipeId && planned.provider === data.provider;
      });
      if (index >= 0) {
        open[index].executed = event;
        open.splice(index, 1);
      } else entries.push({ planned: null, executed: event });
    } else entries.push({ raw: event });
  });
  return entries;
}

function activityTimestamp(event) {
  return String(event?.timestamp || '').replace('T', ' ').slice(0, 19);
}

function timelineStage(name, stateClass, text) {
  const stage = document.createElement('li');
  stage.className = `timeline-stage ${stateClass}`;
  stage.dataset.stage = name;
  const label = document.createElement('span');
  label.className = 'stage-label';
  label.textContent = name;
  const body = document.createElement('span');
  body.className = 'stage-text';
  body.textContent = text;
  stage.append(label, body);
  return stage;
}

function renderTimelineEntry(entry) {
  if (entry.raw) {
    const row = document.createElement('article');
    row.className = 'activity-row';
    const time = document.createElement('span');
    time.className = 'activity-time';
    time.textContent = activityTimestamp(entry.raw);
    const type = document.createElement('strong');
    type.className = 'activity-type';
    type.textContent = entry.raw.type || 'event';
    const data = document.createElement('span');
    data.className = 'activity-data';
    data.textContent = JSON.stringify(entry.raw.data || {});
    row.append(time, type, data);
    return row;
  }
  const planned = entry.planned ? (entry.planned.data || {}) : null;
  const executed = entry.executed ? (entry.executed.data || {}) : null;
  const rawStatus = executed ? String(executed.status || 'unknown') : null;
  const article = document.createElement('article');
  article.className = 'timeline-entry';
  if (rawStatus) article.dataset.status = rawStatus;

  const head = document.createElement('header');
  head.className = 'timeline-head';
  const time = document.createElement('span');
  time.className = 'activity-time';
  time.textContent = activityTimestamp(entry.executed || entry.planned);
  const recipe = document.createElement('strong');
  recipe.className = 'timeline-recipe';
  recipe.textContent = String((planned || executed || {}).recipeId || 'recipe');
  const risk = document.createElement('span');
  risk.className = 'timeline-risk';
  risk.textContent = planned ? String(planned.risk || '').toUpperCase() : '';
  const statusCode = document.createElement('b');
  statusCode.className = 'timeline-status';
  if (rawStatus) statusCode.dataset.status = rawStatus;
  // Verbatim status token from the audit event — no re-mapping, no percentages.
  statusCode.textContent = rawStatus || 'planned';
  head.append(time, recipe, risk, statusCode);

  const stages = document.createElement('ol');
  stages.className = 'timeline-stages';

  const intentText = planned
    ? `${planned.recipeId || ''} · ${planned.objectCount ?? 0} 个对象 · 风险 ${planned.risk || 'read'}`
    : '本地审计中缺少计划事件';
  stages.append(timelineStage('意图', planned ? 'is-done' : 'is-missing', intentText));

  const planText = planned
    ? `provider ${planned.provider || '-'}${planned.requiresConfirmation ? ' · 需要用户确认' : ' · 无需确认'}`
    : `provider ${executed?.provider || '-'}`;
  stages.append(timelineStage('计划', planned ? 'is-done' : 'is-missing', planText));

  if (!executed) {
    stages.append(timelineStage('状态', 'is-pending', '已生成计划，尚未执行'));
  } else if (rawStatus === 'accepted') {
    // Honest queued position: accepted is NOT completion.
    stages.append(timelineStage('状态', 'is-accepted', `${rawStatus} · ${RECEIPT_STATUS_COPY.accepted}`));
  } else {
    const copy = RECEIPT_STATUS_COPY[rawStatus] || '未知状态';
    const stateClass = rawStatus === 'succeeded' ? 'is-done' : 'is-failed';
    stages.append(timelineStage('状态', stateClass, `${rawStatus} · ${copy}${executed.error ? ` · ${executed.error}` : ''}`));
  }

  if (!executed) stages.append(timelineStage('验证', 'is-pending', '未执行，无验证结果'));
  else if (executed.verified === true) stages.append(timelineStage('验证', 'is-done', '已在目标表面回读验证'));
  else if (rawStatus === 'accepted') stages.append(timelineStage('验证', 'is-pending', '终态未验证 · 等待任务完成'));
  else stages.append(timelineStage('验证', 'is-failed', '未通过验证或未验证'));

  if (executed && executed.undoAvailable === true) stages.append(timelineStage('撤销', 'is-done', '回执声明可撤销'));
  else stages.append(timelineStage('撤销', 'is-pending', '回执未包含撤销信息'));

  article.append(head, stages);
  return article;
}

function renderActivity(items) {
  auditEvents = Array.isArray(items) ? items : [];
  const root = document.getElementById('activity-list');
  if (!auditEvents.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '尚无本地活动。晃动并执行一个 Recipe 后，这里会显示脱敏回执。';
    root.replaceChildren(empty);
    return;
  }
  const rows = buildActivityTimeline(auditEvents).reverse().map(renderTimelineEntry);
  root.replaceChildren(...rows);
}

function handleFabricState(payload = {}) {
  const operation = payload.fabricOperation;
  if (!payload.ok) {
    if (operation === 'calibration.complete') {
      const button = document.getElementById('wiggle-calibrate');
      button.disabled = false;
      button.textContent = '重新校准 10 秒';
      document.getElementById('calibration-status').textContent = payload.error || '没有检测到完整晃动，请重试。';
    }
    saveState.textContent = payload.error || '操作失败';
    return;
  }
  if (operation === 'settings.get' || operation === 'settings.save') {
    applySettings(payload.settings);
    saveState.textContent = operation === 'settings.save' ? '已保存 · 晃动设置已立即生效' : '';
  } else if (operation === 'catalog') renderRecipes(payload.recipes);
  else if (operation === 'providers') renderProviders(payload.providers);
  else if (operation === 'audit.tail') renderActivity(payload.events);
  else if (operation === 'calibration.complete') {
    const calibrated = payload.calibration || {};
    const percent = Math.round(Number(calibrated.sensitivity || .55) * 100);
    const button = document.getElementById('wiggle-calibrate');
    button.disabled = false;
    button.textContent = '重新校准 10 秒';
    document.getElementById('wiggle-sensitivity').value = String(percent);
    document.getElementById('sensitivity-value').textContent = `${percent}%`;
    document.getElementById('calibration-status').textContent =
      `已采集 ${calibrated.samples || 0} 次完整晃动，灵敏度已保存为 ${percent}%。`;
    if (payload.settings) applySettings(payload.settings);
  }
}

function renderState(state = {}) {
  const items = Array.isArray(state.items) ? state.items : [];
  const rows = items.map((item) => {
    const row = document.createElement('div');
    row.className = 'shopping-item';
    if (item.id) row.dataset.itemId = item.id;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.checked === true;
    checkbox.addEventListener('change', () => window.magicPointerDashboard.setChecked({
      itemId: item.id,
      checked: checkbox.checked,
      expectedUpdatedAt: item.updated_at,
    }));
    const text = document.createElement('span');
    text.textContent = item.text || '';
    const undo = document.createElement('button');
    undo.textContent = '撤销';
    undo.addEventListener('click', () => window.magicPointerDashboard.undoAdd({
      itemId: item.id,
      receiptId: item.add_receipt_id,
      expectedUpdatedAt: item.updated_at,
    }));
    row.append(checkbox, text, undo);
    return row;
  });
  document.getElementById('shopping-items').replaceChildren(...rows);
  document.getElementById('remaining-count').textContent = String(items.filter((item) => !item.checked).length);
  document.getElementById('shopping-empty').hidden = items.length > 0;
  document.getElementById('list-meta').textContent = `revision ${state.revision || 0}`;
}

function applyCalendarDraft(draft = {}) {
  setValue('calendar-title', draft.title);
  setValue('calendar-date', draft.date);
  setValue('calendar-start', draft.start_time);
  setValue('calendar-end', draft.end_time);
  setValue('calendar-timezone', draft.timezone || 'Asia/Shanghai');
  setValue('calendar-location', draft.location);
  setValue('calendar-notes', draft.notes);
  document.getElementById('calendar-draft-source').textContent = draft.source?.window_title || draft.source?.app || '当前选区';
  conflictConfirmationArmed = false;
  const calendarEvent = calendarEventFromForm();
  if (calendarEvent) api.calendarPreview({ event: calendarEvent });
}

function renderCalendarState(state = {}) {
  const events = Array.isArray(state.events) ? state.events : [];
  const rows = events.map((event) => {
    const row = document.createElement('article');
    const text = document.createElement('span');
    text.textContent = `${event.title || ''} · ${event.start_at || ''}`;
    const undo = document.createElement('button');
    undo.textContent = '撤销';
    undo.addEventListener('click', () => api.calendarUndoCreate({
      eventId: event.id,
      receiptId: event.create_receipt_id,
      expectedUpdatedAt: event.updated_at,
    }));
    row.append(text, undo);
    return row;
  });
  document.getElementById('calendar-events').replaceChildren(...rows);
  document.getElementById('calendar-empty').hidden = events.length > 0;
  document.getElementById('upcoming-count').textContent = String(events.length);
}

function applyRouteDraft(draft = {}) {
  setValue('route-origin', draft.origin);
  setValue('route-destination', draft.destination);
  document.getElementById('route-source').textContent = `${draft.origin_source?.app || 'THAT'} → ${draft.destination_source?.app || 'THIS'}`;
}

function calendarEventFromForm() {
  const date = document.getElementById('calendar-date').value;
  const start = document.getElementById('calendar-start').value;
  const end = document.getElementById('calendar-end').value;
  const eventTitle = document.getElementById('calendar-title').value.trim();
  if (!date || !start || !end || !eventTitle || end <= start) return null;
  return {
    title: eventTitle,
    start_at: `${date}T${start}:00+08:00`,
    end_at: `${date}T${end}:00+08:00`,
    timezone: document.getElementById('calendar-timezone').value || 'Asia/Shanghai',
    location: document.getElementById('calendar-location').value.trim(),
    notes: document.getElementById('calendar-notes').value.trim(),
    all_day: false,
  };
}

api.onFabricState(handleFabricState);
api.onShow((payload = {}) => {
  if (payload.view === 'calendar') {
    setActiveView('calendar');
    if (payload.calendarDraft) applyCalendarDraft(payload.calendarDraft);
  } else if (payload.view === 'route') {
    setActiveView('route');
    if (payload.routeDraft) applyRouteDraft(payload.routeDraft);
  } else {
    setActiveView(activeView);
  }
  requestFabricState();
});
api.onState((payload = {}) => {
  if (payload.state) renderState(payload.state);
  document.getElementById('dashboard-notice').hidden = payload.ok !== false;
  document.getElementById('dashboard-notice').textContent = payload.error || '';
});
api.onCalendarState((payload = {}) => {
  if (payload.state) renderCalendarState(payload.state);
  const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
  const warning = document.getElementById('calendar-warning');
  const conflictList = document.getElementById('calendar-conflicts');
  conflictConfirmationArmed = conflicts.length > 0;
  warning.hidden = payload.ok !== false && conflicts.length === 0;
  warning.textContent = payload.error || (conflicts.length ? '检测到日历冲突。再次提交会明确覆盖冲突。' : '');
  conflictList.hidden = conflicts.length === 0;
  conflictList.textContent = conflicts
    .map((item) => `${item.title || '已有事件'} · ${item.start_at || ''}`)
    .join('\n');
});
api.onRouteResult((payload = {}) => {
  document.getElementById('route-notice').hidden = payload.ok === true;
  document.getElementById('route-notice').textContent = payload.error || '';
});

navItems.forEach((button) => button.addEventListener('click', () => setActiveView(button.dataset.viewTarget)));
document.getElementById('settings-save').addEventListener('click', saveFabricSettings);
document.getElementById('providers-refresh').addEventListener('click', () => fabricRequest('providers'));
document.getElementById('activity-refresh').addEventListener('click', () => fabricRequest('audit.tail', { limit: 120 }));
document.getElementById('recipe-filter').addEventListener('input', () => renderRecipes(recipes));
document.getElementById('wiggle-sensitivity').addEventListener('input', (event) => {
  document.getElementById('sensitivity-value').textContent = `${event.target.value}%`;
});
document.getElementById('wiggle-calibrate').addEventListener('click', () => {
  const button = document.getElementById('wiggle-calibrate');
  const status = document.getElementById('calibration-status');
  button.disabled = true;
  fabricRequest('calibration.start');
  let remaining = 10;
  status.textContent = '请自然晃动 5 次；校准期间不会捕获屏幕内容。';
  button.textContent = `校准中 ${remaining}s`;
  const timer = setInterval(() => {
    remaining -= 1;
    button.textContent = remaining > 0 ? `校准中 ${remaining}s` : '校准完成';
    if (remaining <= 0) {
      clearInterval(timer);
      button.textContent = '正在计算阈值…';
      status.textContent = '轨迹采集结束，正在根据完整晃动计算灵敏度。';
    }
  }, 1000);
});

document.getElementById('calendar-event-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const calendarEvent = calendarEventFromForm();
  if (!calendarEvent) return;
  window.magicPointerDashboard.calendarCreate({
    event: calendarEvent,
    idempotencyKey: crypto.randomUUID(),
    source: {},
    allowConflict: conflictConfirmationArmed,
    confirmed: true,
  });
});
document.getElementById('calendar-event-form').addEventListener('input', () => {
  clearTimeout(calendarPreviewTimer);
  conflictConfirmationArmed = false;
  calendarPreviewTimer = setTimeout(() => {
    const calendarEvent = calendarEventFromForm();
    if (calendarEvent) api.calendarPreview({ event: calendarEvent });
  }, 280);
});
document.getElementById('calendar-refresh').addEventListener('click', () => window.magicPointerDashboard.calendarRequestState());
document.getElementById('route-swap').addEventListener('click', () => {
  const origin = document.getElementById('route-origin');
  const destination = document.getElementById('route-destination');
  const value = origin.value;
  origin.value = destination.value;
  destination.value = value;
});
document.getElementById('route-open').addEventListener('click', () => {
  const travelMode = document.querySelector('input[name="travel-mode"]:checked')?.value || 'driving';
  window.magicPointerDashboard.openRoute({
    origin: document.getElementById('route-origin').value.trim(),
    destination: document.getElementById('route-destination').value.trim(),
    travelMode,
  });
});
document.getElementById('dashboard-refresh').addEventListener('click', () => window.magicPointerDashboard.requestState());
document.getElementById('dashboard-close').addEventListener('click', () => api.hide());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') api.hide(); });

document.getElementById('diag-platform').textContent = navigator.platform || 'desktop';
renderProviders([]);
renderRecipes([]);
renderActivity([]);
renderState({ items: [] });
renderCalendarState({ events: [] });
setActiveView('activation');
requestFabricState();
