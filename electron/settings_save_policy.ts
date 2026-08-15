'use strict';

type UnknownRecord = Record<string, any>;

function pick(source: UnknownRecord | null | undefined, keys: readonly string[]) {
  const value = source && typeof source === 'object' ? source : {};
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function changed(left: unknown, right: unknown) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function mergeSettingsPatch(base: unknown, patch: unknown): any {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const source = base && typeof base === 'object' && !Array.isArray(base) ? base as UnknownRecord : {};
  const merged: UnknownRecord = { ...source };
  for (const [key, value] of Object.entries(patch as UnknownRecord)) {
    if (value === null) delete merged[key];
    else merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeSettingsPatch(source[key], value)
      : value;
  }
  return merged;
}

const VOICE_KEYS = [
  'voice_enabled', 'default_input_mode', 'voice_auto_submit', 'voice_start_strategy',
  'voice_silence_ms', 'voice_language', 'voice_output_mode', 'voice_punctuation',
  'voice_script', 'voice_mixed_spacing', 'voice_hallucination_guard',
  'voice_resident_enabled', 'voice_engine', 'voice_memory_limit_mb',
  'voice_idle_unload_ms', 'voice_glossaries',
] as const;

const GESTURE_KEYS = [
  'wake_mode', 'wiggle_enabled', 'sensitivity', 'mouse_side_button', 'disabled_apps',
  'cooldown_ms', 'gesture_arm_delay_ms', 'gesture_timeout_ms', 'multi_stroke_submit_ms',
  'gesture_interaction_mode', 'keep_current_app_focus',
] as const;

function settingsSaveImpact(previous: UnknownRecord = {}, next: UnknownRecord = {}) {
  return {
    voice: changed(pick(previous.interaction, VOICE_KEYS), pick(next.interaction, VOICE_KEYS)),
    hotkeys: changed(previous.shortcuts || {}, next.shortcuts || {})
      || previous.activation?.fallback_hotkey_enabled !== next.activation?.fallback_hotkey_enabled,
    gesture: changed(pick(previous.activation, GESTURE_KEYS), pick(next.activation, GESTURE_KEYS)),
    appearance: changed(previous.appearance || {}, next.appearance || {})
      || changed(previous.accessibility || {}, next.accessibility || {}),
    login: previous.general?.launch_at_login !== next.general?.launch_at_login,
    update: previous.general?.update_channel !== next.general?.update_channel,
    stash: changed(previous.stash || {}, next.stash || {}),
  };
}

module.exports = { mergeSettingsPatch, settingsSaveImpact };
