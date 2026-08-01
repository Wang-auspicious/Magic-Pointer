const fs = require('fs');
const path = require('path');

const CAPTURE_MODES = new Set([
  'follow_global',
  'structured_only',
  'local_ocr',
  'local_screenshot',
  'upload_screenshot',
  'deny',
]);
const SHORTCUT_MODIFIERS = new Set(['control', 'alt', 'shift', 'super', 'command', 'commandorcontrol']);
const RESERVED_SHORTCUTS = new Set([
  'control+alt+enter',
  'control+alt+shift+m',
  'control+alt+d',
]);

function normalizedShortcut(value) {
  const aliases = { ctrl: 'control', option: 'alt', cmd: 'command', cmdorctrl: 'commandorcontrol' };
  const parts = String(value || '').split('+').map(part => part.trim().toLowerCase()).filter(Boolean);
  if (parts.length < 2) return '';
  const key = aliases[parts.at(-1)] || parts.at(-1);
  const modifiers = parts.slice(0, -1).map(part => aliases[part] || part);
  if (!modifiers.length || modifiers.some(part => !SHORTCUT_MODIFIERS.has(part)) || SHORTCUT_MODIFIERS.has(key)) return '';
  if (new Set(modifiers).size !== modifiers.length) return '';
  const order = ['commandorcontrol', 'command', 'control', 'alt', 'shift', 'super'];
  modifiers.sort((left, right) => order.indexOf(left) - order.indexOf(right));
  return [...modifiers, key].join('+');
}

function defaultSettings() {
  return {
    schema_version: 1,
    general: {
      launch_at_login: false,
      keep_running: true,
      update_channel: 'stable',
    },
    notifications: {
      completion: true,
      failure: true,
    },
    activation: {
      wake_mode: 'wiggle_hotkey',
      wiggle_enabled: true,
      sensitivity: 0.55,
      fallback_hotkey_enabled: true,
      fallback_hotkey: 'Control+Alt+M',
      keep_current_app_focus: true,
      dashboard_focus_after_action: false,
      mouse_side_button: 'none',
      disabled_apps: ['blender', 'krita', 'photoshop', 'premiere', 'davinci resolve', 'unity', 'unreal'],
      cooldown_ms: 900,
      gesture_arm_delay_ms: 180,
      gesture_timeout_ms: 5000,
      multi_stroke_submit_ms: 10000,
      gesture_interaction_mode: 'exclusive_overlay',
    },
    interaction: {
      default_input_mode: 'voice',
      voice_auto_submit: true,
      voice_start_strategy: 'auto',
      voice_silence_ms: 1600,
      voice_language: 'auto',
      voice_output_mode: 'verbatim',
      voice_punctuation: 'verbatim',
      voice_script: 'unchanged',
      voice_mixed_spacing: 'preserve',
      voice_hallucination_guard: true,
      voice_resident_enabled: true,
      voice_engine: 'auto',
      voice_memory_limit_mb: 1024,
      voice_idle_unload_ms: 0, // 0 = keep the voice model resident
      voice_glossaries: {},
    },
    agents: {
      preferred: 'pi',
      profiles: {},
      delivery_mode: 'active_session',
      cwd_match: 'strict',
      image_policy: 'vision_only',
      auto_attach: true,
      session_bindings: {},
    },
    models: { schemaVersion: 1, defaultProfileId: null, profiles: [] },
    permissions: {
      default_read: 'allow',
      default_write: 'confirm',
      default_send: 'confirm',
      default_destructive: 'confirm',
      default_purchase: 'deny',
      recipe_overrides: {},
      scoped_grants: [],
    },
    privacy: {
      upload_screenshots: false,
      default_capture_mode: 'follow_global',
      app_capture_modes: {},
      retain_captures_days: 3,
      retain_artifacts_days: 30,
      retain_audit_days: 30,
      sensitive_apps: ['1password', 'keepass', 'bitwarden', 'wallet', '银行'],
      anonymous_usage: false,
    },
    shortcuts: {
      wake: 'Control+Alt+M',
      text_mode: 'Control+Alt+T',
      voice_mode: 'Control+Alt+V',
      pause: 'Control+Alt+P',
    },
    appearance: {
      theme: 'system',
      material: 'auto',
      selection_visual: 'sweep_band',
      sweep_height_ratio: 0.52,
      sweep_min_height_dip: 10,
      sweep_max_height_dip: 24,
      sweep_duration_ms: 292,
      sweep_fade_ms: 96,
      capsule_spawn_ms: 80,
      capsule_expand_ms: 125,
      capsule_voice_width_dip: 40,
      capsule_text_width_dip: 144,
      capsule_max_width_dip: 440,
      capsule_inline_gap_dip: 18,
      gesture_line_style: 'demo6_band',
      gesture_line_width_dip: 40,
    },
    accessibility: {
      reduce_motion: false,
      reduce_transparency: false,
      high_contrast_controls: false,
    },
    connections: {
      browser_devtools_enabled: true,
      browser_devtools_endpoints: ['http://127.0.0.1:9222'],
    },
    recipe_enabled: {},
  };
}

function validateModels(value, defaults) {
  const models = { ...defaults.models, ...(value || {}) };
  if (models.schemaVersion !== 1 || !Array.isArray(models.profiles) || models.profiles.length > 32) {
    throw new Error('models schemaVersion or profiles is unsupported');
  }
  const profileIds = new Set();
  const capabilityValues = new Set(['yes', 'no', 'unknown']);
  const overrideValues = new Set(['auto', 'yes', 'no']);
  const normalizedProfiles = models.profiles.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1) {
      throw new Error('model profile schemaVersion is unsupported');
    }
    for (const key of Object.keys(raw)) {
      const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
      const containsSecret = ['apikey', 'token', 'secret', 'credential', 'password', 'authorization']
        .some((token) => normalizedKey.includes(token));
      if (containsSecret && normalizedKey !== 'credentialref') {
        throw new Error('credential values must not be stored in model profiles');
      }
    }
    const id = String(raw.id || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || profileIds.has(id)) {
      throw new Error('model profile id is invalid or duplicated');
    }
    profileIds.add(id);
    const provider = String(raw.provider || '').trim().toLowerCase();
    const model = String(raw.model || '').trim();
    const apiMode = String(raw.apiMode || '').trim().toLowerCase();
    if (!provider || !model || !['chat-completions', 'responses', 'messages', 'local'].includes(apiMode)) {
      throw new Error('model profile provider, model, or apiMode is invalid');
    }
    const inputOverrides = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {};
    const inputResolved = raw.resolved && typeof raw.resolved === 'object' ? raw.resolved : {};
    const overrides = Object.fromEntries(['visionInput', 'audioInput', 'toolCalls'].map((name) => {
      const resolved = String(inputOverrides[name] || 'auto').trim().toLowerCase();
      if (!overrideValues.has(resolved)) throw new Error(`model profile override ${name} is invalid`);
      return [name, resolved];
    }));
    const resolved = Object.fromEntries(['visionInput', 'audioInput', 'toolCalls'].map((name) => {
      const capability = String(inputResolved[name] || 'unknown').trim().toLowerCase();
      if (!capabilityValues.has(capability)) throw new Error(`model profile resolved ${name} is invalid`);
      return [name, capability];
    }));
    resolved.source = String(inputResolved.source || 'unknown').trim() || 'unknown';
    resolved.evidence = String(inputResolved.evidence || '').trim();
    resolved.checkedAt = String(inputResolved.checkedAt || '').trim();
    return {
      schemaVersion: 1,
      id,
      displayName: String(raw.displayName || '').trim(),
      provider,
      baseUrl: String(raw.baseUrl || '').trim(),
      model,
      apiMode,
      credentialRef: String(raw.credentialRef || '').trim(),
      enabled: raw.enabled !== false,
      overrides,
      resolved,
    };
  });
  const defaultProfileId = models.defaultProfileId == null || models.defaultProfileId === ''
    ? null
    : String(models.defaultProfileId).trim().toLowerCase();
  if (defaultProfileId !== null && !profileIds.has(defaultProfileId)) {
    throw new Error('models.defaultProfileId must reference an existing profile');
  }
  return { schemaVersion: 1, defaultProfileId, profiles: normalizedProfiles };
}

function validate(settings) {
  if (!settings || typeof settings !== 'object' || settings.schema_version !== 1) {
    throw new Error('settings schema_version is unsupported');
  }
  const defaults = defaultSettings();
  const general = { ...defaults.general, ...(settings.general || {}) };
  general.launch_at_login = general.launch_at_login === true;
  general.keep_running = general.keep_running !== false;
  general.update_channel = String(general.update_channel || '').trim().toLowerCase();
  if (!['stable', 'preview'].includes(general.update_channel)) {
    throw new Error('general.update_channel is unsupported');
  }
  const notifications = { ...defaults.notifications, ...(settings.notifications || {}) };
  notifications.completion = notifications.completion !== false;
  notifications.failure = notifications.failure !== false;
  const rawActivation = settings.activation || {};
  const activation = { ...defaults.activation, ...rawActivation };
  if (!Object.prototype.hasOwnProperty.call(rawActivation, 'wake_mode')) {
    activation.wake_mode = activation.wiggle_enabled
      ? (activation.fallback_hotkey_enabled ? 'wiggle_hotkey' : 'wiggle')
      : 'hotkey';
  }
  activation.wake_mode = String(activation.wake_mode || '').trim().toLowerCase();
  if (!['wiggle', 'wiggle_hotkey', 'hotkey', 'mouse_button'].includes(activation.wake_mode)) {
    throw new Error('activation.wake_mode is unsupported');
  }
  activation.mouse_side_button = String(activation.mouse_side_button || '').trim().toLowerCase();
  if (!['none', 'xbutton1', 'xbutton2', 'middle_hold'].includes(activation.mouse_side_button)) {
    throw new Error('activation.mouse_side_button is unsupported');
  }
  if (activation.wake_mode === 'mouse_button' && activation.mouse_side_button === 'none') {
    throw new Error('activation.mouse_side_button must be bound for mouse_button wake mode');
  }
  activation.gesture_interaction_mode = String(
    activation.gesture_interaction_mode || defaults.activation.gesture_interaction_mode,
  ).trim().toLowerCase();
  if (!['pass_through', 'exclusive_overlay'].includes(activation.gesture_interaction_mode)) {
    throw new Error('activation.gesture_interaction_mode is unsupported');
  }
  activation.wiggle_enabled = ['wiggle', 'wiggle_hotkey'].includes(activation.wake_mode);
  activation.fallback_hotkey_enabled = ['wiggle_hotkey', 'hotkey'].includes(activation.wake_mode);
  activation.keep_current_app_focus = activation.keep_current_app_focus !== false;
  activation.dashboard_focus_after_action = activation.dashboard_focus_after_action === true;
  for (const [name, minimum, maximum] of [
    ['gesture_arm_delay_ms', 60, 600],
    ['gesture_timeout_ms', 1000, 15000],
    ['multi_stroke_submit_ms', 1000, 30000],
  ]) {
    const value = Number(activation[name]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`activation.${name} must be between ${minimum} and ${maximum}`);
    }
    activation[name] = value;
  }
  const interaction = { ...defaults.interaction, ...(settings.interaction || {}) };
  if (!['voice', 'text'].includes(interaction.default_input_mode)) {
    throw new Error('interaction.default_input_mode must be voice or text');
  }
  interaction.voice_start_strategy = String(interaction.voice_start_strategy || '').trim().toLowerCase();
  if (!['auto', 'push_to_talk', 'hover'].includes(interaction.voice_start_strategy)) {
    throw new Error('interaction.voice_start_strategy is unsupported');
  }
  interaction.voice_engine = String(interaction.voice_engine || 'auto').trim().toLowerCase() || 'auto';
  if (!['auto', 'whisper', 'sense_voice'].includes(interaction.voice_engine)) {
    throw new Error('interaction.voice_engine is unsupported');
  }
  interaction.voice_silence_ms = Math.max(
    600,
    Math.min(5000, Number(interaction.voice_silence_ms) || defaults.interaction.voice_silence_ms),
  );
  interaction.voice_language = String(interaction.voice_language || '').trim().toLowerCase();
  if (!['auto', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'].includes(interaction.voice_language)) {
    throw new Error('interaction.voice_language is unsupported');
  }
  interaction.voice_output_mode = String(interaction.voice_output_mode || '').trim().toLowerCase();
  if (!['verbatim', 'clean_spacing'].includes(interaction.voice_output_mode)) {
    throw new Error('interaction.voice_output_mode must be verbatim or clean_spacing');
  }
  interaction.voice_punctuation = String(interaction.voice_punctuation || '').trim().toLowerCase();
  if (!['verbatim', 'smart_zh'].includes(interaction.voice_punctuation)) {
    throw new Error('interaction.voice_punctuation is unsupported');
  }
  interaction.voice_script = String(interaction.voice_script || '').trim().toLowerCase();
  if (!['unchanged', 'simplified', 'traditional'].includes(interaction.voice_script)) {
    throw new Error('interaction.voice_script is unsupported');
  }
  interaction.voice_mixed_spacing = String(interaction.voice_mixed_spacing || '').trim().toLowerCase();
  if (!['preserve', 'compact_cjk'].includes(interaction.voice_mixed_spacing)) {
    throw new Error('interaction.voice_mixed_spacing is unsupported');
  }
  interaction.voice_resident_enabled = interaction.voice_resident_enabled !== false;
  if (!Number.isInteger(interaction.voice_memory_limit_mb)
      || interaction.voice_memory_limit_mb < 128
      || interaction.voice_memory_limit_mb > 16384) {
    throw new Error('interaction.voice_memory_limit_mb must be between 128 and 16384');
  }
  if (!Number.isInteger(interaction.voice_idle_unload_ms)
      || interaction.voice_idle_unload_ms < 0
      || interaction.voice_idle_unload_ms > 3600000) {
    throw new Error('interaction.voice_idle_unload_ms must be between 0 (resident) and 3600000');
  }
  if (
    !interaction.voice_glossaries
    || typeof interaction.voice_glossaries !== 'object'
    || Array.isArray(interaction.voice_glossaries)
  ) {
    throw new Error('interaction.voice_glossaries must be an object');
  }
  if (Object.keys(interaction.voice_glossaries).length > 64) {
    throw new Error('interaction.voice_glossaries has too many scopes');
  }
  interaction.voice_glossaries = Object.fromEntries(
    Object.entries(interaction.voice_glossaries).map(([rawScope, rawTerms]) => {
      const scope = String(rawScope || '').trim();
      if (!scope) throw new Error('voice glossary scope is empty');
      if (!Array.isArray(rawTerms)) throw new Error('voice glossary terms must be a list');
      const seen = new Set();
      const terms = rawTerms.map((item) => String(item || '').trim()).filter((term) => {
        if (!term) return false;
        if (term.length > 120) throw new Error('voice glossary term is too long');
        const folded = term.toLowerCase();
        if (seen.has(folded)) return false;
        seen.add(folded);
        return true;
      });
      if (terms.length > 64) throw new Error('voice glossary has too many terms');
      return [scope, terms];
    }),
  );
  const privacy = { ...defaults.privacy, ...(settings.privacy || {}) };
  privacy.anonymous_usage = privacy.anonymous_usage === true;
  privacy.retain_captures_days = Math.max(
    0,
    Math.min(30, Number(privacy.retain_captures_days) || 0),
  );
  privacy.retain_artifacts_days = Math.max(
    0,
    Math.min(3650, Number(privacy.retain_artifacts_days) || 0),
  );
  privacy.retain_audit_days = Math.max(
    1,
    Math.min(3650, Number(privacy.retain_audit_days) || defaults.privacy.retain_audit_days),
  );
  if (!CAPTURE_MODES.has(privacy.default_capture_mode)) {
    throw new Error(`unsupported capture mode: ${privacy.default_capture_mode || '<empty>'}`);
  }
  if (
    !privacy.app_capture_modes
    || typeof privacy.app_capture_modes !== 'object'
    || Array.isArray(privacy.app_capture_modes)
  ) {
    throw new Error('privacy.app_capture_modes must be an object');
  }
  privacy.app_capture_modes = Object.fromEntries(
    Object.entries(privacy.app_capture_modes).map(([pattern, mode]) => {
      const cleanPattern = String(pattern || '').trim();
      const cleanMode = String(mode || '').trim().toLowerCase();
      if (!cleanPattern) throw new Error('capture policy app pattern is empty');
      if (!CAPTURE_MODES.has(cleanMode)) throw new Error(`unsupported capture mode: ${cleanMode || '<empty>'}`);
      return [cleanPattern, cleanMode];
    }),
  );
  const permissions = { ...defaults.permissions, ...(settings.permissions || {}) };
  if (!Array.isArray(permissions.scoped_grants)) {
    throw new Error('scoped permission grants must be a list');
  }
  permissions.scoped_grants = permissions.scoped_grants.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('scoped permission grant must be an object');
    }
    const decision = String(raw.decision || '').trim().toLowerCase();
    if (!['allow', 'confirm', 'deny'].includes(decision)) {
      throw new Error(`invalid scoped permission decision: ${decision || '<empty>'}`);
    }
    const expiresAt = String(raw.expires_at || raw.expiresAt || '').trim();
    if (
      expiresAt
      && (
        Number.isNaN(Date.parse(expiresAt))
        || !/(?:z|[+-]\d{2}:\d{2})$/i.test(expiresAt)
      )
    ) {
      throw new Error('invalid scoped permission expiry');
    }
    return {
      id: String(raw.id || '').trim(),
      decision,
      recipe: String(raw.recipe || '*').trim() || '*',
      app: String(raw.app || '').trim(),
      project: String(raw.project || '').trim(),
      risk: String(raw.risk || '*').trim().toLowerCase() || '*',
      expires_at: expiresAt,
    };
  });
  const rawShortcuts = settings.shortcuts || {};
  const shortcuts = { ...defaults.shortcuts, ...rawShortcuts };
  if (!Object.prototype.hasOwnProperty.call(rawShortcuts, 'wake')) {
    shortcuts.wake = activation.fallback_hotkey || defaults.shortcuts.wake;
  }
  const normalizedShortcuts = new Map();
  for (const [name, value] of Object.entries(shortcuts)) {
    if (typeof value !== 'string' || !value.trim() || value.length > 96) {
      throw new Error(`shortcut ${name} is invalid`);
    }
    shortcuts[name] = value.trim();
    const normalized = normalizedShortcut(shortcuts[name]);
    if (!normalized) throw new Error(`shortcut ${name} is invalid`);
    if (RESERVED_SHORTCUTS.has(normalized)) throw new Error(`reserved shortcut ${shortcuts[name]}`);
    if (normalizedShortcuts.has(normalized)) {
      throw new Error(`duplicate shortcut ${shortcuts[name]} for ${normalizedShortcuts.get(normalized)} and ${name}`);
    }
    normalizedShortcuts.set(normalized, name);
  }
  activation.fallback_hotkey = shortcuts.wake;
  const rawAppearance = settings.appearance && typeof settings.appearance === 'object'
    ? settings.appearance
    : {};
  const appearance = { ...defaults.appearance, ...rawAppearance };
  // v1 drew only an 8-DIP thin stroke. Absence of a style marker means the
  // width still has those old semantics, so migrate it to the new Demo 6 band.
  if (!Object.prototype.hasOwnProperty.call(rawAppearance, 'gesture_line_style')) {
    appearance.gesture_line_style = defaults.appearance.gesture_line_style;
    appearance.gesture_line_width_dip = defaults.appearance.gesture_line_width_dip;
  }
  appearance.theme = String(appearance.theme || '').trim().toLowerCase();
  appearance.material = String(appearance.material || '').trim().toLowerCase();
  appearance.selection_visual = String(appearance.selection_visual || '').trim().toLowerCase();
  appearance.gesture_line_style = String(appearance.gesture_line_style || '').trim().toLowerCase();
  if (!['system', 'light', 'dark'].includes(appearance.theme)) {
    throw new Error('appearance.theme is unsupported');
  }
  if (!['auto', 'translucent', 'solid'].includes(appearance.material)) {
    throw new Error('appearance.material is unsupported');
  }
  if (!['sweep_band', 'soft_glow', 'outline'].includes(appearance.selection_visual)) {
    throw new Error('appearance.selection_visual is unsupported');
  }
  if (!['demo6_band', 'thin'].includes(appearance.gesture_line_style)) {
    throw new Error('appearance.gesture_line_style is unsupported');
  }
  const appearanceRanges = {
    sweep_height_ratio: [0.15, 1.5],
    sweep_min_height_dip: [4, 48],
    sweep_max_height_dip: [6, 96],
    sweep_duration_ms: [60, 1500],
    sweep_fade_ms: [60, 1500],
    capsule_spawn_ms: [60, 1500],
    capsule_expand_ms: [60, 1500],
    capsule_voice_width_dip: [28, 180],
    capsule_text_width_dip: [40, 560],
    capsule_max_width_dip: [80, 900],
    capsule_inline_gap_dip: [4, 96],
    gesture_line_width_dip: [3, 40],
  };
  for (const [name, [minimum, maximum]] of Object.entries(appearanceRanges)) {
    const value = Number(appearance[name]);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`appearance.${name} must be between ${minimum} and ${maximum}`);
    }
    appearance[name] = value;
  }
  if (appearance.sweep_min_height_dip > appearance.sweep_max_height_dip) {
    throw new Error('appearance sweep minimum must not exceed maximum');
  }
  if (
    appearance.capsule_max_width_dip < appearance.capsule_voice_width_dip
    || appearance.capsule_max_width_dip < appearance.capsule_text_width_dip
  ) {
    throw new Error('appearance capsule maximum width is too small');
  }
  const accessibility = { ...defaults.accessibility, ...(settings.accessibility || {}) };
  accessibility.reduce_motion = accessibility.reduce_motion === true;
  accessibility.reduce_transparency = accessibility.reduce_transparency === true;
  accessibility.high_contrast_controls = accessibility.high_contrast_controls === true;
  const connections = { ...defaults.connections, ...(settings.connections || {}) };
  connections.browser_devtools_enabled = connections.browser_devtools_enabled !== false;
  if (!Array.isArray(connections.browser_devtools_endpoints) || connections.browser_devtools_endpoints.length > 8) {
    throw new Error('connections.browser_devtools_endpoints must be a bounded list');
  }
  const seenDevToolsEndpoints = new Set();
  connections.browser_devtools_endpoints = connections.browser_devtools_endpoints.map((raw) => {
    let endpoint;
    try {
      endpoint = new URL(String(raw || '').trim());
    } catch {
      throw new Error('browser DevTools endpoint is invalid');
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
      throw new Error('browser DevTools endpoints must use a loopback host');
    }
    const port = Number(endpoint.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !['', '/'].includes(endpoint.pathname) || endpoint.search || endpoint.hash) {
      throw new Error('browser DevTools endpoint must be an origin with an explicit user port');
    }
    const canonical = `${endpoint.protocol}//${endpoint.hostname}:${port}`;
    if (seenDevToolsEndpoints.has(canonical)) return null;
    seenDevToolsEndpoints.add(canonical);
    return canonical;
  }).filter(Boolean);
  const agents = { ...defaults.agents, ...(settings.agents || {}) };
  agents.delivery_mode = String(agents.delivery_mode || '').trim().toLowerCase();
  agents.cwd_match = String(agents.cwd_match || '').trim().toLowerCase();
  agents.image_policy = String(agents.image_policy || '').trim().toLowerCase();
  agents.auto_attach = agents.auto_attach !== false;
  if (!['active_session', 'managed_session', 'clipboard'].includes(agents.delivery_mode)) {
    throw new Error('agents.delivery_mode is unsupported');
  }
  if (!['strict', 'subtree', 'confirm'].includes(agents.cwd_match)) {
    throw new Error('agents.cwd_match is unsupported');
  }
  if (!['vision_only', 'never', 'confirm'].includes(agents.image_policy)) {
    throw new Error('agents.image_policy is unsupported');
  }
  if (!agents.session_bindings || typeof agents.session_bindings !== 'object' || Array.isArray(agents.session_bindings)) {
    throw new Error('agents.session_bindings must be an object');
  }
  agents.session_bindings = Object.fromEntries(Object.entries(agents.session_bindings).map(([provider, sessionId]) => {
    const cleanProvider = String(provider || '').trim().toLowerCase();
    const cleanSession = String(sessionId || '').trim();
    if (!cleanProvider || !cleanSession || cleanSession.length > 256) {
      throw new Error('agents.session_bindings contains an invalid entry');
    }
    return [cleanProvider, cleanSession];
  }));
  return {
    ...defaults,
    ...settings,
    general,
    notifications,
    activation,
    interaction,
    agents,
    models: validateModels(settings.models, defaults),
    permissions,
    privacy,
    shortcuts,
    appearance,
    accessibility,
    connections,
    recipe_enabled: { ...(settings.recipe_enabled || {}) },
  };
}

class ElectronSettingsStore {
  constructor(settingsPath) {
    this.path = path.resolve(settingsPath);
  }

  writeValidated(validated) {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.path);
    return this.path;
  }

  load() {
    if (!fs.existsSync(this.path)) return defaultSettings();
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw new Error(`settings JSON is invalid: ${error.message}`);
    }
    const validated = validate(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(validated)) this.writeValidated(validated);
    return validated;
  }

  save(settings) {
    const validated = validate(settings);
    return this.writeValidated(validated);
  }
}

module.exports = { ElectronSettingsStore, defaultSettings, validate };
