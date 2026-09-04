'use strict';

(() => {
type SettingOption = { label: string; value: string | number };
type SettingRow = {
  control: 'toggle' | 'select' | 'range' | 'text' | 'tags' | 'info';
  description?: string;
  infoKey?: 'active-model' | 'credential' | 'terminal' | 'runtime' | 'thinking' | 'grants' | 'skills' | 'plugins' | 'connectors' | 'updates' | 'diagnostics';
  label: string;
  max?: number;
  min?: number;
  options?: SettingOption[];
  path?: string;
  step?: number;
};
type SettingSection = { title: string; rows: SettingRow[] };
type SettingsPage = { description: string; group: 'Settings' | 'Agent' | 'Customize'; icon: string; id: string; sections: SettingSection[]; title: string };

const option = (value: string | number, label: string): SettingOption => ({ value, label });

const SETTINGS_PAGES: SettingsPage[] = [
  { id: 'general', group: 'Settings', icon: 'ic-window', title: 'General', description: 'Startup, background behavior, and updates.', sections: [
    { title: 'Application', rows: [
      { path: 'general.launch_at_login', control: 'toggle', label: 'Launch at login', description: 'Start quietly after you sign in.' },
      { path: 'general.keep_running', control: 'toggle', label: 'Continue running when the window closes', description: 'Selection gestures and shortcuts remain available.' },
    ] },
  ] },
  { id: 'interaction', group: 'Settings', icon: 'ic-cursor', title: 'Interaction', description: 'Choose how Magic Pointer wakes, captures intent, and accepts input.', sections: [
    { title: 'Activation', rows: [
      { path: 'activation.wake_mode', control: 'select', label: 'Wake method', options: [option('wiggle_hotkey', 'Wiggle + shortcut'), option('wiggle', 'Wiggle only'), option('hotkey', 'Shortcut only'), option('mouse_button', 'Mouse side button')] },
      { path: 'activation.sensitivity', control: 'range', label: 'Wiggle sensitivity', min: 0, max: 1, step: 0.05 },
      { path: 'activation.gesture_arm_delay_ms', control: 'select', label: 'Press-and-hold delay', options: [option(120, '120 ms'), option(180, '180 ms'), option(240, '240 ms'), option(320, '320 ms')] },
      { path: 'activation.mouse_side_button', control: 'select', label: 'Mouse button', options: [option('none', 'None'), option('xbutton1', 'Side button 1'), option('xbutton2', 'Side button 2'), option('middle_hold', 'Hold middle button')] },
      { path: 'activation.keep_current_app_focus', control: 'toggle', label: 'Pause when the target app loses focus' },
      { path: 'activation.disabled_apps', control: 'tags', label: 'Disabled apps', description: 'Comma-separated process or app names.' },
    ] },
    { title: 'Default input', rows: [
      { path: 'interaction.default_input_mode', control: 'select', label: 'After a selection', options: [option('text', 'Type'), option('voice', 'Voice')] },
    ] },
  ] },
  { id: 'voice', group: 'Settings', icon: 'ic-mic', title: 'Voice', description: 'Voice is optional. When it is off, no speech model is started.', sections: [
    { title: 'Voice input', rows: [
      { path: 'interaction.voice_enabled', control: 'toggle', label: 'Enable voice input', description: 'Turning this off forces text input and hides ordinary voice entry points.' },
      { path: 'interaction.voice_engine', control: 'select', label: 'Local engine', options: [option('auto', 'Auto'), option('sense_voice', 'SenseVoice'), option('whisper', 'Whisper')] },
      { path: 'interaction.voice_language', control: 'select', label: 'Language', options: [option('auto', 'Auto'), option('zh', 'Chinese'), option('en', 'English'), option('ja', 'Japanese'), option('ko', 'Korean')] },
      { path: 'interaction.voice_silence_ms', control: 'select', label: 'End after silence', options: [option(1000, '1.0 seconds'), option(1600, '1.6 seconds'), option(2400, '2.4 seconds')] },
      { path: 'interaction.voice_auto_submit', control: 'toggle', label: 'Submit after transcription' },
    ] },
    { title: 'Performance', rows: [
      { path: 'interaction.voice_resident_enabled', control: 'toggle', label: 'Keep the speech model in memory' },
      { path: 'interaction.voice_idle_unload_ms', control: 'select', label: 'Unload when idle', options: [option(0, 'Never'), option(300000, '5 minutes'), option(900000, '15 minutes')] },
      { path: 'interaction.voice_memory_limit_mb', control: 'select', label: 'Memory limit', options: [option(512, '512 MB'), option(1024, '1 GB'), option(2048, '2 GB')] },
    ] },
  ] },
  { id: 'models-agents', group: 'Agent', icon: 'ic-spark', title: 'Models & runtime', description: 'Model selection, reasoning display, and Magic Pointer’s own execution runtime.', sections: [
    { title: 'Model', rows: [
      { control: 'info', infoKey: 'active-model', label: 'Active model', description: 'The model used by ordinary replies and Agent turns.' },
      { control: 'info', infoKey: 'credential', label: 'Model credential', description: 'Shows only whether a credential exists. The value is never displayed.' },
      { control: 'info', infoKey: 'terminal', label: 'Configure model', description: 'Run the command in Terminal; secret input is not echoed.' },
    ] },
    { title: 'Runtime', rows: [
      { control: 'info', infoKey: 'runtime', label: 'Execution runtime', description: 'Every short or long task runs on Magic Pointer’s own Runtime.' },
      { control: 'info', infoKey: 'thinking', label: 'Thinking display', description: 'Stored reasoning appears in the conversation timeline and can be expanded.' },
    ] },
    { title: 'External clients', rows: [
      { path: 'agents.preferred', control: 'select', label: 'Preferred delivery client', description: 'Used only when you explicitly deliver a compiled prompt to another client.', options: [option('pi', 'Pi'), option('codex', 'Codex'), option('claude', 'Claude Code'), option('gemini', 'Gemini CLI')] },
      { path: 'agents.delivery_mode', control: 'select', label: 'Delivery mode', description: 'This changes prompt delivery, not the task execution path.', options: [option('active_session', 'Current client session'), option('managed_session', 'Managed client session'), option('clipboard', 'Copy prompt only')] },
      { path: 'agents.cwd_match', control: 'select', label: 'Project folder match', options: [option('strict', 'Exact match'), option('subtree', 'Allow subfolders'), option('confirm', 'Ask when different')] },
      { path: 'agents.auto_attach', control: 'toggle', label: 'Attach grounded evidence', description: 'Include the selected objects and frozen evidence in explicit prompt delivery.' },
    ] },
  ] },
  { id: 'skills', group: 'Customize', icon: 'ic-spark', title: 'Skills', description: 'View and invoke Skills installed on this device.', sections: [
    { title: 'On this device', rows: [
      { control: 'info', infoKey: 'skills', label: 'Your skills', description: 'Project and user directories are merged by priority; choosing one inserts its real Slash name.' },
    ] },
  ] },
  { id: 'plugins', group: 'Customize', icon: 'ic-plug', title: 'Plugins', description: 'Manage local Harness plugins that take effect only after approval.', sections: [
    { title: 'Plugins', rows: [
      { control: 'info', infoKey: 'plugins', label: 'Personal plugins', description: 'Each candidate retains its diff, approval, rejection, audit, and rollback record.' },
    ] },
  ] },
  { id: 'connectors', group: 'Customize', icon: 'ic-globe', title: 'MCP & connectors', description: 'Connect local MCP servers, browsers, and structured capabilities.', sections: [
    { title: 'Connectors', rows: [
      { control: 'info', infoKey: 'connectors', label: 'MCP servers', description: 'Capabilities are discovered lazily for the current task instead of remaining in every prompt.' },
    ] },
  ] },
  { id: 'perception-privacy', group: 'Agent', icon: 'ic-eye', title: 'Perception & privacy', description: 'Control what the Agent can inspect, what may leave the device, and which apps remain private.', sections: [
    { title: 'Reading', rows: [
      { path: 'privacy.default_capture_mode', control: 'select', label: 'Default capture mode', options: [option('follow_global', 'Auto'), option('structured_only', 'Structured only'), option('local_screenshot', 'Local screenshot only'), option('deny', 'Deny')] },
      { path: 'privacy.upload_screenshots', control: 'toggle', label: 'Allow screenshots to reach the vision model' },
    ] },
    { title: 'Boundaries', rows: [
      { path: 'privacy.sensitive_apps', control: 'tags', label: 'Apps Magic Pointer never reads', description: 'No reading, capture, or memory.' },
    ] },
    { title: 'Browser', rows: [
      { path: 'connections.browser_devtools_enabled', control: 'toggle', label: 'Read authorized browser pages' },
      { path: 'connections.browser_devtools_endpoints', control: 'tags', label: 'Local debugging endpoints', description: 'Only localhost and 127.0.0.1 are accepted.' },
    ] },
  ] },
  { id: 'permissions', group: 'Agent', icon: 'ic-shield', title: 'Permissions', description: 'Choose whether each effect is allowed, asks first, or is denied.', sections: [
    { title: 'Default permissions', rows: [
      { path: 'permissions.default_read', control: 'select', label: 'Read', options: [option('allow', 'Allow'), option('confirm', 'Ask every time'), option('deny', 'Deny')] },
      { path: 'permissions.default_write', control: 'select', label: 'Write', options: [option('allow', 'Allow'), option('confirm', 'Ask every time'), option('deny', 'Deny')] },
      { path: 'permissions.default_send', control: 'select', label: 'External send', options: [option('confirm', 'Ask every time'), option('deny', 'Deny')] },
      { path: 'permissions.default_destructive', control: 'select', label: 'Delete or overwrite', options: [option('confirm', 'Confirm before executing'), option('deny', 'Deny')] },
      { path: 'permissions.default_purchase', control: 'select', label: 'Purchases', options: [option('confirm', 'Confirm before executing'), option('deny', 'Deny')] },
    ] },
    { title: 'Session grants', rows: [
      { control: 'info', infoKey: 'grants', label: 'Scoped grants', description: 'Shows active app, project, and expiry scopes. New scopes are denied by default.' },
    ] },
  ] },
  { id: 'memory-context', group: 'Customize', icon: 'ic-memory', title: 'Memory & context', description: 'Control what the Agent remembers and inspect context formed on this device.', sections: [
    { title: 'Memory', rows: [
      { path: 'privacy.screen_memory_enabled', control: 'toggle', label: 'Remember handled objects', description: 'Store app, window, and question summaries locally for later recall.' },
      { path: 'privacy.background_learning_enabled', control: 'toggle', label: 'Generate learning suggestions', description: 'Candidates still require approval before they take effect.' },
    ] },
    { title: 'Context', rows: [
      { control: 'info', label: 'Workspace memory', description: 'The bound folder, current conversation, and approved memories enter the Agent context.' },
      { control: 'info', label: 'Automatic compaction', description: 'Near the context limit, Runtime preserves goals, decisions, evidence, and unfinished work.' },
    ] },
  ] },
  { id: 'storage', group: 'Customize', icon: 'ic-stash', title: 'Storage', description: 'Choose how captures, artifacts, and audit data remain on this device.', sections: [
    { title: 'Collection', rows: [
      { path: 'stash.dir', control: 'text', label: 'Save directory' },
      { path: 'stash.clipboard', control: 'toggle', label: 'Collect clipboard images' },
      { path: 'stash.text', control: 'toggle', label: 'Collect clipboard text' },
      { path: 'stash.burst_window_ms', control: 'select', label: 'Group within', options: [option(30000, '30 seconds'), option(120000, '2 minutes'), option(600000, '10 minutes')] },
    ] },
    { title: 'Retention', rows: [
      { path: 'privacy.retain_captures_days', control: 'select', label: 'Captures and selections', options: [option(1, '1 day'), option(3, '3 days'), option(7, '7 days'), option(0, 'Forever')] },
      { path: 'privacy.retain_artifacts_days', control: 'select', label: 'Generated artifacts', options: [option(7, '7 days'), option(30, '30 days'), option(90, '90 days'), option(0, 'Forever')] },
    ] },
  ] },
  { id: 'appearance-accessibility', group: 'Customize', icon: 'ic-img', title: 'Appearance', description: 'Theme, window material, and selection feedback.', sections: [
    { title: 'Appearance', rows: [
      { path: 'appearance.theme', control: 'select', label: 'Theme', options: [option('system', 'System'), option('light', 'Light'), option('dark', 'Dark')] },
      { path: 'appearance.material', control: 'select', label: 'Window material', options: [option('auto', 'Auto'), option('translucent', 'Translucent'), option('solid', 'Solid')] },
      { path: 'appearance.selection_visual', control: 'select', label: 'Selection feedback', options: [option('sweep_band', 'Sweep'), option('soft_glow', 'Soft glow'), option('outline', 'Outline')] },
      { path: 'appearance.sweep_height_ratio', control: 'range', label: 'Sweep height', min: 0.15, max: 1.5, step: 0.05 },
    ] },
    { title: 'Window', rows: [
      { path: 'accessibility.reduce_transparency', control: 'toggle', label: 'Reduce transparency' },
    ] },
  ] },
  { id: 'shortcuts', group: 'Settings', icon: 'ic-cursor', title: 'Shortcuts', description: 'Keyboard access for Studio, selections, and voice.', sections: [
    { title: 'Shortcuts', rows: [
      { path: 'shortcuts.wake', control: 'text', label: 'Wake Magic Pointer' },
      { path: 'shortcuts.text_mode', control: 'text', label: 'Start text input' },
      { path: 'shortcuts.voice_mode', control: 'text', label: 'Start voice input' },
      { path: 'shortcuts.pause', control: 'text', label: 'Pause input' },
    ] },
  ] },
  { id: 'updates', group: 'Settings', icon: 'ic-refresh', title: 'Updates', description: 'Update channel and installed application status.', sections: [
    { title: 'Updates', rows: [
      { path: 'general.update_channel', control: 'select', label: 'Update channel', options: [option('stable', 'Stable'), option('preview', 'Preview')] },
      { control: 'info', infoKey: 'updates', label: 'Installed status', description: 'Download and relaunch state also appears at the bottom of the sidebar.' },
    ] },
  ] },
  { id: 'diagnostics', group: 'Settings', icon: 'ic-term', title: 'Diagnostics & about', description: 'Version, runtime information, logs, and local diagnostics.', sections: [
    { title: 'Diagnostics', rows: [
      { control: 'info', infoKey: 'diagnostics', label: 'Diagnostics and logs', description: 'Shows the installed version, Electron/Chromium build, and local diagnostic entry points.' },
    ] },
  ] },
];

function valueForSetting(path: string, settings: Record<string, any>) {
  return path.split('.').reduce((node: any, part) => node == null ? undefined : node[part], settings);
}

function nestedPatch(path: string, value: unknown) {
  const root: Record<string, any> = {};
  const parts = path.split('.');
  let node = root;
  parts.forEach((part, index) => {
    node[part] = index === parts.length - 1 ? value : {};
    node = node[part];
  });
  return root;
}

function patchForSetting(path: string, value: unknown) {
  if (path === 'interaction.voice_enabled' && value !== true) {
    return { interaction: { voice_enabled: false, default_input_mode: 'text', voice_resident_enabled: false } };
  }
  if (path === 'interaction.default_input_mode' && value === 'voice') {
    return { interaction: { default_input_mode: 'voice', voice_enabled: true } };
  }
  if (path === 'interaction.voice_resident_enabled' && value === true) {
    return { interaction: { voice_resident_enabled: true, voice_enabled: true } };
  }
  return nestedPatch(path, value);
}

function modelInfoValue(key: string, status: Record<string, any>) {
  if (key === 'active-model') {
    if (!status?.configured) return 'Not configured';
    return String(status.displayName || status.model || status.provider || 'Configured');
  }
  if (key === 'credential') {
    if (!status?.configured) return 'Waiting for model profile';
    if (!status.credentialBackendAvailable) return 'Secure storage unavailable';
    return status.credentialPresent ? 'Stored securely' : 'Not configured';
  }
  if (key === 'terminal') return 'npm run model:groq';
  if (key === 'runtime') return 'MPAgentRuntime';
  if (key === 'thinking') return 'Stored reasoning';
  if (key === 'skills') return 'Open Skills and commands';
  if (key === 'plugins') return 'Effective after approval';
  if (key === 'connectors') return 'Loaded lazily by task';
  if (key === 'updates') return 'Provided by the updater';
  if (key === 'diagnostics') return 'Local runtime information';
  return 'Read only';
}

const SettingsModel = { SETTINGS_PAGES, modelInfoValue, patchForSetting, valueForSetting };
if (typeof module !== 'undefined' && module.exports) module.exports = SettingsModel;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { SettingsModel?: typeof SettingsModel }).SettingsModel = SettingsModel;
}
})();
