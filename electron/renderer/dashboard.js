const api = window.magicPointerDashboard;
const views = Array.from(document.querySelectorAll('[data-fabric-view]'));
const navItems = Array.from(document.querySelectorAll('[data-view-target]'));
const title = document.getElementById('view-title');
const subtitle = document.getElementById('view-subtitle');
const saveState = document.getElementById('save-state');
const saveButton = document.getElementById('settings-save');
const commandPalette = document.getElementById('command-palette');
const commandSearch = document.getElementById('command-search');
const commandResults = document.getElementById('command-results');
const pageScroll = document.querySelector('.page-scroll');

const viewCopy = {
  general: ['通用', '控制启动、后台运行、通知和更新。'],
  activation: ['唤醒与指向', '定义 Magic Pointer 如何出现、冻结目标，以及何时退出。'],
  voice: ['语音与输入', '管理本地转写、提交策略和项目术语。'],
  shortcuts: ['键盘快捷键', '录制全局快捷键并保存到统一设置。'],
  models: ['模型', '管理真实模型连接、能力证据和系统凭据引用。'],
  agents: ['Agents', '把目标对象送入用户已经使用的 Agent 会话。'],
  capabilities: ['能力与模板', '只展示当前环境可以实际执行和验证的动作。'],
  apps: ['应用与捕获', '按应用控制结构读取、OCR、本地截图和截图上传。'],
  permissions: ['动作与权限', '读取、写入、发送、删除和付款使用不同权限层级。'],
  connections: ['连接', '管理 Agent、浏览器与业务服务的真实连接状态。'],
  storage: ['存储', '管理捕获、任务产物和审计事件的本地留存。'],
  privacy: ['隐私', '管理敏感应用、本地脱敏和数据边界。'],
  appearance: ['外观', '控制主题、窗口材质和视觉层级。'],
  accessibility: ['辅助功能', '调整动态、透明度、对比度和键盘操作。'],
  diagnostics: ['诊断', '逐项检查运行环境、权限、输入、模型与 Agent。'],
  'shopping-list': ['本地兼容动作', '旧清单仅作为确定性动作回归夹具。'],
  calendar: ['核对日历事件', '创建前核对字段和冲突；不会静默提交。'],
  route: ['核对路线', '只绑定起终点，距离与时间交给地图服务计算。'],
};


const viewAliases = {
  recipes: 'capabilities',
};

const persistentSettingViews = new Set([
  'general', 'activation', 'voice', 'shortcuts', 'agents', 'capabilities', 'apps',
  'permissions', 'connections', 'storage', 'privacy', 'appearance', 'accessibility',
]);
let activeView = 'activation';
let settings = null;
let settingsBeforeSave = null;
let providers = [];
let agentSessions = [];
let agentContexts = [];
let models = [];
let defaultModelProfileId = null;
let recipes = [];
let auditEvents = [];
let artifactRecords = [];
let agentTasks = [];
let workflowTasks = [];
let provenanceObjects = [];
let skillCandidates = [];
let artifactCleanupArmed = false;
let conflictConfirmationArmed = false;
let reconfirmArmedTaskId = '';
let armedAgentContextId = '';
let armedSkillCandidateId = '';
const reviewedSkillDraftTokens = new Map();
let calendarPreviewTimer = null;
let preflightRunning = false;
let preflightStageOrder = [];
const preflightStages = new Map();
let runtimeSnapshotLoaded = false;
let runtimeSnapshotRequest = null;
let runtimeSnapshotForcePending = false;

const PREFLIGHT_STATE_LABELS = Object.freeze({
  pending: '等待检查',
  running: '正在检查',
  pass: '已通过',
  warn: '需要留意',
  fail: '未通过',
  skipped: '已跳过',
  needs_user: '需要设置',
  unknown: '状态未知',
});

const PREFLIGHT_ACTIONS = Object.freeze({
  install_python: {
    message: '安装 Python 3.11 或更高版本后重试。',
  },
  repair_runtime: {
    message: '重新安装 Magic Pointer，或修复本机运行环境后重试。',
  },
  request_permission: {
    message: '在系统设置中允许辅助功能与屏幕录制，然后重试。',
  },
  restart_pointer_host: {
    message: '检查唤醒方式后重新启动 Magic Pointer。',
    label: '检查唤醒设置',
    targetView: 'activation',
  },
  enable_activation: {
    message: '选择一种唤醒方式，然后重新检查。',
    label: '设置唤醒方式',
    targetView: 'activation',
  },
  request_microphone_permission: {
    message: '允许麦克风访问，或改用文字输入。',
    label: '检查语音设置',
    targetView: 'voice',
  },
  repair_grounding_runtime: {
    message: '重新安装 Magic Pointer 后重试；指向组件缺失。',
  },
  retry_agent_discovery: {
    message: '确认至少一个 Agent 可用，然后重试。',
    label: '检查 Agent',
    targetView: 'agents',
  },
  save_credential: {
    message: '保存模型凭据，或使用已连接的 Agent。',
    label: '配置模型',
    targetView: 'models',
  },
  review_privacy: {
    message: '确认捕获模式与敏感应用规则。',
    label: '检查隐私设置',
    targetView: 'privacy',
  },
  run_desktop_smoke: {
    message: '完成一次不产生外部副作用的真实指向测试。',
  },
  inspect_diagnostics: {
    message: '查看下方技术详情，修复失败项后重试。',
  },
});

function renderActiveViewHeading() {
  const copy = viewCopy[activeView];
  title.textContent = copy[0];
  subtitle.textContent = copy[1];
}

function setActiveView(view) {
  const normalizedView = viewAliases[view] || view;
  activeView = viewCopy[normalizedView] ? normalizedView : 'activation';
  pageScroll.scrollTop = 0;
  pageScroll.scrollLeft = 0;
  document.documentElement.scrollLeft = 0;
  document.body.scrollLeft = 0;
  renderActiveViewHeading();
  saveButton.hidden = !persistentSettingViews.has(activeView);
  views.forEach((element) => { element.hidden = element.dataset.fabricView !== activeView; });
  navItems.forEach((button) => {
    const selected = button.dataset.viewTarget === activeView;
    button.classList.toggle('is-active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (activeView === 'activity') {
    fabricRequest('audit.tail', { limit: 120 });
    fabricRequest('artifacts.list', { limit: 120 });
    fabricRequest('task.list', { limit: 100 });
    fabricRequest('workflow.list', { surface: 'gui', limit: 100 });
    fabricRequest('provenance.objects', { limit: 200 });
  }
  if (activeView === 'models') fabricRequest('models.list');
  if (activeView === 'capabilities') fabricRequest('skills.candidates.list', { limit: 100 });
  if (activeView === 'agents') {
    fabricRequest('providers');
    fabricRequest('agent.sessions', { cwdMatch: settings?.agents?.cwd_match || 'strict' });
    fabricRequest('agent.contexts.list', { limit: 100 });
  }
  if (activeView === 'connections') fabricRequest('browser.status');
  if (activeView === 'calendar') api.calendarRequestState();
  if (activeView === 'shopping-list') api.requestState();
}

function fabricRequest(operation, payload = {}) {
  api.fabricRequest(operation, payload);
}

function applyRuntimeSnapshot(snapshot = {}) {
  if (snapshot.settings) applySettings(snapshot.settings);
  const statusById = new Map(
    (Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [])
      .map((item) => [item.id, item]),
  );
  renderRecipes((Array.isArray(snapshot.recipes) ? snapshot.recipes : []).map((recipe) => ({
    ...recipe,
    runtimeCapability: statusById.get(recipe.id) || null,
  })));
  const runtimeModels = snapshot.models && typeof snapshot.models === 'object' ? snapshot.models : {};
  renderModels(runtimeModels.items, runtimeModels.defaultProfileId);
  runtimeSnapshotLoaded = true;
}

function requestFabricState({ force = false } = {}) {
  if (!force && runtimeSnapshotLoaded) return Promise.resolve();
  if (runtimeSnapshotRequest) {
    if (force) runtimeSnapshotForcePending = true;
    return runtimeSnapshotRequest;
  }
  runtimeSnapshotRequest = api.runtimeSnapshot.get({ force })
    .then((snapshot) => {
      applyRuntimeSnapshot(snapshot);
      document.getElementById('dashboard-notice').hidden = true;
    })
    .catch((error) => {
      const notice = document.getElementById('dashboard-notice');
      notice.hidden = false;
      notice.textContent = `运行状态读取失败：${String(error?.message || error)}`;
    })
    .finally(() => {
      runtimeSnapshotRequest = null;
      if (runtimeSnapshotForcePending) {
        runtimeSnapshotForcePending = false;
        queueMicrotask(() => requestFabricState({ force: true }));
      }
    });
  return runtimeSnapshotRequest;
}

function applyTheme(theme, { persist = true } = {}) {
  const normalized = ['light', 'dark'].includes(theme) ? theme : 'system';
  document.documentElement.dataset.theme = normalized === 'system' ? '' : normalized;
  document.getElementById('theme-select').value = normalized;
  if (persist) localStorage.setItem('magic-pointer-theme', normalized);
  if (typeof api.setTheme === 'function') api.setTheme(normalized);
}

function filterSidebar(value) {
  const query = String(value || '').trim().toLocaleLowerCase();
  document.querySelectorAll('.primary-nav .nav-item').forEach((button) => {
    const visible = !query || button.textContent.toLocaleLowerCase().includes(query);
    button.classList.toggle('is-filtered-out', !visible);
  });
}

function renderCommandResults(value = '') {
  const query = String(value || '').trim().toLocaleLowerCase();
  const items = Array.from(document.querySelectorAll('.primary-nav .nav-item'))
    .filter((button) => !query || button.textContent.toLocaleLowerCase().includes(query))
    .map((button) => {
      const result = document.createElement('button');
      result.type = 'button';
      result.className = 'command-result';
      const icon = button.querySelector('svg').cloneNode(true);
      const label = document.createElement('span');
      label.textContent = button.textContent.trim();
      const key = document.createElement('kbd');
      key.textContent = '↵';
      result.append(icon, label, key);
      result.addEventListener('click', () => {
        setActiveView(button.dataset.viewTarget);
        closeCommandPalette();
      });
      return result;
    });
  commandResults.replaceChildren(...items);
}

function openCommandPalette() {
  commandPalette.hidden = false;
  commandSearch.value = '';
  renderCommandResults();
  requestAnimationFrame(() => commandSearch.focus());
}

function closeCommandPalette() {
  commandPalette.hidden = true;
  document.getElementById('command-palette-trigger').focus();
}

function lines(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function valuesFromLines(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function formatCaptureModeRules(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.entries(value).map(([pattern, mode]) => `${pattern}=${mode}`).join('\n');
}

function parseCaptureModeRules(value) {
  const rules = {};
  valuesFromLines(value).forEach((line, index) => {
    const separator = line.indexOf('=');
    if (separator <= 0 || separator === line.length - 1) {
      throw new Error(`第 ${index + 1} 行捕获规则应为 pattern=mode`);
    }
    const pattern = line.slice(0, separator).trim();
    const mode = line.slice(separator + 1).trim();
    if (!pattern || !mode) throw new Error(`第 ${index + 1} 行捕获规则不完整`);
    rules[pattern] = mode;
  });
  return rules;
}

const captureModeOptions = [
  ['follow_global', '跟随默认'],
  ['structured_only', '只读结构 · UIA / AX / DOM'],
  ['local_ocr', '允许本机 OCR'],
  ['local_screenshot', '允许本地截图'],
  ['upload_screenshot', '允许截图外发'],
  ['deny', '永不捕获'],
];

function serializedCaptureModeRules() {
  return Array.from(document.querySelectorAll('[data-app-policy-row]')).flatMap((row) => {
    const pattern = row.querySelector('[data-app-pattern]').value.trim();
    const mode = row.querySelector('[data-app-mode]').value;
    return pattern ? [`${pattern}=${mode}`] : [];
  }).join('\n');
}

function syncCaptureModeRules() {
  document.getElementById('app-capture-modes').value = serializedCaptureModeRules();
}

function createAppPolicyRow(pattern = '', mode = 'structured_only') {
  const row = document.createElement('div');
  row.className = 'app-policy-row';
  row.dataset.appPolicyRow = '';

  const identity = document.createElement('label');
  identity.className = 'app-policy-identity';
  const mark = document.createElement('span');
  mark.className = 'app-policy-mark';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#icon-apps');
  icon.append(use);
  mark.append(icon);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = pattern;
  input.placeholder = '例如 1Password.exe 或 Outlook';
  input.autocomplete = 'off';
  input.dataset.appPattern = '';
  input.setAttribute('aria-label', '应用进程名或窗口标题');
  identity.append(mark, input);

  const select = document.createElement('select');
  select.dataset.appMode = '';
  select.setAttribute('aria-label', '捕获层级');
  captureModeOptions.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  });
  select.value = captureModeOptions.some(([value]) => value === mode) ? mode : 'structured_only';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'app-policy-remove';
  remove.setAttribute('aria-label', '移除应用规则');
  const removeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const removeUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  removeUse.setAttribute('href', '#icon-close');
  removeIcon.append(removeUse);
  remove.append(removeIcon);
  remove.addEventListener('click', () => {
    row.remove();
    syncCaptureModeRules();
    if (!document.querySelector('[data-app-policy-row]')) renderCaptureModeRules({});
  });
  input.addEventListener('input', syncCaptureModeRules);
  select.addEventListener('change', syncCaptureModeRules);
  row.append(identity, select, remove);
  return row;
}

function renderCaptureModeRules(value) {
  const root = document.getElementById('app-policy-list');
  const entries = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value)
    : [];
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'app-policy-empty';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#icon-shield');
    icon.append(use);
    const copy = document.createElement('span');
    const label = document.createElement('b');
    label.textContent = '尚无应用覆盖规则';
    const detail = document.createElement('small');
    detail.textContent = '所有应用使用上方默认捕获方式；敏感应用列表仍会强制降级。';
    copy.append(label, detail);
    empty.append(icon, copy);
    root.replaceChildren(empty);
  } else {
    root.replaceChildren(...entries.map(([pattern, mode]) => createAppPolicyRow(pattern, mode)));
  }
  syncCaptureModeRules();
}

function formatVoiceGlossaries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.entries(value).flatMap(([scope, terms]) => (
    Array.isArray(terms)
      ? terms.map((term) => `${scope} | ${term}`)
      : []
  )).join('\n');
}

function parseVoiceGlossaries(value) {
  const glossaries = {};
  valuesFromLines(value).forEach((line, index) => {
    const separator = line.indexOf('|');
    if (separator <= 0 || separator === line.length - 1) {
      throw new Error(`第 ${index + 1} 行项目术语应为 scope | term`);
    }
    const scope = line.slice(0, separator).trim();
    const term = line.slice(separator + 1).trim();
    if (!scope || !term) throw new Error(`第 ${index + 1} 行项目术语不完整`);
    if (!glossaries[scope]) glossaries[scope] = [];
    glossaries[scope].push(term);
  });
  return glossaries;
}

function formatPermissionScopes(value) {
  if (!Array.isArray(value)) return '';
  return value.map((scope) => [
    scope.decision || 'confirm',
    scope.recipe || '*',
    scope.app || '',
    scope.project || '',
    scope.risk || '*',
    scope.expires_at || '',
  ].join(' | ')).join('\n');
}

function parsePermissionScopes(value) {
  return valuesFromLines(value).map((line, index) => {
    const parts = line.split('|').map((item) => item.trim());
    if (parts.length > 6 || !['allow', 'confirm', 'deny'].includes(parts[0])) {
      throw new Error(`第 ${index + 1} 行作用域授权格式错误`);
    }
    return {
      id: '',
      decision: parts[0],
      recipe: parts[1] || '*',
      app: parts[2] || '',
      project: parts[3] || '',
      risk: parts[4] || '*',
      expires_at: parts[5] || '',
    };
  });
}

function setValue(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  if (element.type === 'checkbox') element.checked = value === true;
  else element.value = value ?? '';
}

function applySettings(value) {
  settings = structuredClone(value);
  const general = settings.general || {};
  const notifications = settings.notifications || {};
  const activation = settings.activation || {};
  const interaction = settings.interaction || {};
  const privacy = settings.privacy || {};
  const permissions = settings.permissions || {};
  const agents = settings.agents || {};
  const shortcuts = settings.shortcuts || {};
  const appearance = settings.appearance || {};
  const accessibility = settings.accessibility || {};
  const connections = settings.connections || {};
  setValue('launch-at-login', general.launch_at_login === true);
  setValue('keep-running', general.keep_running !== false);
  setValue('completion-notifications', false);
  setValue('failure-notifications', false);
  setValue('update-channel', 'stable');
  setValue('wake-mode', activation.wake_mode || 'wiggle_hotkey');
  setValue('wiggle-enabled', activation.wiggle_enabled);
  setValue('wiggle-sensitivity', Math.round(Number(activation.sensitivity || .55) * 100));
  setValue('gesture-arm-delay', activation.gesture_arm_delay_ms ?? 180);
  setValue('gesture-timeout', activation.gesture_timeout_ms ?? 5000);
  setValue('multi-stroke-submit', activation.multi_stroke_submit_ms ?? 10000);
  setValue('gesture-interaction-mode', activation.gesture_interaction_mode || 'exclusive_overlay');
  setValue('gesture-line-style', appearance.gesture_line_style || 'demo6_band');
  setValue('gesture-line-width', appearance.gesture_line_width_dip ?? 40);
  setValue('default-input-mode', interaction.default_input_mode || 'voice');
  setValue('voice-engine', interaction.voice_engine || 'auto');
  setValue('voice-start-strategy', interaction.voice_start_strategy || 'auto');
  setValue('voice-auto-submit', interaction.voice_auto_submit !== false);
  setValue('voice-language', interaction.voice_language || 'auto');
  setValue('voice-output-mode', interaction.voice_output_mode || 'verbatim');
  setValue('voice-punctuation', interaction.voice_punctuation || 'verbatim');
  setValue('voice-script', interaction.voice_script || 'unchanged');
  setValue('voice-mixed-spacing', interaction.voice_mixed_spacing || 'preserve');
  setValue('voice-hallucination-guard', interaction.voice_hallucination_guard !== false);
  setValue('voice-silence-ms', interaction.voice_silence_ms || 1600);
  setValue('voice-resident-enabled', interaction.voice_resident_enabled !== false);
  setValue('voice-memory-limit-mb', interaction.voice_memory_limit_mb || 1024);
  setValue('voice-idle-unload-seconds', Number.isInteger(interaction.voice_idle_unload_ms) ? Math.round(interaction.voice_idle_unload_ms / 1000) : 0);
  setValue('voice-glossaries', formatVoiceGlossaries(interaction.voice_glossaries));
  setValue('fallback-hotkey-enabled', activation.fallback_hotkey_enabled);
  setValue('fallback-hotkey', shortcuts.wake || activation.fallback_hotkey);
  setValue('keep-current-app-focus', activation.keep_current_app_focus !== false);
  setValue('dashboard-focus-after-action', false);
  setValue('mouse-side-button', activation.mouse_side_button || 'none');
  setValue('shortcut-wake', shortcuts.wake || activation.fallback_hotkey || 'Control+Alt+M');
  setValue('shortcut-text-mode', shortcuts.text_mode || 'Control+Alt+T');
  setValue('shortcut-voice-mode', shortcuts.voice_mode || 'Control+Alt+V');
  setValue('shortcut-pause', shortcuts.pause || 'Control+Alt+P');
  setValue('disabled-apps', lines(activation.disabled_apps));
  setValue('upload-screenshots', privacy.upload_screenshots);
  setValue('default-capture-mode', privacy.default_capture_mode || 'follow_global');
  setValue('app-capture-modes', formatCaptureModeRules(privacy.app_capture_modes));
  renderCaptureModeRules(privacy.app_capture_modes);
  setValue('retain-captures-days', privacy.retain_captures_days);
  setValue('retain-artifacts-days', privacy.retain_artifacts_days);
  setValue('retain-audit-days', privacy.retain_audit_days);
  setValue('sensitive-apps', lines(privacy.sensitive_apps));
  setValue('anonymous-usage', false);
  setValue('permission-read', permissions.default_read);
  setValue('permission-write', permissions.default_write);
  setValue('permission-send', permissions.default_send);
  setValue('permission-destructive', permissions.default_destructive);
  setValue('permission-purchase', permissions.default_purchase);
  setValue('permission-scopes', formatPermissionScopes(permissions.scoped_grants));
  setValue('preferred-agent', agents.preferred || 'pi');
  setValue('agent-delivery-mode', agents.delivery_mode || 'active_session');
  setValue('agent-cwd-match', agents.cwd_match || 'strict');
  setValue('agent-auto-attach', agents.auto_attach !== false);
  setValue('agent-image-policy', agents.image_policy || 'vision_only');
  renderAgentSessions(agentSessions);
  setValue('theme-select', appearance.theme || 'system');
  setValue('appearance-material', appearance.material || 'auto');
  setValue('selection-visual', appearance.selection_visual || 'sweep_band');
  setValue('sweep-height-ratio', appearance.sweep_height_ratio ?? 0.52);
  setValue('sweep-min-height', appearance.sweep_min_height_dip ?? 10);
  setValue('sweep-max-height', appearance.sweep_max_height_dip ?? 24);
  setValue('sweep-duration', appearance.sweep_duration_ms ?? 292);
  setValue('sweep-fade', appearance.sweep_fade_ms ?? 96);
  setValue('capsule-spawn', appearance.capsule_spawn_ms ?? 417);
  setValue('capsule-expand', appearance.capsule_expand_ms ?? 292);
  setValue('capsule-voice-width', appearance.capsule_voice_width_dip ?? 40);
  setValue('capsule-text-width', appearance.capsule_text_width_dip ?? 144);
  setValue('capsule-max-width', appearance.capsule_max_width_dip ?? 440);
  setValue('capsule-inline-gap', appearance.capsule_inline_gap_dip ?? 18);
  setValue('reduce-motion', accessibility.reduce_motion === true);
  setValue('reduce-transparency', accessibility.reduce_transparency === true);
  setValue('high-contrast-controls', accessibility.high_contrast_controls === true);
  setValue('browser-devtools-enabled', connections.browser_devtools_enabled !== false);
  setValue('browser-cdp-endpoints', lines(connections.browser_devtools_endpoints || ['http://127.0.0.1:9222']));
  document.documentElement.dataset.reduceMotion = accessibility.reduce_motion ? 'true' : 'false';
  document.documentElement.dataset.reduceTransparency = accessibility.reduce_transparency ? 'true' : 'false';
  document.documentElement.dataset.highContrast = accessibility.high_contrast_controls ? 'true' : 'false';
  applyTheme(appearance.theme || 'system', { persist: false });
  document.getElementById('sensitivity-value').textContent = `${Math.round(Number(activation.sensitivity || .55) * 100)}%`;
  document.getElementById('diag-wiggle').textContent = activation.wiggle_enabled ? '已启用' : '已关闭';
}

function collectSettings() {
  if (!settings) return null;
  const next = structuredClone(settings);
  next.general = { ...(next.general || {}) };
  next.general.launch_at_login = document.getElementById('launch-at-login').checked;
  next.general.keep_running = document.getElementById('keep-running').checked;
  next.general.update_channel = 'stable';
  next.notifications = { ...(next.notifications || {}) };
  next.notifications.completion = false;
  next.notifications.failure = false;
  next.activation = { ...(next.activation || {}) };
  next.activation.wake_mode = document.getElementById('wake-mode').value || 'wiggle_hotkey';
  next.activation.wiggle_enabled = ['wiggle', 'wiggle_hotkey'].includes(next.activation.wake_mode);
  next.activation.sensitivity = Number(document.getElementById('wiggle-sensitivity').value) / 100;
  next.activation.gesture_arm_delay_ms = Number(document.getElementById('gesture-arm-delay').value);
  next.activation.gesture_timeout_ms = Number(document.getElementById('gesture-timeout').value);
  next.activation.multi_stroke_submit_ms = Number(document.getElementById('multi-stroke-submit').value);
  next.activation.keep_current_app_focus = document.getElementById('keep-current-app-focus').checked;
  next.activation.dashboard_focus_after_action = false;
  next.activation.mouse_side_button = document.getElementById('mouse-side-button').value || 'none';
  next.interaction = { ...(next.interaction || {}) };
  next.interaction.default_input_mode = document.getElementById('default-input-mode').value === 'text' ? 'text' : 'voice';
  next.interaction.voice_engine = document.getElementById('voice-engine').value || 'auto';
  next.interaction.voice_start_strategy = document.getElementById('voice-start-strategy').value || 'auto';
  next.interaction.voice_auto_submit = document.getElementById('voice-auto-submit').checked;
  next.interaction.voice_language = document.getElementById('voice-language').value || 'auto';
  next.interaction.voice_output_mode = document.getElementById('voice-output-mode').value || 'verbatim';
  next.interaction.voice_punctuation = document.getElementById('voice-punctuation').value || 'verbatim';
  next.interaction.voice_script = document.getElementById('voice-script').value || 'unchanged';
  next.interaction.voice_mixed_spacing = document.getElementById('voice-mixed-spacing').value || 'preserve';
  next.interaction.voice_hallucination_guard = document.getElementById('voice-hallucination-guard').checked;
  next.interaction.voice_silence_ms = Number(document.getElementById('voice-silence-ms').value);
  next.interaction.voice_resident_enabled = document.getElementById('voice-resident-enabled').checked;
  next.interaction.voice_memory_limit_mb = Number(document.getElementById('voice-memory-limit-mb').value);
  next.interaction.voice_idle_unload_ms = Number(document.getElementById('voice-idle-unload-seconds').value) * 1000;
  next.interaction.voice_glossaries = parseVoiceGlossaries(document.getElementById('voice-glossaries').value);
  next.activation.fallback_hotkey_enabled = ['wiggle_hotkey', 'hotkey'].includes(next.activation.wake_mode);
  next.activation.disabled_apps = valuesFromLines(document.getElementById('disabled-apps').value);
  next.shortcuts = { ...(next.shortcuts || {}) };
  next.shortcuts.wake = document.getElementById('shortcut-wake').value.trim();
  next.shortcuts.text_mode = document.getElementById('shortcut-text-mode').value.trim();
  next.shortcuts.voice_mode = document.getElementById('shortcut-voice-mode').value.trim();
  next.shortcuts.pause = document.getElementById('shortcut-pause').value.trim();
  next.activation.fallback_hotkey = next.shortcuts.wake;
  next.privacy.upload_screenshots = document.getElementById('upload-screenshots').checked;
  next.privacy.default_capture_mode = document.getElementById('default-capture-mode').value || 'follow_global';
  next.privacy.app_capture_modes = parseCaptureModeRules(serializedCaptureModeRules());
  next.privacy.retain_captures_days = Number(document.getElementById('retain-captures-days').value);
  next.privacy.retain_artifacts_days = Number(document.getElementById('retain-artifacts-days').value);
  next.privacy.retain_audit_days = Number(document.getElementById('retain-audit-days').value);
  next.privacy.sensitive_apps = valuesFromLines(document.getElementById('sensitive-apps').value);
  next.privacy.anonymous_usage = false;
  next.activation.gesture_interaction_mode = document.getElementById('gesture-interaction-mode').value || 'exclusive_overlay';
  next.permissions.default_read = document.getElementById('permission-read').value;
  next.permissions.default_write = document.getElementById('permission-write').value;
  next.permissions.default_send = document.getElementById('permission-send').value;
  next.permissions.default_destructive = document.getElementById('permission-destructive').value;
  next.permissions.default_purchase = document.getElementById('permission-purchase').value;
  next.permissions.scoped_grants = parsePermissionScopes(document.getElementById('permission-scopes').value);
  next.agents.preferred = document.getElementById('preferred-agent').value || 'pi';
  next.agents.delivery_mode = document.getElementById('agent-delivery-mode').value || 'active_session';
  next.agents.cwd_match = document.getElementById('agent-cwd-match').value || 'strict';
  next.agents.image_policy = document.getElementById('agent-image-policy').value || 'vision_only';
  next.agents.auto_attach = document.getElementById('agent-auto-attach').checked;
  next.agents.session_bindings = { ...(next.agents.session_bindings || {}) };
  const selectedSession = document.getElementById('agent-session-binding').value;
  if (selectedSession) next.agents.session_bindings[next.agents.preferred] = selectedSession;
  else delete next.agents.session_bindings[next.agents.preferred];
  next.appearance = { ...(next.appearance || {}) };
  next.appearance.theme = document.getElementById('theme-select').value || 'system';
  next.appearance.material = document.getElementById('appearance-material').value || 'auto';
  next.appearance.selection_visual = document.getElementById('selection-visual').value || 'sweep_band';
  next.appearance.sweep_height_ratio = Number(document.getElementById('sweep-height-ratio').value);
  next.appearance.sweep_min_height_dip = Number(document.getElementById('sweep-min-height').value);
  next.appearance.sweep_max_height_dip = Number(document.getElementById('sweep-max-height').value);
  next.appearance.sweep_duration_ms = Number(document.getElementById('sweep-duration').value);
  next.appearance.sweep_fade_ms = Number(document.getElementById('sweep-fade').value);
  next.appearance.capsule_spawn_ms = Number(document.getElementById('capsule-spawn').value);
  next.appearance.capsule_expand_ms = Number(document.getElementById('capsule-expand').value);
  next.appearance.capsule_voice_width_dip = Number(document.getElementById('capsule-voice-width').value);
  next.appearance.capsule_text_width_dip = Number(document.getElementById('capsule-text-width').value);
  next.appearance.capsule_max_width_dip = Number(document.getElementById('capsule-max-width').value);
  next.appearance.capsule_inline_gap_dip = Number(document.getElementById('capsule-inline-gap').value);
  next.appearance.gesture_line_style = document.getElementById('gesture-line-style').value || 'demo6_band';
  next.appearance.gesture_line_width_dip = Number(document.getElementById('gesture-line-width').value);
  next.accessibility = { ...(next.accessibility || {}) };
  next.accessibility.reduce_motion = document.getElementById('reduce-motion').checked;
  next.accessibility.reduce_transparency = document.getElementById('reduce-transparency').checked;
  next.accessibility.high_contrast_controls = document.getElementById('high-contrast-controls').checked;
  next.connections = { ...(next.connections || {}) };
  next.connections.browser_devtools_enabled = document.getElementById('browser-devtools-enabled').checked;
  next.connections.browser_devtools_endpoints = valuesFromLines(document.getElementById('browser-cdp-endpoints').value);
  next.recipe_enabled = { ...(next.recipe_enabled || {}) };
  document.querySelectorAll('[data-recipe-enabled]').forEach((toggle) => {
    next.recipe_enabled[toggle.dataset.recipeEnabled] = toggle.checked;
  });
  return next;
}

function saveFabricSettings() {
  let next = null;
  try {
    next = collectSettings();
  } catch (error) {
    saveState.textContent = error.message || '捕获规则格式错误';
    return;
  }
  if (!next) return;
  settingsBeforeSave = structuredClone(settings);
  saveState.textContent = '正在保存…';
  api.saveFabricSettings(next);
}

function renderProviders(items) {
  providers = Array.isArray(items) ? items : [];
  const root = document.getElementById('provider-list');
  const rows = providers.map((provider) => {
    const row = document.createElement('article');
    row.className = 'provider-row';
    const name = document.createElement('strong');
    name.className = 'provider-name';
    name.textContent = provider.name || provider.id;
    const protocols = document.createElement('span');
    protocols.className = 'provider-protocols';
    protocols.textContent = `${(provider.protocols || []).join(' · ')}${provider.version ? ` / ${provider.version}` : ''}`;
    const state = document.createElement('b');
    state.className = `provider-state ${provider.available ? 'is-ready' : 'is-missing'}`;
    const sessionCount = agentSessions.filter((item) => item.provider === provider.id).length;
    state.textContent = provider.available ? `${sessionCount} 个会话` : '未安装';
    state.title = provider.available ? provider.executable || '' : provider.installHint || provider.reason || '';
    row.append(name, protocols, state);
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
  const availableCount = providers.filter((item) => item.available).length;
  document.getElementById('diag-agents').textContent = `${availableCount}/${providers.length}`;
  document.getElementById('runtime-dot').classList.toggle('is-ready', providers.length > 0);
  document.getElementById('runtime-label').textContent = providers.length > 0 ? '本机服务已连接' : '正在连接';
  if (agentContexts.length) renderAgentContexts(agentContexts);
}

function sessionTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replaceAll('/', '-');
}

function renderAgentSessions(items = agentSessions) {
  agentSessions = Array.isArray(items) ? items : [];
  const preferred = document.getElementById('preferred-agent').value || settings?.agents?.preferred || 'pi';
  const candidates = agentSessions.filter((item) => item.provider === preferred);
  const boundId = settings?.agents?.session_bindings?.[preferred] || '';
  const binding = document.getElementById('agent-session-binding');
  const emptyOption = document.createElement('option');
  emptyOption.value = '';
  emptyOption.textContent = candidates.length ? '未绑定（仅唯一候选可自动附着）' : '当前项目没有可恢复会话';
  const options = candidates.map((session) => {
    const option = document.createElement('option');
    option.value = session.sessionId;
    option.textContent = `${session.provider} · ${String(session.sessionId).slice(0, 12)} · ${sessionTime(session.lastActiveAt)}`;
    return option;
  });
  binding.replaceChildren(emptyOption, ...options);
  binding.value = candidates.some((item) => item.sessionId === boundId) ? boundId : '';

  const rows = agentSessions.map((session) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'agent-session-row';
    row.dataset.provider = session.provider;
    if (session.provider === preferred && session.sessionId === binding.value) row.classList.add('is-selected');
    const identity = document.createElement('span');
    identity.className = 'agent-session-identity';
    const name = document.createElement('b');
    name.textContent = `${session.provider} · ${String(session.sessionId).slice(0, 12)}`;
    const cwd = document.createElement('small');
    cwd.textContent = session.cwd;
    cwd.title = session.cwd;
    identity.append(name, cwd);
    const transport = document.createElement('span');
    transport.className = 'agent-session-transport';
    transport.textContent = session.transport;
    const activity = document.createElement('span');
    activity.className = `agent-session-state is-${session.state === 'recent' ? 'recent' : 'resumable'}`;
    activity.textContent = `${session.state === 'recent' ? '最近活动' : '可恢复'} · ${sessionTime(session.lastActiveAt)}`;
    row.append(identity, transport, activity);
    row.addEventListener('click', () => {
      document.getElementById('preferred-agent').value = session.provider;
      if (!settings.agents.session_bindings) settings.agents.session_bindings = {};
      settings.agents.session_bindings[session.provider] = session.sessionId;
      renderAgentSessions(agentSessions);
      document.getElementById('agent-session-status').textContent =
        `已绑定 ${session.provider} / ${String(session.sessionId).slice(0, 12)}；保存后交付只会恢复此会话。`;
    });
    return row;
  });
  const root = document.getElementById('agent-session-list');
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '当前 cwd 没有扫描到 Codex、Pi、Claude 或 Gemini 的已有会话。';
    root.replaceChildren(empty);
  } else root.replaceChildren(...rows);
  document.getElementById('agent-session-status').textContent =
    `扫描到 ${agentSessions.length} 个 cwd 匹配会话；只读取 ID、路径和更新时间。`;
  if (providers.length) renderProviders(providers);
}

function renderAgentContexts(items = agentContexts) {
  agentContexts = Array.isArray(items) ? items : [];
  const root = document.getElementById('agent-context-list');
  if (!agentContexts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '尚无已密封现场；首次把指向对象交给 Agent 后会出现在这里。';
    root.replaceChildren(empty);
    return;
  }
  const available = providers.filter((provider) => (
    provider.available && ['codex', 'pi', 'claude', 'gemini'].includes(provider.id)
  ));
  const rows = agentContexts.map((context) => {
    const row = document.createElement('article');
    row.className = 'agent-context-row';
    const identity = document.createElement('div');
    identity.className = 'agent-context-identity';
    const name = document.createElement('strong');
    name.textContent = `${context.recipeId || 'agent.handoff'} · ${Number(context.objectCount || 0)} 个对象`;
    const digest = document.createElement('small');
    digest.textContent = `packet ${String(context.contextPacketId || '').slice(0, 16)} · ${String(context.contextPacketDigest || '').slice(0, 12)}`;
    identity.append(name, digest);
    const history = document.createElement('span');
    history.className = 'agent-context-history';
    history.textContent = (context.deliveries || [])
      .map((delivery) => `${delivery.provider}:${delivery.status}`)
      .join(' → ') || '尚未投递';
    const target = document.createElement('select');
    target.className = 'agent-context-provider';
    target.setAttribute('aria-label', '切换后的执行者');
    available.forEach((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.name || provider.id;
      target.append(option);
    });
    const nextProvider = available.find((provider) => !(context.providers || []).includes(provider.id)) || available[0];
    if (nextProvider) target.value = nextProvider.id;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'button button-secondary agent-context-action';
    action.disabled = !nextProvider;
    action.textContent = armedAgentContextId === context.contextId ? '确认切换并发送' : '切换执行者';
    action.addEventListener('click', () => {
      if (armedAgentContextId !== context.contextId) {
        armedAgentContextId = context.contextId;
        document.getElementById('agent-context-status').textContent =
          `将把同一密封现场发送给 ${target.value}；再次点击确认。不会重新采集或改写对象。`;
        renderAgentContexts(agentContexts);
        return;
      }
      armedAgentContextId = '';
      fabricRequest('agent.context.dispatch', {
        contextId: context.contextId,
        provider: target.value,
        confirmed: true,
      });
    });
    row.append(identity, history, target, action);
    return row;
  });
  root.replaceChildren(...rows);
}

function selectedModelId() {
  return String(document.getElementById('model-id').value || '').trim().toLowerCase();
}

function modelProfileFromForm() {
  const id = selectedModelId();
  const displayName = String(document.getElementById('model-display-name').value || '').trim();
  const provider = String(document.getElementById('model-provider').value || '').trim().toLowerCase();
  const baseUrl = String(document.getElementById('model-base-url').value || '').trim();
  const model = String(document.getElementById('model-name').value || '').trim();
  const apiMode = String(document.getElementById('model-api-mode').value || '').trim();
  if (!id || !displayName || !provider || !model || !apiMode) throw new Error('请填写 Profile ID、名称、Provider、Model 与 API mode。');
  return {
    schemaVersion: 1,
    id,
    displayName,
    provider,
    baseUrl,
    model,
    apiMode,
    credentialRef: `credential:model:${id}`,
    enabled: true,
    overrides: {
      visionInput: document.getElementById('model-vision-override').value || 'auto',
      audioInput: 'auto',
      toolCalls: 'auto',
    },
    resolved: { visionInput: 'unknown', audioInput: 'unknown', toolCalls: 'unknown', source: 'unknown', evidence: '', checkedAt: '' },
  };
}

function applyModelToForm(profile) {
  if (!profile) return;
  setValue('model-id', profile.id);
  setValue('model-display-name', profile.displayName);
  setValue('model-provider', profile.provider);
  setValue('model-base-url', profile.baseUrl);
  setValue('model-name', profile.model);
  setValue('model-api-mode', profile.apiMode);
  setValue('model-vision-override', profile.overrides?.visionInput || 'auto');
  setValue('model-credential-value', '');
  document.getElementById('model-status').textContent = `已选择 ${profile.displayName || profile.id}。凭据不会读回到界面。`;
  document.getElementById('model-default-badge').textContent = profile.id === defaultModelProfileId ? '默认模型' : '已选择';
}

function modelCapabilityEvidence(resolved = {}) {
  const sourceLabels = {
    manual_override: '手动指定',
    explicit_probe: '显式测试',
    provider_metadata: '服务元数据',
    dated_catalog: '版本目录',
    unknown: '无证据',
  };
  const source = sourceLabels[resolved.source] || '未知来源';
  if (!resolved.checkedAt) return source;
  const checkedAt = new Date(resolved.checkedAt);
  if (Number.isNaN(checkedAt.getTime())) return source;
  const stamp = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(checkedAt).replaceAll('/', '-');
  return `${source} · ${stamp}`;
}

function renderModels(items, defaultProfileId = null) {
  models = Array.isArray(items) ? items : [];
  defaultModelProfileId = defaultProfileId || null;
  const root = document.getElementById('model-list');
  if (!models.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '尚未配置模型。可添加本地或云端 Profile；未知视觉能力会自动仅走结构化文本。';
    root.replaceChildren(empty);
    document.getElementById('model-default-badge').textContent = '未配置';
    return;
  }
  if (!models.some((profile) => profile.id === selectedModelId())) {
    applyModelToForm(models.find((profile) => profile.id === defaultModelProfileId) || models[0]);
  }
  const rows = models.map((profile) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'model-row';
    if (profile.id === selectedModelId()) row.classList.add('is-selected');
    const identity = document.createElement('span');
    identity.className = 'model-identity';
    const name = document.createElement('strong');
    name.textContent = profile.displayName || profile.id;
    const id = document.createElement('small');
    id.textContent = profile.id;
    identity.append(name, id);
    const meta = document.createElement('span');
    meta.className = 'model-meta';
    meta.textContent = `${profile.provider} / ${profile.model} / ${profile.apiMode}`;
    const capability = document.createElement('span');
    capability.className = 'model-capability';
    const vision = profile.resolved?.visionInput || 'unknown';
    capability.classList.add(`is-${vision === 'yes' || vision === 'no' ? vision : 'unknown'}`);
    capability.textContent = `视觉 ${vision === 'yes' ? '支持' : vision === 'no' ? '不支持' : '未确认'} · ${modelCapabilityEvidence(profile.resolved)}`;
    capability.title = `能力来源：${profile.resolved?.source || 'unknown'}；最近检查：${profile.resolved?.checkedAt || '未测试'}`;
    const defaultLabel = document.createElement('span');
    defaultLabel.className = 'model-default';
    defaultLabel.textContent = profile.id === defaultModelProfileId ? '默认' : '';
    row.append(identity, meta, capability, defaultLabel);
    row.addEventListener('click', () => {
      applyModelToForm(profile);
      renderModels(models, defaultModelProfileId);
      fabricRequest('models.credentials.status', { profileId: profile.id });
    });
    return row;
  });
  root.replaceChildren(...rows);
  const currentProfile = models.find((profile) => profile.id === selectedModelId());
  document.getElementById('model-default-badge').textContent = currentProfile
    ? (currentProfile.id === defaultModelProfileId ? '默认模型' : '已选择')
    : `${models.length} 个 Profile`;
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
    const capability = recipe.runtimeCapability || {};
    const capabilityState = String(capability.state || 'unknown');
    const availability = document.createElement('span');
    availability.className = `state ${capabilityState === 'ready' ? 'state-ready' : capabilityState === 'unknown' ? 'state-muted' : 'state-warn'}`;
    availability.textContent = {
      ready: '可执行',
      needs_setup: '需设置',
      needs_agent: '需 Agent',
      experimental: '实验性',
      blocked: '已阻止',
      unavailable: '不可用',
      unknown: '未验证',
    }[capabilityState] || '未验证';
    availability.title = `${capability.reason || 'runtime_snapshot_missing'} · ${capability.evidence?.engineProvider || 'provider_unknown'}`;
    const risk = document.createElement('span');
    risk.className = 'risk';
    risk.dataset.risk = recipe.risk;
    risk.textContent = {
      read: '读取',
      local_write: '写入',
      external_send: '外发',
      destructive: '破坏性',
      purchase: '付款',
    }[recipe.risk] || '读取';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.dataset.recipeEnabled = recipe.id;
    enabled.checked = settings?.recipe_enabled?.[recipe.id] !== false;
    enabled.title = enabled.checked ? '已启用' : '已禁用';
    enabled.addEventListener('change', () => {
      if (settings) settings.recipe_enabled[recipe.id] = enabled.checked;
      enabled.title = enabled.checked ? '已启用' : '已禁用';
    });
    controls.append(availability, risk, enabled);
    row.append(copy, controls);
    return row;
  });
  document.getElementById('recipe-list').replaceChildren(...rows);
  document.getElementById('diag-recipes').textContent = String(recipes.length || 0);
}

function candidateStateCopy(candidate) {
  const state = String(candidate?.state || 'candidate_disabled');
  return state === 'installed_disabled' ? '已安装 · 默认禁用' : '候选草稿 · 默认禁用';
}

function renderSkillDraft(draft) {
  const panel = document.getElementById('skill-draft-panel');
  const detail = draft && typeof draft === 'object' ? draft : {};
  const candidate = detail.candidate || {};
  const content = String(detail.content || '');
  const candidateId = String(candidate.candidateId || '');
  const reviewToken = String(detail.reviewToken || '');
  if (candidateId && reviewToken) {
    reviewedSkillDraftTokens.set(candidateId, reviewToken);
    armedSkillCandidateId = '';
    renderSkillCandidates(skillCandidates);
  }
  panel.hidden = false;
  if (!content) {
    const empty = document.createElement('p');
    empty.className = 'skill-draft-empty';
    empty.textContent = '草稿不可读；未显示推测内容。';
    panel.replaceChildren(empty);
    return;
  }
  const head = document.createElement('div');
  head.className = 'skill-draft-head';
  const title = document.createElement('strong');
  title.textContent = `${candidate.name || 'Skill'} · SKILL.md`;
  const digest = document.createElement('small');
  digest.textContent = `SHA-256 ${String(detail.sha256 || candidate.draftSha256 || '').slice(0, 16)}`;
  head.append(title, digest);
  const code = document.createElement('pre');
  code.className = 'skill-draft-content';
  code.textContent = content;
  panel.replaceChildren(head, code);
}

function renderSkillCandidates(items = skillCandidates) {
  skillCandidates = Array.isArray(items) ? items : [];
  const root = document.getElementById('skill-candidate-list');
  if (!skillCandidates.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy skill-candidate-empty';
    empty.textContent = '尚无候选 Skill。相同、已验证的工作流累计三次后才会出现。';
    root.replaceChildren(empty);
    return;
  }
  const rows = skillCandidates.map((candidate) => {
    const row = document.createElement('article');
    row.className = 'skill-candidate-row';
    row.dataset.state = String(candidate.state || 'candidate_disabled');
    row.setAttribute('data-skill-candidate-id', String(candidate.candidateId || ''));
    const identity = document.createElement('div');
    identity.className = 'skill-candidate-identity';
    const name = document.createElement('strong');
    name.textContent = String(candidate.name || candidate.candidateId || 'Skill');
    const detail = document.createElement('small');
    const count = Number(candidate.occurrenceCount || candidate.sourceReceiptIds?.length || 0);
    const kinds = Array.isArray(candidate.objectKinds) && candidate.objectKinds.length
      ? candidate.objectKinds.join(' · ')
      : 'grounded_object';
    detail.textContent = `${candidate.recipeId || 'workflow'} · ${count} 次来源执行 · ${kinds}`;
    identity.append(name, detail);
    const state = document.createElement('span');
    state.className = 'skill-candidate-state';
    state.textContent = candidateStateCopy(candidate);
    const controls = document.createElement('div');
    controls.className = 'skill-candidate-controls';
    const draft = document.createElement('button');
    draft.type = 'button';
    draft.className = 'secondary-button compact-button';
    draft.textContent = '查看草稿';
    draft.addEventListener('click', () => {
      const panel = document.getElementById('skill-draft-panel');
      panel.hidden = false;
      panel.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'skill-draft-empty',
        textContent: '正在读取本地 SKILL.md…',
      }));
      fabricRequest('skills.candidates.draft', { candidateId: candidate.candidateId });
    });
    const install = document.createElement('button');
    install.type = 'button';
    install.className = 'button button-secondary compact-button';
    const armed = armedSkillCandidateId === candidate.candidateId;
    const reviewToken = reviewedSkillDraftTokens.get(String(candidate.candidateId || '')) || '';
    install.textContent = candidate.state === 'installed_disabled'
      ? '已安装（禁用）'
      : !reviewToken ? '先查看草稿' : armed ? '确认安装（保持禁用）' : '安装草稿';
    install.disabled = candidate.state === 'installed_disabled' || !reviewToken;
    install.addEventListener('click', () => {
      if (candidate.state === 'installed_disabled') return;
      if (!armed) {
        fabricRequest('skills.candidates.install', {
          candidateId: candidate.candidateId,
          reviewToken,
          confirmed: false,
        });
        return;
      }
      fabricRequest('skills.candidates.install', {
        candidateId: candidate.candidateId,
        reviewToken,
        confirmed: true,
      });
    });
    controls.append(draft, install);
    row.append(identity, state, controls);
    return row;
  });
  root.replaceChildren(...rows);
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
  paused_target_mismatch: '目标已变化 · 等待重新确认',
};

function renderAgentTasks(items) {
  agentTasks = Array.isArray(items) ? items : [];
  const root = document.getElementById('agent-task-list');
  if (!agentTasks.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '尚无持有目标租约的 Agent 任务。';
    root.replaceChildren(empty);
    return;
  }
  const rows = agentTasks.map((task) => {
    const row = document.createElement('article');
    const status = String(task.status || 'unknown');
    row.className = 'agent-task-row';
    row.dataset.status = status;
    row.setAttribute('data-task-id', String(task.taskId || ''));
    const identity = document.createElement('div');
    identity.className = 'agent-task-identity';
    const name = document.createElement('strong');
    name.textContent = `${task.provider || 'agent'} · ${String(task.taskId || '').slice(0, 12)}`;
    const detail = document.createElement('small');
    const guard = task.targetLease || {};
    const lease = guard.lease || {};
    const windowTitle = String(lease?.window?.title || '无窗口目标');
    detail.textContent = `${windowTitle} · attempt ${Number(task.attempt || 1)}`;
    identity.append(name, detail);
    const state = document.createElement('b');
    state.className = 'agent-task-state';
    state.textContent = status;
    const reason = document.createElement('span');
    reason.className = 'agent-task-reason';
    reason.textContent = guard.reason
      ? `已暂停：${guard.reason}`
      : guard.state === 'active'
        ? `租约有效 · revision ${Number(lease.revision || 1)}`
        : '无目标租约';
    row.append(identity, reason, state);
    if (status === 'paused_target_mismatch') {
      const reconfirm = document.createElement('button');
      reconfirm.type = 'button';
      reconfirm.className = 'button button-secondary agent-task-reconfirm';
      const armed = reconfirmArmedTaskId === task.taskId;
      reconfirm.textContent = armed ? '确认当前桌面的目标' : '重新确认目标';
      reconfirm.addEventListener('click', () => {
        if (reconfirmArmedTaskId !== task.taskId) {
          reconfirmArmedTaskId = task.taskId;
          document.getElementById('agent-task-status').textContent =
            '请先切回包含原目标的桌面，再次点击“确认当前桌面的目标”。匹配不唯一时不会恢复。';
          renderAgentTasks(agentTasks);
          return;
        }
        reconfirmArmedTaskId = '';
        fabricRequest('task.reconfirm_target', {
          taskId: task.taskId,
          confirmed: true,
        });
      });
      row.append(reconfirm);
    }
    return row;
  });
  root.replaceChildren(...rows);
}

function jumpToProvenanceTarget(kind, id) {
  const attribute = kind === 'task' ? 'data-task-id' : 'data-artifact-id';
  const target = [...document.querySelectorAll(`[${attribute}]`)]
    .find((item) => item.getAttribute(attribute) === String(id || ''));
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('is-provenance-target');
  window.requestAnimationFrame(() => target.classList.add('is-provenance-target'));
  window.setTimeout(() => target.classList.remove('is-provenance-target'), 1800);
}

function renderProvenanceObjects(items) {
  provenanceObjects = Array.isArray(items) ? items : [];
  const root = document.getElementById('provenance-object-list');
  if (!provenanceObjects.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '尚无可反查的屏幕对象。执行一次基于指向对象的能力后，这里会建立本地来源链。';
    root.replaceChildren(empty);
    document.getElementById('provenance-trace-panel').hidden = true;
    return;
  }
  const buttons = provenanceObjects.map((object) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'provenance-object-chip';
    button.dataset.objectId = String(object.objectId || '');
    const label = document.createElement('strong');
    label.textContent = String(object.label || object.referenceLabel || object.objectId || '对象');
    const meta = document.createElement('small');
    meta.textContent = `${object.kind || 'object'} · ${String(object.objectId || '').slice(0, 12)}`;
    button.append(label, meta);
    button.addEventListener('click', () => {
      root.querySelectorAll('.provenance-object-chip').forEach((item) => {
        item.dataset.selected = String(item === button);
      });
      const panel = document.getElementById('provenance-trace-panel');
      panel.hidden = false;
      panel.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'provenance-loading',
        textContent: '正在读取本地来源链…',
      }));
      fabricRequest('provenance.trace', { objectId: object.objectId });
    });
    return button;
  });
  root.replaceChildren(...buttons);
}

function renderProvenanceTrace(trace = {}) {
  const panel = document.getElementById('provenance-trace-panel');
  const object = trace.object || {};
  const source = object.source || {};
  const plans = Array.isArray(trace.plans) ? trace.plans : [];
  const tasks = Array.isArray(trace.tasks) ? trace.tasks : [];
  const artifacts = Array.isArray(trace.artifacts) ? trace.artifacts : [];
  panel.hidden = false;

  const head = document.createElement('div');
  head.className = 'provenance-trace-head';
  const identity = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = `${object.referenceLabel ? `${object.referenceLabel} · ` : ''}${object.label || object.objectId || '对象'}`;
  const meta = document.createElement('small');
  const bbox = Array.isArray(object.bbox) ? object.bbox.join(', ') : '未记录';
  meta.textContent = `${object.kind || 'object'} · ${source.app || '未知应用'} · ${source.title || '未知窗口'} · bbox ${bbox}`;
  identity.append(title, meta);
  const count = document.createElement('span');
  count.className = 'provenance-count';
  count.textContent = `${plans.length} 计划 · ${tasks.length} task · ${artifacts.length} 产物`;
  head.append(identity, count);

  const columns = document.createElement('div');
  columns.className = 'provenance-trace-columns';
  const makeColumn = (name, values, render) => {
    const column = document.createElement('section');
    column.className = 'provenance-trace-column';
    const heading = document.createElement('h3');
    heading.textContent = name;
    const body = document.createElement('div');
    body.className = 'provenance-link-list';
    if (!values.length) {
      const empty = document.createElement('small');
      empty.className = 'provenance-link-empty';
      empty.textContent = '无关联记录';
      body.append(empty);
    } else {
      values.forEach((value) => body.append(render(value)));
    }
    column.append(heading, body);
    return column;
  };
  columns.append(
    makeColumn('计划与回执', plans, (plan) => {
      const row = document.createElement('div');
      row.className = 'provenance-link-row';
      const label = document.createElement('strong');
      label.textContent = String(plan.recipeId || plan.planId || 'plan');
      const detail = document.createElement('small');
      detail.textContent = `${String(plan.planId || '').slice(0, 12)} · ${plan.status || 'unknown'}`;
      row.append(label, detail);
      return row;
    }),
    makeColumn('Agent tasks', tasks, (task) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'provenance-link-button';
      button.setAttribute('data-task-id', String(task.taskId || ''));
      const label = document.createElement('strong');
      label.textContent = `${task.provider || 'agent'} · ${task.status || 'unknown'}`;
      const detail = document.createElement('small');
      detail.textContent = String(task.taskId || '');
      button.append(label, detail);
      button.addEventListener('click', () => jumpToProvenanceTarget('task', task.taskId));
      return button;
    }),
    makeColumn('补丁、页面与产物', artifacts, (artifact) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'provenance-link-button';
      button.setAttribute('data-artifact-id', String(artifact.artifactId || ''));
      const label = document.createElement('strong');
      label.textContent = `${artifact.linkKind || 'artifact'} · ${artifact.state || 'unknown'}`;
      const detail = document.createElement('small');
      detail.textContent = String(artifact.path || artifact.artifactId || '');
      button.append(label, detail);
      button.addEventListener('click', () => jumpToProvenanceTarget('artifact', artifact.artifactId));
      return button;
    }),
  );
  panel.replaceChildren(head, columns);
}

function renderWorkflowTasks(items) {
  workflowTasks = Array.isArray(items) ? items : [];
  const root = document.getElementById('workflow-task-list');
  if (!workflowTasks.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '尚无可从 CLI 或 GUI 继续的持久任务。';
    root.replaceChildren(empty);
    return;
  }
  const rows = workflowTasks.map((workflow) => {
    const row = document.createElement('article');
    row.className = 'workflow-task-row';
    row.dataset.status = String(workflow.status || 'unknown');

    const identity = document.createElement('div');
    identity.className = 'workflow-task-identity';
    const title = document.createElement('strong');
    title.textContent = String(workflow.title || workflow.recipeId || '任务');
    const taskId = document.createElement('small');
    taskId.textContent = `task ${workflow.taskId}`;
    identity.append(title, taskId);

    const surfaces = document.createElement('span');
    surfaces.className = 'workflow-task-surfaces';
    surfaces.textContent = (workflow.surfaceHistory || []).map((surface) => String(surface).toUpperCase()).join(' → ') || 'GUI';

    const state = document.createElement('b');
    state.className = 'workflow-task-state';
    state.textContent = `${workflow.approvalState || 'unknown'} · ${workflow.status || 'unknown'}`;
    row.append(identity, surfaces, state);

    if (workflow.approvalState === 'pending') {
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'button button-secondary workflow-task-action';
      approve.textContent = '批准此任务';
      approve.addEventListener('click', () => {
        fabricRequest('workflow.approve', {
          surface: 'gui',
          taskId: workflow.taskId,
          confirmed: true,
        });
      });
      row.append(approve);
    } else if (!['succeeded', 'failed', 'denied', 'verification_failed'].includes(String(workflow.status || ''))) {
      const execute = document.createElement('button');
      execute.type = 'button';
      execute.className = 'button button-primary workflow-task-action';
      execute.textContent = workflow.status === 'running' ? '执行中' : '继续执行';
      execute.disabled = workflow.status === 'running';
      execute.addEventListener('click', () => {
        fabricRequest('workflow.execute', {
          surface: 'gui',
          taskId: workflow.taskId,
        });
      });
      row.append(execute);
    }
    return row;
  });
  root.replaceChildren(...rows);
}

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
      const planId = String(data.planId || '');
      const index = planId
        ? open.findIndex((item) => String(item.planned?.data?.planId || '') === planId)
        : open.findLastIndex((item) => {
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
    if (entry.raw.type === 'perception.resolved') row.classList.add('perception-event');
    if (entry.raw.type === 'terminal.evidence') row.classList.add('terminal-event');
    if (entry.raw.type === 'browser.evidence') row.classList.add('browser-event');
    const time = document.createElement('span');
    time.className = 'activity-time';
    time.textContent = activityTimestamp(entry.raw);
    const type = document.createElement('strong');
    type.className = 'activity-type';
    const perception = entry.raw.type === 'perception.resolved'
      ? (entry.raw.data || {})
      : null;
    const terminal = entry.raw.type === 'terminal.evidence'
      ? (entry.raw.data || {})
      : null;
    const browser = entry.raw.type === 'browser.evidence'
      ? (entry.raw.data || {})
      : null;
    const layerLabels = { native_app: '应用原生', dom: 'DOM', uia: 'UIA', ax: 'AX', ocr: '本机 OCR', screen_region: '局部像素' };
    type.textContent = browser
      ? '浏览器证据'
      : terminal
      ? '终端证据'
      : perception
      ? `感知层 · ${layerLabels[perception.selectedLayer] || '未解析'}`
      : (entry.raw.type || 'event');
    const data = document.createElement('span');
    data.className = 'activity-data';
    data.textContent = browser
      ? `${browser.state === 'resolved' ? 'DOM 命中' : '部分证据'} · selector ${browser.selectorObserved ? '已验证' : '缺失'} · 可访问名称 ${browser.accessibleNameObserved ? '已读取' : '缺失'} · ${Number(browser.networkFailureCount || 0)} 个网络失败 · ${browser.coordinatesObserved ? '坐标已映射' : '坐标缺失'}`
      : terminal
      ? `${terminal.state === 'resolved' ? '结构化错误块' : '部分证据'} · ${terminal.exitCodeObserved ? `exit ${terminal.exitCode}` : '退出码未知'} · ${Number(terminal.windowLineCount || 0)} 行相关日志 · 未使用 OCR`
      : perception
      ? (perception.pixelFallbackUsed
        ? `局部截图兜底 · ${perception.fallbackReason || '结构不可用'} · ${perception.policyMode || '默认策略'}`
        : `结构读取成功 · 未使用截图 · ${perception.selectedMethod || perception.fallbackReason || '无可用结构'}`)
      : JSON.stringify(entry.raw.data || {});
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
  if (planned?.workspaceBindingState) {
    const bound = planned.workspaceBindingState === 'bound';
    const bindingText = bound
      ? `已绑定运行进程 · ${planned.workspaceBindingRelation || 'process'}${planned.workspaceProcessBound ? ' · workspace PID 已验证' : ''}`
      : planned.workspaceBindingState === 'bound_no_repo'
        ? `已绑定运行进程 · 未检测到 Git 仓库 · ${planned.workspaceBindingRelation || 'process'}`
        : '运行目标未解析 · 当前 cwd 仅作未验证回退';
    stages.append(timelineStage('工作区', bound ? 'is-done' : 'is-pending', bindingText));
  }

  if (planned?.terminalEvidenceState) {
    const terminalResolved = planned.terminalEvidenceState === 'resolved';
    const exitCopy = planned.terminalExitCodeObserved
      ? `exit ${planned.terminalExitCode}`
      : '退出码未知';
    const lineCopy = `${Number(planned.terminalWindowLineCount || 0)} 行相关日志`;
    stages.append(timelineStage(
      '终端',
      terminalResolved ? 'is-done' : 'is-pending',
      `${terminalResolved ? '结构化错误块' : '部分终端证据'} · ${exitCopy} · ${lineCopy} · ${planned.terminalEvidenceMethod || '来源未知'}`,
    ));
  }

  if (planned?.browserEvidenceState) {
    const browserResolved = planned.browserEvidenceState === 'resolved';
    stages.append(timelineStage(
      '浏览器',
      browserResolved ? 'is-done' : 'is-pending',
      `${browserResolved ? 'DOM 节点已命中' : '部分 DevTools 证据'} · selector ${planned.browserSelectorObserved ? '已验证' : '缺失'} · 可访问名称 ${planned.browserAccessibleNameObserved ? '已读取' : '缺失'} · ${Number(planned.browserNetworkFailureCount || 0)} 个网络失败 · ${planned.browserCoordinatesObserved ? '坐标已映射' : '坐标缺失'}`,
    ));
  }

  if (planned?.componentLinkState && planned.componentLinkState !== 'unavailable') {
    const candidateCount = Number(planned.componentCandidateCount || 0);
    const confidence = Number(planned.componentTopConfidence || 0);
    const editAllowed = planned.componentAutoModificationAllowed === true;
    stages.append(timelineStage(
      '组件源码',
      editAllowed ? 'is-done' : 'is-pending',
      `${candidateCount} 个候选 · 最高置信度 ${confidence.toFixed(3)} · ${editAllowed ? '直接源码位置已验证' : '低置信度仅作线索，修改前必须检查'}`,
    ));
  }

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
  const artifactIds = Array.isArray(executed?.artifactIds) ? executed.artifactIds : [];
  if (artifactIds.length) {
    stages.append(timelineStage('产物', 'is-done', artifactIds.join(' · ')));
  }

  article.append(head, stages);
  return article;
}

function renderActivity(items) {
  auditEvents = Array.isArray(items) ? items : [];
  const root = document.getElementById('activity-list');
  if (!auditEvents.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '尚无本地活动。晃动并执行一个能力后，这里会显示脱敏回执。';
    root.replaceChildren(empty);
    return;
  }
  const rows = buildActivityTimeline(auditEvents).reverse().map(renderTimelineEntry);
  root.replaceChildren(...rows);
}

function renderArtifacts(items) {
  artifactRecords = Array.isArray(items) ? items : [];
  const root = document.getElementById('artifact-list');
  if (!artifactRecords.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '尚无受管理的本地产物。';
    root.replaceChildren(empty);
    return;
  }
  const rows = artifactRecords.map((artifact) => {
    const row = document.createElement('article');
    row.className = 'artifact-row';
    row.dataset.state = String(artifact.state || 'unknown');
    row.setAttribute('data-artifact-id', String(artifact.artifactId || ''));
    const identity = document.createElement('div');
    identity.className = 'artifact-identity';
    const code = document.createElement('strong');
    code.textContent = String(artifact.artifactId || 'artifact');
    const relation = document.createElement('small');
    relation.textContent = `${artifact.recipeId || '-'} · plan ${String(artifact.planId || '').slice(0, 8)} · receipt ${String(artifact.receiptId || '').slice(0, 8)}`;
    identity.append(code, relation);
    const location = document.createElement('span');
    location.className = 'artifact-location';
    location.textContent = String(artifact.state === 'trashed' ? artifact.trashPath : artifact.path || '');
    location.title = location.textContent;
    const state = document.createElement('b');
    state.className = 'artifact-state';
    state.textContent = String(artifact.state || 'unknown');
    row.append(identity, location, state);
    if (artifact.state === 'trashed') {
      const restore = document.createElement('button');
      restore.className = 'secondary-button artifact-restore';
      restore.type = 'button';
      restore.textContent = '恢复';
      restore.addEventListener('click', () => {
        fabricRequest('artifacts.restore', {
          artifactId: artifact.artifactId,
          confirmed: true,
        });
      });
      row.append(restore);
    }
    return row;
  });
  root.replaceChildren(...rows);
}

function getPreflightGuidance(stage, state) {
  const action = PREFLIGHT_ACTIONS[String(stage.fixAction || '')];
  if (action) return action;
  if (state === 'pass') return { message: '此项已通过，无需操作。' };
  if (state === 'skipped') return { message: '此项已跳过；相关能力会保持不可用。' };
  if (state === 'pending' || state === 'running') return { message: '检查完成后会在这里显示结果。' };
  if (state === 'warn') return { message: '请查看技术详情，确认是否需要处理。' };
  return { message: '查看技术详情，处理后再次运行全部检查。' };
}

function renderPreflight(preflight) {
  const root = document.getElementById('preflight-list');
  const status = document.getElementById('preflight-status');
  const stages = Array.isArray(preflight?.stages) ? preflight.stages : [];
  const ready = preflight?.ready === true;
  const running = preflight?.running === true;
  status.textContent = running
    ? '正在检查和配置本机环境，请保持此窗口打开。'
    : ready
      ? '所有必要检查已通过。全局唤醒现在可以使用。'
      : '尚未就绪。请按每一项的说明处理后，再次运行全部检查。';
  const rows = stages.map((stage) => {
    const machineState = String(stage.state || 'unknown');
    const action = getPreflightGuidance(stage, machineState);
    const row = document.createElement('article');
    row.className = 'preflight-row';
    row.dataset.state = machineState;

    const head = document.createElement('div');
    head.className = 'preflight-row__head';
    const name = document.createElement('strong');
    name.textContent = stage.title || stage.id || '未命名检查';
    const state = document.createElement('b');
    state.className = 'preflight-state';
    state.textContent = PREFLIGHT_STATE_LABELS[machineState] || PREFLIGHT_STATE_LABELS.unknown;
    head.append(name, state);

    const guidance = document.createElement('p');
    guidance.className = 'preflight-guidance';
    guidance.textContent = action.message;
    row.append(head, guidance);

    if (action.targetView) {
      const actionButton = document.createElement('button');
      actionButton.className = 'button button-secondary preflight-action';
      actionButton.type = 'button';
      actionButton.textContent = action.label;
      actionButton.addEventListener('click', () => setActiveView(action.targetView));
      row.append(actionButton);
    }

    const evidence = document.createElement('details');
    evidence.className = 'preflight-evidence';
    const evidenceSummary = document.createElement('summary');
    evidenceSummary.textContent = `技术详情 · ${Number(stage.durationMs || 0)} ms`;
    const evidenceCopy = document.createElement('code');
    evidenceCopy.textContent = stage.evidence || '无附加证据';
    evidence.append(evidenceSummary, evidenceCopy);
    row.append(evidence);
    return row;
  });
  root.replaceChildren(...rows);
}

function setPreflightProgress(percent, currentStep = '') {
  const progress = document.getElementById('preflight-progress');
  const fill = document.getElementById('preflight-progress-fill');
  const value = document.getElementById('preflight-progress-value');
  const current = document.getElementById('preflight-current-step');
  const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  progress.hidden = false;
  progress.setAttribute('aria-valuenow', String(safePercent));
  fill.style.width = `${safePercent}%`;
  value.textContent = `${safePercent}%`;
  if (currentStep) current.textContent = currentStep;
}

function requestPreflight({ automatic = false } = {}) {
  if (preflightRunning) return;
  preflightRunning = true;
  const button = document.getElementById('preflight-run');
  button.disabled = true;
  button.textContent = automatic ? '正在自动配置…' : '正在检查…';
  document.getElementById('preflight-status').textContent = '正在运行本地检查…';
  setPreflightProgress(0, '准备检查本机环境…');
  fabricRequest('preflight.run');
}

function renderPreflightEvent(event = {}) {
  if (event.type === 'manifest') {
    preflightStageOrder = Array.isArray(event.stages) ? event.stages.map((stage) => stage.id) : [];
    preflightStages.clear();
    for (const stage of event.stages || []) preflightStages.set(stage.id, { ...stage, state: 'pending' });
    renderPreflight({ running: true, stages: preflightStageOrder.map((id) => preflightStages.get(id)) });
    setPreflightProgress(0, '正在读取本机配置…');
    return;
  }
  if (event.type === 'stage') {
    const previous = preflightStages.get(event.id) || {};
    preflightStages.set(event.id, { ...previous, ...event });
    const title = event.title || previous.title || event.id || '当前项目';
    renderPreflight({ running: true, stages: preflightStageOrder.map((id) => preflightStages.get(id)) });
    if (event.state === 'running') setPreflightProgress(
      Number(document.getElementById('preflight-progress').getAttribute('aria-valuenow') || 0),
      `正在检查：${title}`,
    );
    return;
  }
  if (event.type === 'progress') {
    const completed = event.completedStageId ? preflightStages.get(event.completedStageId) : null;
    setPreflightProgress(event.percent, completed ? `已完成：${completed.title}` : '正在准备…');
    return;
  }
  if (event.type === 'complete') {
    preflightRunning = false;
    renderPreflight(event);
    setPreflightProgress(100, event.ready ? 'Magic Pointer 已准备完成' : '部分项目需要处理');
    const button = document.getElementById('preflight-run');
    button.disabled = false;
    button.textContent = '重新检查';
    return;
  }
  if (event.type === 'error') {
    preflightRunning = false;
    const button = document.getElementById('preflight-run');
    button.disabled = false;
    button.textContent = '重试';
    document.getElementById('preflight-status').textContent = '初始化没有完成，请重试或查看技术详情。';
  }
}

function handleFabricState(payload = {}) {
  const operation = payload.fabricOperation;
  if (!payload.ok) {
    if (operation === 'skills.candidates.draft' || operation === 'skills.candidates.install') {
      armedSkillCandidateId = '';
      if (operation === 'skills.candidates.install') reviewedSkillDraftTokens.clear();
      const panel = document.getElementById('skill-draft-panel');
      panel.hidden = false;
      panel.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'skill-draft-empty skill-draft-error',
        textContent: payload.error || '本地 Skill 操作失败；未安装或启用任何内容。',
      }));
      renderSkillCandidates(skillCandidates);
      return;
    }
    if (operation === 'provenance.trace') {
      const panel = document.getElementById('provenance-trace-panel');
      panel.hidden = false;
      const failure = document.createElement('p');
      failure.className = 'provenance-error';
      failure.textContent = payload.error || '来源链不存在或已损坏；未显示推测关系。';
      panel.replaceChildren(failure);
      return;
    }
    if (operation === 'agent.context.dispatch') {
      armedAgentContextId = '';
      document.getElementById('agent-context-status').textContent =
        payload.error || '目标 Agent 未接收同一 Context Pack；没有伪造任务。';
      fabricRequest('agent.contexts.list', { limit: 100 });
      return;
    }
    if (operation === 'browser.status') {
      const state = document.getElementById('browser-bridge-state');
      state.className = 'state state-warn';
      state.textContent = '检测失败';
      document.getElementById('browser-bridge-detail').textContent = payload.error || '无法读取本机 DevTools 状态';
      return;
    }
    if (operation === 'settings.save' && settingsBeforeSave) {
      applySettings(settingsBeforeSave);
      settingsBeforeSave = null;
      saveState.dataset.tone = 'error';
      saveState.textContent = payload.error || '保存失败，已恢复上次设置';
      return;
    }
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
    if (operation === 'settings.save') settingsBeforeSave = null;
    delete saveState.dataset.tone;
    const failedHotkeys = Object.entries(payload.hotkeys || {})
      .filter(([, result]) => result && result.registered === false && result.disabled !== true)
      .map(([name]) => name);
    if (failedHotkeys.length) {
      saveState.dataset.tone = 'error';
      saveState.textContent = `设置已保存；${failedHotkeys.length} 个快捷键冲突`;
      document.getElementById('shortcut-status').textContent = `无法注册：${failedHotkeys.join('、')}。请录制其他组合键。`;
    } else {
      saveState.textContent = operation === 'settings.save' ? '已保存 · 设置已立即生效' : '';
      document.getElementById('shortcut-status').textContent = '快捷键已注册。';
    }
    if (operation === 'settings.save') fabricRequest('browser.status');
  } else if (operation === 'catalog') renderRecipes(payload.recipes);
  else if (operation === 'skills.candidates.list') renderSkillCandidates(payload.candidates || payload.items);
  else if (operation === 'skills.candidates.draft') renderSkillDraft(payload.draft || payload);
  else if (operation === 'skills.candidates.install') {
    const install = payload.install || payload;
    const candidate = install.candidate || {};
    if (install.status === 'confirmation_required') {
      armedSkillCandidateId = String(candidate.candidateId || '');
      renderSkillCandidates(skillCandidates);
      const panel = document.getElementById('skill-draft-panel');
      panel.hidden = false;
      panel.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'skill-draft-empty',
        textContent: '请再次点击确认安装。安装后仍保持禁用，不会自动接入任何 Agent。',
      }));
    } else {
      reviewedSkillDraftTokens.delete(String(candidate.candidateId || ''));
      armedSkillCandidateId = '';
      renderSkillCandidates(skillCandidates);
      fabricRequest('skills.candidates.list', { limit: 100 });
      const panel = document.getElementById('skill-draft-panel');
      panel.hidden = false;
      panel.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'skill-draft-empty',
        textContent: 'SKILL.md 已安装为禁用状态；未启用、未投递给 Agent。',
      }));
    }
  }
  else if (operation === 'providers') renderProviders(payload.providers);
  else if (operation === 'agent.sessions') renderAgentSessions(payload.sessions);
  else if (operation === 'agent.contexts.list') renderAgentContexts(payload.contexts);
  else if (operation === 'agent.context.dispatch') {
    const dispatch = payload.dispatch || {};
    document.getElementById('agent-context-status').textContent = dispatch.accepted
      ? `同一 Context Pack 已交给 ${dispatch.provider}；task ${dispatch.taskId || 'unknown'} 正在运行，尚未完成。`
      : 'Agent 未确认接收；没有伪造任务。';
    fabricRequest('agent.contexts.list', { limit: 100 });
    fabricRequest('task.list', { limit: 100 });
  }
  else if (operation === 'browser.status') {
    const state = document.getElementById('browser-bridge-state');
    const detail = document.getElementById('browser-bridge-detail');
    const configured = Number(payload.configuredEndpointCount || 0);
    const reachable = Number(payload.reachableEndpointCount || 0);
    const pages = Number(payload.pageCount || 0);
    if (payload.state === 'available') {
      state.className = 'state state-ready';
      state.textContent = '已连接';
      detail.textContent = `${reachable}/${configured} 个本机端点可达 · ${pages} 个页面目标`;
    } else if (payload.state === 'disabled') {
      state.className = 'state state-muted';
      state.textContent = '已关闭';
      detail.textContent = '结构读取已由设置关闭；浏览器目标将回退到 UIA。';
    } else {
      state.className = 'state state-warn';
      state.textContent = '未连接';
      detail.textContent = `0/${configured} 个本机端点可达 · 启动 remote debugging 后重新检测`;
    }
  }
  else if (operation === 'models.list') renderModels(payload.models, payload.defaultProfileId);
  else if (operation === 'models.save') {
    document.getElementById('model-status').textContent = 'Profile 已保存。可单独保存凭据或测试连接。';
    fabricRequest('models.list');
  } else if (operation === 'models.delete') {
    document.getElementById('model-status').textContent = 'Profile 已删除；凭据如不再使用，请单独清除。';
    fabricRequest('models.list');
  } else if (operation === 'models.set_default') {
    document.getElementById('model-status').textContent = '默认模型已更新。';
    fabricRequest('models.list');
  } else if (operation === 'models.test') {
    const vision = String(payload.visionInput || 'unknown');
    const capabilityCopy = vision === 'yes' ? '支持图片' : vision === 'no' ? '不支持图片' : '图片能力未确认';
    document.getElementById('model-status').textContent =
      `连接成功 · ${capabilityCopy} · ${String(payload.evidence?.checkedAt || '')}`;
    fabricRequest('models.list');
  } else if (operation === 'models.credentials.status') {
    const credential = payload.credential || {};
    document.getElementById('model-status').textContent = credential.present
      ? '系统凭据库中已有该 Profile 的凭据。'
      : '该 Profile 尚未保存凭据。';
  } else if (operation === 'models.credentials.set') {
    document.getElementById('model-credential-value').value = '';
    document.getElementById('model-status').textContent = '凭据已写入系统凭据库。';
  } else if (operation === 'models.credentials.delete') {
    document.getElementById('model-status').textContent = '凭据已清除。';
  }
  else if (operation === 'preflight.run') renderPreflight(payload.preflight);
  else if (operation === 'audit.tail') renderActivity(payload.events);
  else if (operation === 'artifacts.list') renderArtifacts(payload.artifacts);
  else if (operation === 'task.list') renderAgentTasks(payload.tasks);
  else if (operation === 'workflow.list') renderWorkflowTasks(payload.workflows);
  else if (operation === 'provenance.objects') renderProvenanceObjects(payload.objects);
  else if (operation === 'provenance.trace') renderProvenanceTrace(payload.trace);
  else if (operation === 'workflow.approve' || operation === 'workflow.execute') {
    fabricRequest('workflow.list', { surface: 'gui', limit: 100 });
    fabricRequest('audit.tail', { limit: 120 });
    fabricRequest('artifacts.list', { limit: 120 });
  }
  else if (operation === 'task.reconfirm_target') {
    const task = payload.task || {};
    document.getElementById('agent-task-status').textContent = task.status === 'queued'
      ? '目标已重新确认；任务以新租约和新 attempt 恢复。'
      : `重新确认状态：${task.status || 'unknown'}`;
    fabricRequest('task.list', { limit: 100 });
  }
  else if (operation === 'artifacts.cleanup') {
    const cleanup = payload.cleanup || {};
    const button = document.getElementById('artifact-cleanup');
    const status = document.getElementById('artifact-cleanup-status');
    if (cleanup.status === 'confirmation_required') {
      const count = Number(cleanup.candidateCount || 0);
      artifactCleanupArmed = count > 0;
      button.textContent = count > 0 ? `确认移入回收区（${count}）` : '没有过期产物';
      status.textContent = count > 0
        ? `将移动 ${count} 个已过期、由 Magic Pointer 管理的产物；仍可恢复。`
        : '当前没有达到留存期限的产物。';
    } else {
      artifactCleanupArmed = false;
      button.textContent = '预览过期清理';
      status.textContent = `已移入回收区 ${Number((cleanup.trashedArtifactIds || []).length)} 个；未找到 ${Number((cleanup.missingArtifactIds || []).length)} 个。`;
      fabricRequest('artifacts.list', { limit: 120 });
    }
  } else if (operation === 'artifacts.restore') {
    artifactCleanupArmed = false;
    document.getElementById('artifact-cleanup').textContent = '预览过期清理';
    document.getElementById('artifact-cleanup-status').textContent = '产物已恢复，并重新开始计算本地留存期。';
    fabricRequest('artifacts.list', { limit: 120 });
  }
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

setActiveView('activation');
api.onFabricState(handleFabricState);
api.onPreflightEvent(renderPreflightEvent);
api.runtimeSnapshot.onChanged(() => requestFabricState({ force: true }));
api.onVoiceResidencyStatus((payload = {}) => {
  const node = document.getElementById('voice-resident-status');
  if (!node) return;
  const labels = { unloaded: '未加载', warming: '预热中', ready: '就绪', recording: '录音中', releasing: '释放中', error: '错误', disabled: '已关闭' };
  node.textContent = `状态由本地运行时回传：${labels[payload.state] || '未加载'}${payload.errorCode ? `（${payload.errorCode}）` : ''}`;
});
api.onShow((payload = {}) => {
  if (payload.view === 'calendar') {
    setActiveView('calendar');
    if (payload.calendarDraft) applyCalendarDraft(payload.calendarDraft);
  } else if (payload.view === 'route') {
    setActiveView('route');
    if (payload.routeDraft) applyRouteDraft(payload.routeDraft);
  } else if (payload.view) {
    setActiveView(payload.view);
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
document.querySelectorAll('[data-view-jump]').forEach((button) => {
  button.addEventListener('click', () => setActiveView(button.dataset.viewJump));
});
document.getElementById('settings-save').addEventListener('click', saveFabricSettings);
document.getElementById('browser-status-refresh').addEventListener('click', () => fabricRequest('browser.status'));
document.getElementById('app-policy-add').addEventListener('click', () => {
  const root = document.getElementById('app-policy-list');
  const empty = root.querySelector('.app-policy-empty');
  if (empty) empty.remove();
  const row = createAppPolicyRow('', 'structured_only');
  root.append(row);
  row.querySelector('[data-app-pattern]').focus();
});
document.getElementById('providers-refresh').addEventListener('click', () => {
  fabricRequest('providers');
  fabricRequest('agent.sessions', { cwdMatch: document.getElementById('agent-cwd-match').value || 'strict' });
  fabricRequest('agent.contexts.list', { limit: 100 });
});
document.getElementById('sessions-refresh').addEventListener('click', () => {
  fabricRequest('agent.sessions', { cwdMatch: document.getElementById('agent-cwd-match').value || 'strict' });
});
document.getElementById('preferred-agent').addEventListener('change', () => renderAgentSessions(agentSessions));
document.getElementById('agent-cwd-match').addEventListener('change', () => {
  fabricRequest('agent.sessions', { cwdMatch: document.getElementById('agent-cwd-match').value || 'strict' });
});
document.getElementById('agent-session-binding').addEventListener('change', (event) => {
  const provider = document.getElementById('preferred-agent').value || 'pi';
  if (!settings.agents.session_bindings) settings.agents.session_bindings = {};
  if (event.target.value) settings.agents.session_bindings[provider] = event.target.value;
  else delete settings.agents.session_bindings[provider];
  renderAgentSessions(agentSessions);
});
document.getElementById('preflight-run').addEventListener('click', () => {
  requestPreflight();
});
document.getElementById('models-refresh').addEventListener('click', () => fabricRequest('models.list'));
document.getElementById('model-new').addEventListener('click', () => {
  for (const id of ['model-id', 'model-display-name', 'model-provider', 'model-base-url', 'model-name', 'model-credential-value']) {
    setValue(id, '');
  }
  setValue('model-api-mode', 'chat-completions');
  setValue('model-vision-override', 'auto');
  document.getElementById('model-default-badge').textContent = '新 Profile';
  document.getElementById('model-status').textContent = '填写连接信息后保存。视觉能力未知时默认只发送结构化文本。';
  renderModels(models, defaultModelProfileId);
  document.getElementById('model-display-name').focus();
});
document.getElementById('model-save').addEventListener('click', () => {
  try {
    const profile = modelProfileFromForm();
    fabricRequest('models.save', { profile });
  } catch (error) {
    document.getElementById('model-status').textContent = error.message || 'Profile 格式无效。';
  }
});
document.getElementById('model-credential-save').addEventListener('click', () => {
  const profileId = selectedModelId();
  const credentialValue = document.getElementById('model-credential-value').value;
  if (!profileId || !credentialValue) {
    document.getElementById('model-status').textContent = '先保存 Profile，再输入要存入系统凭据库的 key。';
    return;
  }
  fabricRequest('models.credentials.set', { profileId, credentialValue });
});
document.getElementById('model-test').addEventListener('click', () => {
  const profileId = selectedModelId();
  if (!profileId) return;
  document.getElementById('model-status').textContent = '正在测试文本连接…';
  fabricRequest('models.test', { profileId });
});
document.getElementById('model-set-default').addEventListener('click', () => {
  const profileId = selectedModelId();
  if (profileId) fabricRequest('models.set_default', { profileId });
});
document.getElementById('model-delete').addEventListener('click', () => {
  const profileId = selectedModelId();
  if (profileId && window.confirm(`删除 Profile ${profileId}？此操作不会自动清除凭据。`)) {
    fabricRequest('models.delete', { profileId });
  }
});
document.getElementById('activity-refresh').addEventListener('click', () => {
  fabricRequest('audit.tail', { limit: 120 });
  fabricRequest('artifacts.list', { limit: 120 });
  fabricRequest('task.list', { limit: 100 });
  fabricRequest('workflow.list', { surface: 'gui', limit: 100 });
  fabricRequest('provenance.objects', { limit: 200 });
});
document.getElementById('artifact-cleanup').addEventListener('click', () => {
  fabricRequest('artifacts.cleanup', { confirmed: artifactCleanupArmed });
});
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
document.getElementById('dashboard-refresh').addEventListener('click', () => {
  requestFabricState({ force: true });
  window.magicPointerDashboard.requestState();
});
document.getElementById('dashboard-close').addEventListener('click', () => api.hide());
document.getElementById('theme-select').addEventListener('change', (event) => applyTheme(event.target.value));
document.getElementById('wake-mode').addEventListener('change', (event) => {
  const mode = event.target.value;
  document.getElementById('wiggle-enabled').checked = ['wiggle', 'wiggle_hotkey'].includes(mode);
  document.getElementById('fallback-hotkey-enabled').checked = ['wiggle_hotkey', 'hotkey'].includes(mode);
});
for (const id of ['reduce-motion', 'reduce-transparency', 'high-contrast-controls']) {
  document.getElementById(id).addEventListener('change', () => {
    document.documentElement.dataset.reduceMotion = document.getElementById('reduce-motion').checked ? 'true' : 'false';
    document.documentElement.dataset.reduceTransparency = document.getElementById('reduce-transparency').checked ? 'true' : 'false';
    document.documentElement.dataset.highContrast = document.getElementById('high-contrast-controls').checked ? 'true' : 'false';
  });
}
function acceleratorFromKeyboardEvent(event) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  let key = event.code || event.key;
  if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
  else if (/^Digit[0-9]$/.test(key)) key = key.slice(5);
  else if (/^Arrow/.test(key)) key = key.slice(5);
  if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(key)) return '';
  if (!modifiers.length || !key) return '';
  return [...modifiers, key].join('+');
}
document.querySelectorAll('.hotkey-recorder').forEach((input) => {
  let previousValue = input.value;
  input.addEventListener('pointerdown', () => {
    previousValue = input.value;
    input.value = '请按新的组合键…';
    input.classList.add('is-recording');
  });
  input.addEventListener('keydown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      input.value = previousValue;
      input.classList.remove('is-recording');
      input.blur();
      return;
    }
    const accelerator = acceleratorFromKeyboardEvent(event);
    if (!accelerator) return;
    input.value = accelerator;
    input.classList.remove('is-recording');
    if (input.id === 'shortcut-wake') document.getElementById('fallback-hotkey').value = accelerator;
    if (input.id === 'fallback-hotkey') document.getElementById('shortcut-wake').value = accelerator;
    document.getElementById('shortcut-status').textContent = '快捷键已录制；保存后立即应用。';
    input.blur();
  });
  input.addEventListener('blur', () => {
    if (input.classList.contains('is-recording')) input.value = previousValue;
    input.classList.remove('is-recording');
  });
});
document.getElementById('sidebar-search').addEventListener('input', (event) => filterSidebar(event.target.value));
document.getElementById('sidebar-search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const first = document.querySelector('.primary-nav .nav-item:not(.is-filtered-out)');
  if (first) {
    setActiveView(first.dataset.viewTarget);
    event.currentTarget.value = '';
    filterSidebar('');
  }
});
document.getElementById('command-palette-trigger').addEventListener('click', openCommandPalette);
document.querySelector('.palette-backdrop').addEventListener('click', closeCommandPalette);
commandSearch.addEventListener('input', (event) => renderCommandResults(event.target.value));
commandSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') commandResults.querySelector('.command-result')?.click();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault();
    if (commandPalette.hidden) openCommandPalette();
    else closeCommandPalette();
    return;
  }
  if (event.key !== 'Escape') return;
  if (!commandPalette.hidden) {
    closeCommandPalette();
    return;
  }
  const openDisclosure = Array.from(document.querySelectorAll('details[open]')).at(-1);
  if (openDisclosure) {
    openDisclosure.open = false;
    return;
  }
  api.hide();
});

document.getElementById('diag-platform').textContent = navigator.platform || 'desktop';
document.documentElement.dataset.platform = navigator.platform.startsWith('Mac')
  ? 'mac'
  : (navigator.platform.startsWith('Linux') ? 'linux' : 'windows');
document.querySelector('.sidebar-search-wrap kbd').textContent = document.documentElement.dataset.platform === 'mac' ? '⌘K' : 'Ctrl K';
applyTheme(localStorage.getItem('magic-pointer-theme') || 'system');
renderProviders([]);
renderRecipes([]);
renderActivity([]);
renderArtifacts([]);
renderState({ items: [] });
renderCalendarState({ events: [] });
requestFabricState();
