'use strict';

/* exported renderSettings */

type SettingsApi = {
  getFabricSettings?: () => Promise<any>;
  saveFabricSettings?: (patch: unknown) => Promise<any>;
  setTheme?: (theme: unknown) => void;
  conversations?: {memories?: () => Promise<any[]>};
  extensions?: {inventory?: () => Promise<any>};
};

type SettingsModelApi = {
  SETTINGS_PAGES: any[];
  SETTINGS_UI_LABELS: Record<string, string>;
  formatSettingLabel(id: string, params?: Record<string, string | number>): string;
  modelInfoValue(key: string, status: Record<string, any>): string;
  patchForSetting(path: string, value: unknown): Record<string, unknown>;
  valueForSetting(path: string, settings: Record<string, any>): unknown;
};

const settingsModel = (globalThis as any).SettingsModel as SettingsModelApi;
let canonicalSettings: Record<string, any> = {};
let activeModelStatus: Record<string, any> = {};
let learnedMemories: Array<Record<string, any>> = [];
let pluginInventory: Array<Record<string, any>> = [];
let activeSettingsPage = 'general';
let settingsQuery = '';
let settingsSaveQueue: Promise<void> = Promise.resolve();
let settingsHydrated = false;
const systemThemeQuery = matchMedia('(prefers-color-scheme: dark)');

function settingsApi(): SettingsApi | null {
  return window.magicPointerDashboard || null;
}

function escSetting(value: unknown) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function settingIcon(id: string) {
  const iconName: Record<string, string> = {
    'ic-window': 'computer',
    'ic-cursor': 'cursor',
    'ic-spark': 'agent',
    'ic-plug': 'plugin',
    'ic-globe': 'connectors',
    'ic-eye': 'eye',
    'ic-shield': 'lock-shield',
    'ic-memory': 'memory',
    'ic-stash': 'box',
    'ic-img': 'palette',
    'ic-refresh': 'arrow-clockwise',
    'ic-term': 'command-line',
    'ic-search': 'search',
    'ic-chev': 'caret-down',
    'ic-dots-vertical': 'dots-vertical',
    'ic-sliders': 'filter',
    'ic-sort': 'sort',
  };
  const name = iconName[id] || id;
  const icons = (globalThis as any).CdsIcons;
  if (icons && typeof icons.html === 'function') {
    return icons.html(name, id === 'ic-search' ? 'small' : 'large');
  }
  return `<svg aria-hidden="true"><use href="#${escSetting(id)}"/></svg>`;
}

function controlForSetting(row: any, value: unknown) {
  const path = escSetting(row.path || '');
  if (row.control === 'toggle') {
    const checked = value === true;
    return `<button type="button" class="settings-switch${checked ? ' is-on' : ''}" role="switch"
      aria-checked="${checked}" data-setting="${path}" data-control="toggle"><span></span></button>`;
  }
  if (row.control === 'select') {
    return `<label class="settings-select"><select data-setting="${path}" data-control="select">
      ${(row.options || [])
        .map(
          (
            entry: any,
          ) => `<option value="${escSetting(JSON.stringify(entry.value))}"
        ${entry.value === value ? 'selected' : ''}>${escSetting(entry.label)}</option>`,
        )
        .join('')}
      </select>${settingIcon('ic-chev')}</label>`;
  }
  if (row.control === 'range') {
    const numeric = Number(value);
    return `<span class="settings-range"><input type="range" data-setting="${path}" data-control="range"
      min="${row.min}" max="${row.max}" step="${row.step}" value="${Number.isFinite(numeric) ? numeric : row.min}">
      <output>${escSetting(Number.isFinite(numeric) ? numeric : row.min)}</output></span>`;
  }
  if (row.control === 'text') {
    return `<input class="settings-input" data-setting="${path}" data-control="text"
      value="${escSetting(value || '')}" spellcheck="false">`;
  }
  if (row.control === 'tags') {
    const text = Array.isArray(value) ? value.join(', ') : '';
    return `<input class="settings-input settings-tags" data-setting="${path}" data-control="tags"
      value="${escSetting(text)}" spellcheck="false">`;
  }
  const infoValue = row.infoKey
    ? row.infoKey === 'grants'
      ? Array.isArray(canonicalSettings.permissions?.scoped_grants)
        ? canonicalSettings.permissions.scoped_grants.length
        : 0
      : settingsModel.modelInfoValue(row.infoKey, activeModelStatus)
    : null;
  const displayValue =
    typeof infoValue === 'number'
      ? settingsModel.formatSettingLabel('grants.active', {count: infoValue})
      : infoValue || settingsModel.formatSettingLabel('model.readOnly');
  return `<span class="settings-info-value" data-info-key="${escSetting(row.infoKey || '')}">${escSetting(displayValue)}</span>`;
}

function renderSettingsRow(row: any) {
  const value = row.path
    ? settingsModel.valueForSetting(row.path, canonicalSettings)
    : undefined;
  return `<div class="mp-settings-row" data-setting-row="${escSetting(row.path || row.label)}" data-save-state="idle">
    <div class="mp-settings-copy"><b>${escSetting(row.label)}</b>${row.description ? `<small>${escSetting(row.description)}</small>` : ''}</div>
    <div class="mp-settings-control">${controlForSetting(row, value)}</div>
    <p class="settings-row-error" hidden></p>
  </div>`;
}

function renderSettingsSection(title: string, rows: any[]) {
  return `<section class="mp-settings-section">
    <h3>${escSetting(title)}</h3>
    <div class="mp-settings-list">${rows.map(renderSettingsRow).join('')}</div>
  </section>`;
}

function renderMemoryLibrary() {
  const memoryTitle = escSetting(settingsModel.formatSettingLabel('memory.title'));
  if (!learnedMemories.length) {
    return `<section class="mp-settings-section mp-memory-library"><h3>${memoryTitle}</h3>
      <div class="mp-memory-empty">${escSetting(settingsModel.formatSettingLabel('memory.empty'))}</div></section>`;
  }
  return `<section class="mp-settings-section mp-memory-library"><h3>${memoryTitle}</h3><div class="mp-memory-list">
    ${learnedMemories
      .slice(0, 12)
      .map(memory => {
        const identity = String(
          memory.object?.windowTitle ||
            memory.object?.label ||
            memory.object?.app ||
            settingsModel.formatSettingLabel('memory.untitled'),
        );
        const questions = Array.isArray(memory.questions)
          ? memory.questions.slice(0, 2)
          : [];
        return `<article class="mp-memory-item"><span class="mp-memory-mark">${settingIcon('ic-memory')}</span>
        <span class="mp-memory-copy"><b>${escSetting(identity)}</b><small>${escSetting(questions.join(' · ') || memory.subtitle || settingsModel.formatSettingLabel('memory.context'))}</small></span>
        <span class="mp-memory-count">${escSetting(settingsModel.formatSettingLabel('memory.uses', {count: Number(memory.touches || 0)}))}</span></article>`;
      })
      .join('')}
  </div></section>`;
}

function renderPluginsPage(page: any) {
  const pluginRow = page.sections[0]?.rows?.[0];
  const description =
    pluginRow?.description ||
    settingsModel.formatSettingLabel('plugins.fallbackDescription');
  const pluginSearchLabel = escSetting(settingsModel.formatSettingLabel('plugins.search'));
  const pluginAddLabel = escSetting(settingsModel.formatSettingLabel('plugins.add'));
  const rows = pluginInventory.length
    ? pluginInventory
        .map(
          item => `<article class="mp-settings-plugin-row">
        <span class="mp-settings-plugin-mark">${settingIcon('ic-plug')}</span>
        <span class="mp-settings-plugin-copy"><strong>${escSetting(item.name || item.id || settingsModel.formatSettingLabel('plugins.unnamed'))}</strong><small>${escSetting(item.description || settingsModel.formatSettingLabel('plugins.localDescription'))}</small></span>
        <span class="mp-settings-plugin-meta">${escSetting(item.status || item.source || settingsModel.formatSettingLabel('plugins.localMeta'))}</span>
        <button type="button" class="mp-settings-plugin-more" aria-label="${escSetting(settingsModel.formatSettingLabel('plugins.moreActions'))}">${settingIcon('ic-dots-vertical')}</button>
      </article>`,
        )
        .join('')
    : `<div class="mp-settings-plugin-empty">${escSetting(settingsModel.formatSettingLabel('plugins.empty'))}<small>${escSetting(description)}</small></div>`;
  const heading = pluginInventory.length
    ? `${escSetting(settingsModel.formatSettingLabel('plugins.heading'))} <span>· ${pluginInventory.length}</span>`
    : escSetting(settingsModel.formatSettingLabel('plugins.heading'));
  return `<section class="mp-settings-page mp-settings-plugins" data-page="${escSetting(page.id)}"${page.ref ? ` data-ref="${escSetting(page.ref)}"` : ''}>
    <header class="mp-settings-page-head mp-settings-plugin-head">
      <div><h2>${escSetting(page.title)}</h2></div>
      <label class="mp-settings-plugin-search">
        ${settingIcon('ic-search')}<input type="search" placeholder="${pluginSearchLabel}" aria-label="${pluginSearchLabel}" />
      </label>
      <button type="button" class="mp-settings-plugin-add">${pluginAddLabel}${settingIcon('ic-chev')}</button>
    </header>
    <div class="mp-settings-plugin-tabs" role="tablist" aria-label="${escSetting(settingsModel.formatSettingLabel('plugins.scope'))}">
      <button type="button" class="is-on" role="tab" aria-selected="true">${escSetting(settingsModel.formatSettingLabel('plugins.tabMine'))}</button>
      <button type="button" role="tab" aria-selected="false">${escSetting(settingsModel.formatSettingLabel('plugins.tabDiscover'))}</button>
    </div>
    <div class="mp-settings-plugin-filters">
      <span></span>
      <div><button type="button">${settingIcon('ic-sliders')}${escSetting(settingsModel.formatSettingLabel('plugins.filter'))}${settingIcon('ic-chev')}</button><button type="button">${settingIcon('ic-sort')}${escSetting(settingsModel.formatSettingLabel('plugins.sort'))}${settingIcon('ic-chev')}</button></div>
    </div>
    <div class="mp-settings-plugin-list">
      <h3>${heading}</h3>
      ${rows}
    </div>
  </section>`;
}

function renderSettingsPage(page: any) {
  if (page.id === 'plugins') {
    return renderPluginsPage(page);
  }
  return `<section class="mp-settings-page" data-page="${escSetting(page.id)}"${page.ref ? ` data-ref="${escSetting(page.ref)}"` : ''}>
    <header class="mp-settings-page-head">
      <div><h2>${escSetting(page.title)}</h2><p>${escSetting(page.description)}</p></div>
    </header>
    <div class="mp-settings-sections">
      ${page.sections.map((section: any) => renderSettingsSection(section.title, section.rows)).join('')}
    </div>
    ${page.id === 'memory-context' ? renderMemoryLibrary() : ''}
  </section>`;
}

function renderSettingsSearchResults(query: string) {
  const needle = query.trim().toLocaleLowerCase();
  const matches: Array<{title: string; rows: any[]}> = [];
  for (const page of settingsModel.SETTINGS_PAGES) {
    for (const section of page.sections) {
      const rows = section.rows.filter((row: any) =>
        [page.title, section.title, row.label, row.description]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle),
      );
      if (rows.length) {
        matches.push({title: `${page.title} · ${section.title}`, rows});
      }
    }
  }
  const count = matches.reduce(
    (total, section) => total + section.rows.length,
    0,
  );
  return `<section class="mp-settings-page" data-page="search">
    <header class="mp-settings-page-head"><div><h2>${escSetting(settingsModel.formatSettingLabel('search.title'))}</h2><p>${escSetting(settingsModel.formatSettingLabel('search.results', {query, count}))}</p></div></header>
    ${
      matches.length
        ? `<div class="mp-settings-sections">${matches.map(section => renderSettingsSection(section.title, section.rows)).join('')}</div>`
        : `<div class="mp-settings-search-empty">${escSetting(settingsModel.formatSettingLabel('search.empty'))}</div>`
    }
  </section>`;
}

function setSettingsStatus(
  state: 'idle' | 'saving' | 'saved' | 'error',
  message = '',
) {
  const status = document.getElementById('settings-save-status');
  if (!status) {
    return;
  }
  status.dataset.state = state;
  status.textContent =
    message ||
    (state === 'saving'
      ? settingsModel.formatSettingLabel('status.saving')
      : state === 'saved'
        ? settingsModel.formatSettingLabel('status.saved')
        : '');
}

function renderSettings() {
  if (!settingsModel) {
    return;
  }
  const nav = document.getElementById('set-nav');
  const body = document.getElementById('set-body');
  if (!nav || !body) {
    return;
  }
  if (
    !settingsModel.SETTINGS_PAGES.some(page => page.id === activeSettingsPage)
  ) {
    activeSettingsPage = settingsModel.SETTINGS_PAGES[0].id;
  }
  const groups = new Map<string, any[]>();
  settingsModel.SETTINGS_PAGES.forEach(page => {
    const group = String(page.group || 'Settings');
    groups.set(group, [...(groups.get(group) || []), page]);
  });
  nav.innerHTML = [...groups.entries()]
    .map(
      ([group, pages]) => `<section class="settings-nav-group">
    <h2>${escSetting(group)}</h2>
    ${pages
      .map(
        page => `<button type="button" class="settings-nav-item${!settingsQuery && page.id === activeSettingsPage ? ' is-on' : ''}"
      data-settings-page="${escSetting(page.id)}"${page.ref ? ` data-ref="${escSetting(page.ref)}" title="${escSetting(page.ref)}"` : ''}>${settingIcon(page.icon)}<span>${escSetting(page.title)}</span></button>`,
      )
      .join('')}
  </section>`,
    )
    .join('');
  const search = document.getElementById(
    'settings-search',
  ) as HTMLInputElement | null;
  if (search && search.value !== settingsQuery) {
    search.value = settingsQuery;
  }
  if (settingsQuery.trim()) {
    body.innerHTML = renderSettingsSearchResults(settingsQuery);
    return;
  }
  const page = settingsModel.SETTINGS_PAGES.find(
    entry => entry.id === activeSettingsPage,
  );
  body.innerHTML = renderSettingsPage(page);
}

function hydrateCanonical(
  settings: unknown,
  modelStatus: unknown = activeModelStatus,
) {
  canonicalSettings =
    settings && typeof settings === 'object' ? structuredClone(settings) : {};
  activeModelStatus =
    modelStatus && typeof modelStatus === 'object'
      ? structuredClone(modelStatus)
      : {};
  settingsHydrated = true;
  renderSettings();
  const theme = canonicalSettings.appearance?.theme;
  if (theme) {
    const resolvedTheme =
      theme === 'system'
        ? systemThemeQuery.matches
          ? 'dark'
          : 'light'
        : theme;
    document.documentElement.dataset.theme = resolvedTheme;
    document.body.toggleAttribute(
      'data-ds-dark-theme',
      resolvedTheme === 'dark',
    );
    try {
      localStorage.setItem('mp:theme', resolvedTheme);
    } catch {
      /* storage unavailable */
    }
    settingsApi()?.setTheme?.(theme);
  }
}

systemThemeQuery.addEventListener('change', () => {
  if (canonicalSettings.appearance?.theme !== 'system') {
    return;
  }
  const dark = systemThemeQuery.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.body.toggleAttribute('data-ds-dark-theme', dark);
});

async function persistSetting(path: string, value: unknown) {
  const api = settingsApi();
  if (!api?.saveFabricSettings) {
    return;
  }
  const before = structuredClone(canonicalSettings);
  const patch = settingsModel.patchForSetting(path, value);
  const row = document.querySelector<HTMLElement>(
    `[data-setting-row="${CSS.escape(path)}"]`,
  );
  if (row) {
    row.dataset.saveState = 'saving';
  }
  setSettingsStatus('saving');
  try {
    const response = await api.saveFabricSettings(patch);
    if (!response?.ok || !response.settings) {
      throw new Error(
        response?.error || 'The main process did not confirm this setting.',
      );
    }
    hydrateCanonical(response.settings);
    const savedRow = document.querySelector<HTMLElement>(
      `[data-setting-row="${CSS.escape(path)}"]`,
    );
    if (savedRow) {
      savedRow.dataset.saveState = 'saved';
    }
    setSettingsStatus('saved');
  } catch (error) {
    hydrateCanonical(before);
    const failedRow = document.querySelector<HTMLElement>(
      `[data-setting-row="${CSS.escape(path)}"]`,
    );
    if (failedRow) {
      failedRow.dataset.saveState = 'error';
      const message = failedRow.querySelector<HTMLElement>(
        '.settings-row-error',
      );
      if (message) {
        message.hidden = false;
        message.textContent =
          error instanceof Error ? error.message : String(error);
      }
    }
    setSettingsStatus(
      'error',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function queueSettingSave(path: string, value: unknown) {
  settingsSaveQueue = settingsSaveQueue.then(() => persistSetting(path, value));
}

function parseSettingValue(element: HTMLInputElement | HTMLSelectElement) {
  const control = element.dataset.control;
  if (control === 'select') {
    try {
      return JSON.parse(element.value);
    } catch (_) {
      return element.value;
    }
  }
  if (control === 'range') {
    return Number(element.value);
  }
  if (control === 'tags') {
    return element.value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  return element.value;
}

document.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const pluginTab = target.closest<HTMLButtonElement>(
    '.mp-settings-plugin-tabs [role="tab"]',
  );
  if (pluginTab) {
    const tabs = pluginTab.parentElement;
    tabs?.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach(tab => {
      const selected = tab === pluginTab;
      tab.classList.toggle('is-on', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    const list = document.querySelector<HTMLElement>(
      '.mp-settings-plugin-list',
    );
    if (list) {
      list.hidden =
        pluginTab.textContent?.trim() !==
        settingsModel.formatSettingLabel('plugins.tabMine');
    }
    return;
  }
  if (target.closest('.mp-settings-plugin-add')) {
    document.querySelector<HTMLElement>('[data-directory-open]')?.click();
    return;
  }
  const nav = target.closest<HTMLElement>('[data-settings-page]');
  if (nav) {
    activeSettingsPage = nav.dataset.settingsPage || 'general';
    settingsQuery = '';
    renderSettings();
    return;
  }
  const toggle = target.closest<HTMLElement>(
    '[data-control="toggle"][data-setting]',
  );
  if (!toggle) {
    return;
  }
  const next = toggle.getAttribute('aria-checked') !== 'true';
  toggle.setAttribute('aria-checked', String(next));
  toggle.classList.toggle('is-on', next);
  queueSettingSave(toggle.dataset.setting || '', next);
});

document.addEventListener('input', event => {
  const pluginSearch = (event.target as HTMLElement).closest<HTMLInputElement>(
    '.mp-settings-plugin-search input',
  );
  if (pluginSearch) {
    const query = pluginSearch.value.trim().toLocaleLowerCase();
    document
      .querySelectorAll<HTMLElement>('.mp-settings-plugin-row')
      .forEach(row => {
        row.hidden =
          Boolean(query) &&
          !row.textContent?.toLocaleLowerCase().includes(query);
      });
    return;
  }
  const search = (event.target as HTMLElement).closest<HTMLInputElement>(
    '#settings-search',
  );
  if (search) {
    settingsQuery = search.value;
    renderSettings();
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
    return;
  }
  const range = (event.target as HTMLElement).closest<HTMLInputElement>(
    '[data-control="range"]',
  );
  if (range) {
    range.parentElement
      ?.querySelector('output')
      ?.replaceChildren(String(range.value));
  }
});

document.addEventListener('change', event => {
  const control = (event.target as HTMLElement).closest<
    HTMLInputElement | HTMLSelectElement
  >('[data-setting]');
  if (!control || control.dataset.control === 'toggle') {
    return;
  }
  queueSettingSave(control.dataset.setting || '', parseSettingValue(control));
});

async function hydrateSettings() {
  const api = settingsApi();
  if (!api?.getFabricSettings) {
    return;
  }
  try {
    const memoryPromise = api.conversations?.memories
      ? api.conversations.memories()
      : Promise.resolve([]);
    const [response, memories, inventory] = await Promise.all([
      api.getFabricSettings(),
      memoryPromise,
      api.extensions?.inventory ? api.extensions.inventory() : Promise.resolve(null),
    ]);
    learnedMemories = Array.isArray(memories) ? memories : [];
    const items = inventory?.plugins?.items || inventory?.items;
    pluginInventory = Array.isArray(items) ? items : [];
    if (response?.ok && response.settings) {
      hydrateCanonical(response.settings, response.modelStatus);
    } else {
      setSettingsStatus('error', response?.error || 'Settings did not load.');
    }
  } catch (error) {
    setSettingsStatus(
      'error',
      error instanceof Error ? error.message : String(error),
    );
  }
}

if (!settingsHydrated) {
  void hydrateSettings();
}
