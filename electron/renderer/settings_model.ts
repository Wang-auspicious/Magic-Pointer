'use strict';

(() => {
  type SettingOption = {label: string; value: string | number};
  type SettingRow = {
    control: 'toggle' | 'select' | 'range' | 'text' | 'tags' | 'info';
    description?: string;
    infoKey?:
      | 'active-model'
      | 'credential'
      | 'runtime'
      | 'thinking'
      | 'grants'
      | 'skills'
      | 'plugins'
      | 'connectors'
      | 'updates'
      | 'diagnostics';
    label: string;
    max?: number;
    min?: number;
    options?: SettingOption[];
    path?: string;
    step?: number;
  };
  type SettingSection = {title: string; rows: SettingRow[]};
  type SettingsPage = {
    description: string;
    group: 'Startup' | 'AppPreferences' | 'GlobalShortcut' | 'MCP' | 'Extensions' | 'AppConfig' | 'DesktopInfo' | 'AppFeatures' | 'HistoryImport' | 'CcdCli' | 'FilePickers' | 'Custom3pSetup' | 'Custom3pHelperRun' | 'Custom3pUsage' | 'ClaudeAiImport' | 'SupportBundle' | 'WakeScheduler';
    icon: string;
    id: string;
    /* Counterpart group on the reference settings surface
     * (claude.settings IPC namespace), or null when Magic Pointer
     * owns the page and the reference has no equivalent. */
    ref: string | null;
    sections: SettingSection[];
    title: string;
  };

  const option = (value: string | number, label: string): SettingOption => ({
    value,
    label,
  });

  /* Stable-keyed English copy for the settings UI. Call sites use
   * formatSettingLabel(id, params); the future locale pass keys zh-CN
   * off these ids without touching render code. Values here are the
   * exact strings the contract tests assert. */
  const SETTINGS_UI_LABELS: Record<string, string> = Object.freeze({
    'model.notConfigured': 'Not configured',
    'model.waitingProfile': 'Waiting for model profile',
    'model.noSecureStorage': 'Secure storage unavailable',
    'model.storedSecurely': 'Stored securely',
    'model.configured': 'Configured',
    'model.runtime': 'MPAgentRuntime',
    'model.thinking': 'Stored reasoning',
    'model.skills': 'Open Skills and commands',
    'model.plugins': 'Effective after approval',
    'model.connectors': 'Loaded lazily by task',
    'model.updates': 'Provided by the updater',
    'model.diagnostics': 'Local runtime information',
    'model.readOnly': 'Read only',
    'search.title': 'Search settings',
    'search.results': '\u201c{query}\u201d \u00b7 {count} results',
    'search.empty': 'No matching settings.',
    'status.saving': 'Saving\u2026',
    'status.saved': 'Saved',
    'grants.active': '{count} active',
    'memory.title': 'Memory files',
    'memory.empty':
      'No memory files yet. Repeated work on the same objects will appear here.',
    'memory.untitled': 'Untitled object',
    'memory.context': 'Local context',
    'memory.uses': '{count} uses',
    'plugins.heading': 'Personal plugins',
    'plugins.empty': 'No installed plugins.',
    'plugins.fallbackDescription':
      'Local plugins become active after approval.',
    'plugins.search': 'Search skills and plugins',
    'plugins.add': 'Add',
    'plugins.tabMine': 'Your plugins',
    'plugins.scope': 'Plugin scope',
    'plugins.tabDiscover': 'Discover',
    'plugins.filter': 'Filter',
    'plugins.sort': 'Sort \u00b7 Last edited',
    'plugins.moreActions': 'More plugin actions',
    'plugins.unnamed': 'Unnamed plugin',
    'plugins.localDescription': 'Local Harness plugin',
    'plugins.localMeta': 'Local',
  });

  function formatSettingLabel(
    id: string,
    params?: Record<string, string | number>,
  ) {
    let text = SETTINGS_UI_LABELS[id] ?? id;
    if (params) {
      for (const name of Object.keys(params)) {
        text = text.split(`{${name}}`).join(String(params[name]));
      }
    }
    return text;
  }

  /* Page order, ids, groups and the pinned titles below are asserted by
   * tests/settings_ui_model_test.ts. Pages are grouped by the reference
   * namespace skeleton below (one group per claude.settings namespace that
   * has real rows; empty namespaces render no page). MP-only pages keep
   * their own names and sit in the nearest namespace group.
   *
   * Reference skeleton (claude.settings IPC surface, static evidence in
   * D:/Desktop/ClaudeDesktopRE/report/13-ipc-catalog.md; chunk lines are
   * pretty/main-index.chunk.js offsets): AppConfig 59400, Startup 59414,
   * CcdCli 59422, GlobalShortcut 59429, MCP 59435, Extensions 59457,
   * FilePickers 59549, AppPreferences 59555, AppFeatures 59568,
   * DesktopInfo 59569, Custom3pSetup 59576, Custom3pHelperRun 59652,
   * ClaudeAiImport 59677, HistoryImport 59726, SupportBundle 59773,
   * WakeScheduler 59774, Custom3pUsage 59780.
   * Pages with a real counterpart carry it in `ref` and use the
   * reference section vocabulary; MP-only pages (models-agents, skills,
   * permissions, memory-context) keep their own names — nothing invented. */
  const SETTINGS_PAGES: SettingsPage[] = [
    {
      id: 'general',
      group: 'Startup',
      icon: 'ic-window',
      ref: 'claude.settings.Startup (59414)',
      title: 'General',
      description: 'Startup, background behavior, and updates.',
      sections: [
        {
          title: 'Startup',
          rows: [
            {
              path: 'general.launch_at_login',
              control: 'toggle',
              label: 'Launch at login',
              description: 'Start quietly after you sign in.',
            },
            {
              path: 'general.keep_running',
              control: 'toggle',
              label: 'Continue running when the window closes',
              description: 'Selection gestures and shortcuts remain available.',
            },
          ],
        },
      ],
    },
    {
      id: 'interaction',
      group: 'AppPreferences',
      icon: 'ic-cursor',
      ref: 'claude.settings.AppPreferences (59555)',
      title: 'Interaction',
      description:
        'Choose how Magic Pointer wakes, captures intent, and accepts input.',
      sections: [
        {
          title: 'Activation',
          rows: [
            {
              path: 'activation.wake_mode',
              control: 'select',
              label: 'Wake method',
              options: [
                option('wiggle_hotkey', 'Wiggle + shortcut'),
                option('wiggle', 'Wiggle only'),
                option('hotkey', 'Shortcut only'),
                option('mouse_button', 'Mouse side button'),
              ],
            },
            {
              path: 'activation.sensitivity',
              control: 'range',
              label: 'Wiggle sensitivity',
              min: 0,
              max: 1,
              step: 0.05,
            },
            {
              path: 'activation.gesture_arm_delay_ms',
              control: 'select',
              label: 'Press-and-hold delay',
              options: [
                option(120, '120 ms'),
                option(180, '180 ms'),
                option(240, '240 ms'),
                option(320, '320 ms'),
              ],
            },
            {
              path: 'activation.mouse_side_button',
              control: 'select',
              label: 'Mouse button',
              options: [
                option('none', 'None'),
                option('xbutton1', 'Side button 1'),
                option('xbutton2', 'Side button 2'),
                option('middle_hold', 'Hold middle button'),
              ],
            },
            {
              path: 'activation.keep_current_app_focus',
              control: 'toggle',
              label: 'Pause when the target app loses focus',
            },
            {
              path: 'activation.disabled_apps',
              control: 'tags',
              label: 'Disabled apps',
              description: 'Comma-separated process or app names.',
            },
          ],
        },
      ],
    },
    {
      id: 'perception-privacy',
      group: 'AppPreferences',
      icon: 'ic-eye',
      ref: 'claude.settings.AppPreferences (59555)',
      title: 'Perception & privacy',
      description:
        'Control what the Agent can inspect, what may leave the device, and which apps remain private.',
      sections: [
        {
          title: 'Reading',
          rows: [
            {
              path: 'privacy.default_capture_mode',
              control: 'select',
              label: 'Default capture mode',
              options: [
                option('follow_global', 'Auto'),
                option('structured_only', 'Structured only'),
                option('local_screenshot', 'Local screenshot only'),
                option('deny', 'Deny'),
              ],
            },
            {
              path: 'privacy.upload_screenshots',
              control: 'toggle',
              label: 'Allow screenshots to reach the model',
            },
          ],
        },
        {
          title: 'Boundaries',
          rows: [
            {
              path: 'privacy.sensitive_apps',
              control: 'tags',
              label: 'Apps Magic Pointer never reads',
              description: 'No reading, capture, or memory.',
            },
          ],
        },
        {
          title: 'Browser',
          rows: [
            {
              path: 'connections.browser_devtools_enabled',
              control: 'toggle',
              label: 'Read authorized browser pages',
            },
            {
              path: 'connections.browser_devtools_endpoints',
              control: 'tags',
              label: 'Local debugging endpoints',
              description: 'Only localhost and 127.0.0.1 are accepted.',
            },
          ],
        },
      ],
    },
    {
      id: 'storage',
      group: 'AppPreferences',
      icon: 'ic-stash',
      ref: 'claude.settings.AppPreferences (59555)',
      title: 'Storage',
      description:
        'Choose how captures, artifacts, and audit data remain on this device.',
      sections: [
        {
          title: 'Collection',
          rows: [
            {path: 'stash.dir', control: 'text', label: 'Save directory'},
            {
              path: 'stash.clipboard',
              control: 'toggle',
              label: 'Continuously collect clipboard images',
              description:
                'Off by default. You can still add an image to task materials explicitly.',
            },
            {
              path: 'stash.text',
              control: 'toggle',
              label: 'Continuously collect clipboard text',
              description:
                'Off by default. This watches future clipboard changes; adding a chosen file or note does not require it.',
            },
            {
              path: 'stash.burst_window_ms',
              control: 'select',
              label: 'Group within',
              options: [
                option(30000, '30 seconds'),
                option(120000, '2 minutes'),
                option(600000, '10 minutes'),
              ],
            },
          ],
        },
        {
          title: 'Retention',
          rows: [
            {
              path: 'privacy.retain_captures_days',
              control: 'select',
              label: 'Captures and frozen frames',
              description:
                'Screenshots taken at the moment of a gesture, and the selections drawn on them. Older ones are deleted.',
              options: [
                option(1, '1 day'),
                option(3, '3 days'),
                option(7, '7 days'),
                option(0, 'Forever'),
              ],
            },
            {
              path: 'privacy.retain_artifacts_days',
              control: 'select',
              label: 'Generated artifacts',
              options: [
                option(7, '7 days'),
                option(30, '30 days'),
                option(90, '90 days'),
                option(0, 'Forever'),
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'appearance-accessibility',
      group: 'AppPreferences',
      icon: 'ic-img',
      ref: 'claude.settings.AppPreferences (59555)',
      title: 'Appearance',
      description: 'Theme, window material, and selection feedback.',
      sections: [
        {
          title: 'Appearance',
          rows: [
            {
              path: 'appearance.theme',
              control: 'select',
              label: 'Theme',
              options: [
                option('system', 'System'),
                option('light', 'Light'),
                option('dark', 'Dark'),
              ],
            },
            {
              path: 'appearance.material',
              control: 'select',
              label: 'Window material',
              options: [
                option('auto', 'Auto'),
                option('translucent', 'Translucent'),
                option('solid', 'Solid'),
              ],
            },
            {
              path: 'appearance.selection_visual',
              control: 'select',
              label: 'Selection feedback',
              options: [
                option('sweep_band', 'Sweep'),
                option('soft_glow', 'Soft glow'),
                option('outline', 'Outline'),
              ],
            },
            {
              path: 'appearance.sweep_height_ratio',
              control: 'range',
              label: 'Sweep height',
              min: 0.15,
              max: 1.5,
              step: 0.05,
            },
          ],
        },
        {
          title: 'Window',
          rows: [
            {
              path: 'accessibility.reduce_transparency',
              control: 'toggle',
              label: 'Reduce transparency',
            },
          ],
        },
      ],
    },
    {
      id: 'shortcuts',
      group: 'GlobalShortcut',
      icon: 'ic-cursor',
      ref: 'claude.settings.GlobalShortcut (59429)',
      title: 'Shortcuts',
      description: 'Keyboard access for Studio and selections.',
      sections: [
        {
          title: 'Global shortcut',
          rows: [
            {
              path: 'shortcuts.wake',
              control: 'text',
              label: 'Wake Magic Pointer',
            },
            {
              path: 'shortcuts.text_mode',
              control: 'text',
              label: 'Start text input',
            },
            {path: 'shortcuts.pause', control: 'text', label: 'Pause input'},
          ],
        },
      ],
    },
    {
      id: 'connectors',
      group: 'MCP',
      icon: 'ic-globe',
      ref: 'claude.settings.MCP (59435)',
      title: 'MCP & connectors',
      description:
        'Connect local MCP servers, browsers, and structured capabilities.',
      sections: [
        {
          title: 'Servers',
          rows: [
            {
              control: 'info',
              infoKey: 'connectors',
              label: 'MCP servers',
              description:
                'Capabilities are discovered lazily for the current task instead of remaining in every prompt.',
            },
          ],
        },
      ],
    },
    {
      id: 'plugins',
      group: 'Extensions',
      icon: 'ic-plug',
      ref: 'claude.settings.Extensions (59457)',
      title: 'Plugins',
      description:
        'Manage local Harness plugins that take effect only after approval.',
      sections: [
        {
          title: 'Extensions',
          rows: [
            {
              control: 'info',
              infoKey: 'plugins',
              label: 'Personal plugins',
              description:
                'Each candidate retains its diff, approval, rejection, audit, and rollback record.',
            },
          ],
        },
      ],
    },
    {
      id: 'skills',
      group: 'Extensions',
      icon: 'ic-spark',
      ref: null,
      title: 'Skills',
      description: 'View and invoke Skills installed on this device.',
      sections: [
        {
          title: 'On this device',
          rows: [
            {
              control: 'info',
              infoKey: 'skills',
              label: 'Your skills',
              description:
                'Project and user directories are merged by priority; choosing one inserts its real Slash name.',
            },
          ],
        },
      ],
    },
    {
      id: 'updates',
      group: 'AppConfig',
      icon: 'ic-refresh',
      ref: 'claude.settings.AppConfig (59400)',
      title: 'Updates',
      description: 'Update channel and installed application status.',
      sections: [
        {
          title: 'Application',
          rows: [
            {
              path: 'general.update_channel',
              control: 'select',
              label: 'Update channel',
              options: [
                option('stable', 'Stable'),
                option('preview', 'Preview'),
              ],
            },
            {
              control: 'info',
              infoKey: 'updates',
              label: 'Installed status',
              description:
                'Download and relaunch state also appears at the bottom of the sidebar.',
            },
          ],
        },
      ],
    },
    {
      id: 'diagnostics',
      group: 'DesktopInfo',
      icon: 'ic-term',
      ref: 'claude.settings.DesktopInfo (59569)',
      title: 'Diagnostics & about',
      description: 'Version, runtime information, logs, and local diagnostics.',
      sections: [
        {
          title: 'System information',
          rows: [
            {
              control: 'info',
              infoKey: 'diagnostics',
              label: 'Diagnostics and logs',
              description:
                'Shows the installed version, Electron/Chromium build, and local diagnostic entry points.',
            },
          ],
        },
      ],
    },    {
      id: 'models-agents',
      group: 'AppFeatures',
      icon: 'ic-spark',
      ref: null,
      title: 'Models & runtime',
      description:
        'Model selection, reasoning display, and Magic Pointer’s own execution runtime.',
      sections: [
        {
          title: 'Model',
          rows: [
            {
              control: 'info',
              infoKey: 'active-model',
              label: 'Active model',
              description:
                'The model used by ordinary replies and Agent turns.',
            },
            {
              control: 'info',
              infoKey: 'credential',
              label: 'Model credential',
              description:
                'Shows only whether a credential exists. The value is never displayed.',
            },
          ],
        },
        {
          title: 'Runtime',
          rows: [
            {
              control: 'info',
              infoKey: 'runtime',
              label: 'Execution runtime',
              description:
                'Every short or long task runs on Magic Pointer’s own Runtime.',
            },
            {
              control: 'info',
              infoKey: 'thinking',
              label: 'Thinking display',
              description:
                'Stored reasoning appears in the conversation timeline and can be expanded.',
            },
          ],
        },
        {
          title: 'External clients',
          rows: [
            {
              path: 'agents.preferred',
              control: 'select',
              label: 'Preferred delivery client',
              description:
                'Used only when you explicitly deliver a compiled prompt to another client.',
              options: [
                option('pi', 'Pi'),
                option('codex', 'Codex'),
                option('claude', 'Claude Code'),
                option('gemini', 'Gemini CLI'),
              ],
            },
            {
              path: 'agents.delivery_mode',
              control: 'select',
              label: 'Delivery mode',
              description:
                'This changes prompt delivery, not the task execution path.',
              options: [
                option('active_session', 'Current client session'),
                option('managed_session', 'Managed client session'),
                option('clipboard', 'Copy prompt only'),
              ],
            },
            {
              path: 'agents.cwd_match',
              control: 'select',
              label: 'Project folder match',
              options: [
                option('strict', 'Exact match'),
                option('subtree', 'Allow subfolders'),
                option('confirm', 'Ask when different'),
              ],
            },
            {
              path: 'agents.auto_attach',
              control: 'toggle',
              label: 'Attach grounded evidence',
              description:
                'Include the selected objects and frozen evidence in explicit prompt delivery.',
            },
          ],
        },
      ],
    },
    {
      id: 'permissions',
      group: 'AppFeatures',
      icon: 'ic-shield',
      ref: null,
      title: 'Permissions',
      description:
        'Choose whether each effect is allowed, asks first, or is denied.',
      sections: [
        {
          title: 'Default permissions',
          rows: [
            {
              path: 'permissions.default_read',
              control: 'select',
              label: 'Read',
              options: [
                option('allow', 'Allow'),
                option('confirm', 'Ask every time'),
                option('deny', 'Deny'),
              ],
            },
            {
              path: 'permissions.default_write',
              control: 'select',
              label: 'Write',
              options: [
                option('allow', 'Allow'),
                option('confirm', 'Ask every time'),
                option('deny', 'Deny'),
              ],
            },
            {
              path: 'permissions.default_send',
              control: 'select',
              label: 'External send',
              options: [
                option('confirm', 'Ask every time'),
                option('deny', 'Deny'),
              ],
            },
            {
              path: 'permissions.default_destructive',
              control: 'select',
              label: 'Delete or overwrite',
              options: [
                option('confirm', 'Confirm before executing'),
                option('deny', 'Deny'),
              ],
            },
            {
              path: 'permissions.default_purchase',
              control: 'select',
              label: 'Purchases',
              options: [
                option('confirm', 'Confirm before executing'),
                option('deny', 'Deny'),
              ],
            },
          ],
        },
        {
          title: 'Session grants',
          rows: [
            {
              control: 'info',
              infoKey: 'grants',
              label: 'Scoped grants',
              description:
                'Shows active app, project, and expiry scopes. New scopes are denied by default.',
            },
          ],
        },
      ],
    },
    {
      id: 'memory-context',
      group: 'HistoryImport',
      icon: 'ic-memory',
      ref: null,
      title: 'Memory & context',
      description:
        'Control what the Agent remembers and inspect context formed on this device.',
      sections: [
        {
          title: 'Memory',
          rows: [
            {
              path: 'privacy.screen_memory_enabled',
              control: 'toggle',
              label: 'Remember handled objects',
              description:
                'Store app, window, and question summaries locally for later recall.',
            },
            {
              path: 'privacy.background_learning_enabled',
              control: 'toggle',
              label: 'Generate learning suggestions',
              description:
                'Candidates still require approval before they take effect.',
            },
          ],
        },
        {
          title: 'Context',
          rows: [
            {
              control: 'info',
              label: 'Workspace memory',
              description:
                'The bound folder, current conversation, and approved memories enter the Agent context.',
            },
            {
              control: 'info',
              label: 'Automatic compaction',
              description:
                'Near the context limit, Runtime preserves goals, decisions, evidence, and unfinished work.',
            },
          ],
        },
      ],
    },

  ];

  function valueForSetting(path: string, settings: Record<string, any>) {
    return path
      .split('.')
      .reduce(
        (node: any, part) => (node == null ? undefined : node[part]),
        settings,
      );
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
    return nestedPatch(path, value);
  }

  function modelInfoValue(key: string, status: Record<string, any>) {
    if (key === 'active-model') {
      if (!status?.configured) {
        return formatSettingLabel('model.notConfigured');
      }
      return String(
        status.displayName ||
          status.model ||
          status.provider ||
          formatSettingLabel('model.configured'),
      );
    }
    if (key === 'credential') {
      if (!status?.configured) {
        return formatSettingLabel('model.waitingProfile');
      }
      if (!status.credentialBackendAvailable) {
        return formatSettingLabel('model.noSecureStorage');
      }
      return status.credentialPresent
        ? formatSettingLabel('model.storedSecurely')
        : formatSettingLabel('model.notConfigured');
    }
    if (key === 'runtime') {
      return formatSettingLabel('model.runtime');
    }
    if (key === 'thinking') {
      return formatSettingLabel('model.thinking');
    }
    if (key === 'skills') {
      return formatSettingLabel('model.skills');
    }
    if (key === 'plugins') {
      return formatSettingLabel('model.plugins');
    }
    if (key === 'connectors') {
      return formatSettingLabel('model.connectors');
    }
    if (key === 'updates') {
      return formatSettingLabel('model.updates');
    }
    if (key === 'diagnostics') {
      return formatSettingLabel('model.diagnostics');
    }
    return formatSettingLabel('model.readOnly');
  }

  const SettingsModel = {
    SETTINGS_PAGES,
    SETTINGS_UI_LABELS,
    formatSettingLabel,
    modelInfoValue,
    patchForSetting,
    valueForSetting,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SettingsModel;
  }
  if (typeof globalThis !== 'undefined') {
    (
      globalThis as typeof globalThis & {SettingsModel?: typeof SettingsModel}
    ).SettingsModel = SettingsModel;
  }
})();
