const fs = require('fs');
const path = require('path');

function defaultSettings() {
  return {
    schema_version: 1,
    activation: {
      wiggle_enabled: true,
      sensitivity: 0.55,
      fallback_hotkey_enabled: true,
      fallback_hotkey: 'Control+Alt+M',
      disabled_apps: ['blender', 'krita', 'photoshop', 'premiere', 'davinci resolve', 'unity', 'unreal'],
      cooldown_ms: 900,
    },
    interaction: {
      default_input_mode: 'voice',
      voice_auto_submit: true,
      voice_silence_ms: 1600,
    },
    agents: { preferred: 'pi', profiles: {} },
    permissions: {
      default_read: 'allow',
      default_write: 'confirm',
      default_send: 'confirm',
      default_destructive: 'confirm',
      default_purchase: 'deny',
      recipe_overrides: {},
    },
    privacy: {
      upload_screenshots: false,
      retain_captures_days: 3,
      retain_audit_days: 30,
      sensitive_apps: ['1password', 'keepass', 'bitwarden', 'wallet', '银行'],
    },
    recipe_enabled: {},
  };
}

function validate(settings) {
  if (!settings || typeof settings !== 'object' || settings.schema_version !== 1) {
    throw new Error('settings schema_version is unsupported');
  }
  const defaults = defaultSettings();
  const interaction = { ...defaults.interaction, ...(settings.interaction || {}) };
  if (!['voice', 'text'].includes(interaction.default_input_mode)) {
    throw new Error('interaction.default_input_mode must be voice or text');
  }
  interaction.voice_silence_ms = Math.max(
    600,
    Math.min(5000, Number(interaction.voice_silence_ms) || defaults.interaction.voice_silence_ms),
  );
  return {
    ...defaults,
    ...settings,
    activation: { ...defaults.activation, ...(settings.activation || {}) },
    interaction,
    agents: { ...defaults.agents, ...(settings.agents || {}) },
    permissions: { ...defaults.permissions, ...(settings.permissions || {}) },
    privacy: { ...defaults.privacy, ...(settings.privacy || {}) },
    recipe_enabled: { ...(settings.recipe_enabled || {}) },
  };
}

class ElectronSettingsStore {
  constructor(settingsPath) {
    this.path = path.resolve(settingsPath);
  }

  load() {
    if (!fs.existsSync(this.path)) return defaultSettings();
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw new Error(`settings JSON is invalid: ${error.message}`);
    }
    return validate(parsed);
  }

  save(settings) {
    const validated = validate(settings);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.path);
    return this.path;
  }
}

module.exports = { ElectronSettingsStore, defaultSettings, validate };
