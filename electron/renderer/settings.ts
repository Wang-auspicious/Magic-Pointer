'use strict';

/* exported renderSettings */

type SettingsApi = {
  getFabricSettings?: () => Promise<any>;
  saveFabricSettings?: (patch: unknown) => Promise<any>;
  setTheme?: (theme: unknown) => void;
};

type SettingsModelApi = {
  SETTINGS_PAGES: any[];
  modelInfoValue(key: string, status: Record<string, any>): string;
  patchForSetting(path: string, value: unknown): Record<string, unknown>;
  valueForSetting(path: string, settings: Record<string, any>): unknown;
};

const settingsModel = (globalThis as any).SettingsModel as SettingsModelApi;
let canonicalSettings: Record<string, any> = {};
let activeModelStatus: Record<string, any> = {};
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
      ${(row.options || []).map((entry: any) => `<option value="${escSetting(JSON.stringify(entry.value))}"
        ${entry.value === value ? 'selected' : ''}>${escSetting(entry.label)}</option>`).join('')}
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
    ? settingsModel.modelInfoValue(row.infoKey, activeModelStatus)
    : row.label === '范围授权'
      ? Array.isArray(canonicalSettings.permissions?.scoped_grants) ? canonicalSettings.permissions.scoped_grants.length : 0
      : null;
  const displayValue = typeof infoValue === 'number' ? `${infoValue} 项` : infoValue || '只读';
  return `<span class="settings-info-value" data-info-key="${escSetting(row.infoKey || '')}">${escSetting(displayValue)}</span>`;
}

function renderSettingsRow(row: any) {
  const value = row.path ? settingsModel.valueForSetting(row.path, canonicalSettings) : undefined;
  return `<div class="settings-row" data-setting-row="${escSetting(row.path || row.label)}" data-save-state="idle">
    <div class="settings-copy"><b>${escSetting(row.label)}</b>${row.description ? `<small>${escSetting(row.description)}</small>` : ''}</div>
    <div class="settings-control">${controlForSetting(row, value)}</div>
    <p class="settings-row-error" hidden></p>
  </div>`;
}

function renderSettingsSection(title: string, rows: any[]) {
  return `<section class="settings-section">
    <h3>${escSetting(title)}</h3>
    <div class="settings-section-frame">${rows.map(renderSettingsRow).join('')}</div>
  </section>`;
}

function renderSettingsPage(page: any) {
  return `<section class="settings-page" data-page="${escSetting(page.id)}">
    <header class="settings-page-head">
      <div><h2>${escSetting(page.title)}</h2><p>${escSetting(page.description)}</p></div>
    </header>
    <div class="settings-sections">
      ${page.sections.map((section: any) => renderSettingsSection(section.title, section.rows)).join('')}
    </div>
  </section>`;
}

function renderSettingsSearchResults(query: string) {
  const needle = query.trim().toLocaleLowerCase();
  const matches: { title: string; rows: any[] }[] = [];
  for (const page of settingsModel.SETTINGS_PAGES) {
    for (const section of page.sections) {
      const rows = section.rows.filter((row: any) => [page.title, section.title, row.label, row.description]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle));
      if (rows.length) matches.push({ title: `${page.title} · ${section.title}`, rows });
    }
  }
  const count = matches.reduce((total, section) => total + section.rows.length, 0);
  return `<section class="settings-page" data-page="search">
    <header class="settings-page-head"><div><h2>搜索设置</h2><p>“${escSetting(query)}” · ${count} 项</p></div></header>
    ${matches.length
      ? `<div class="settings-sections">${matches.map((section) => renderSettingsSection(section.title, section.rows)).join('')}</div>`
      : '<div class="settings-search-empty">没有匹配的设置。</div>'}
  </section>`;
}

function setSettingsStatus(state: 'idle' | 'saving' | 'saved' | 'error', message = '') {
  const status = document.getElementById('settings-save-status');
  if (!status) return;
  status.dataset.state = state;
  status.textContent = message || (state === 'saving' ? '正在保存…' : state === 'saved' ? '已保存' : '');
}

function renderSettings() {
  if (!settingsModel) return;
  const nav = document.getElementById('set-nav');
  const body = document.getElementById('set-body');
  if (!nav || !body) return;
  if (!settingsModel.SETTINGS_PAGES.some((page) => page.id === activeSettingsPage)) {
    activeSettingsPage = settingsModel.SETTINGS_PAGES[0].id;
  }
  nav.innerHTML = settingsModel.SETTINGS_PAGES.map((page) => `<button type="button" class="settings-nav-item${!settingsQuery && page.id === activeSettingsPage ? ' is-on' : ''}"
    data-settings-page="${escSetting(page.id)}">${settingIcon(page.icon)}<span>${escSetting(page.title)}</span></button>`).join('');
  const search = document.getElementById('settings-search') as HTMLInputElement | null;
  if (search && search.value !== settingsQuery) search.value = settingsQuery;
  if (settingsQuery.trim()) {
    body.innerHTML = renderSettingsSearchResults(settingsQuery);
    return;
  }
  const page = settingsModel.SETTINGS_PAGES.find((entry) => entry.id === activeSettingsPage);
  body.innerHTML = renderSettingsPage(page);
}

function hydrateCanonical(settings: unknown, modelStatus: unknown = activeModelStatus) {
  canonicalSettings = settings && typeof settings === 'object' ? structuredClone(settings) : {};
  activeModelStatus = modelStatus && typeof modelStatus === 'object' ? structuredClone(modelStatus) : {};
  settingsHydrated = true;
  renderSettings();
  const theme = canonicalSettings.appearance?.theme;
  if (theme) {
    const resolvedTheme = theme === 'system' ? (systemThemeQuery.matches ? 'dark' : 'light') : theme;
    document.documentElement.dataset.theme = resolvedTheme;
    settingsApi()?.setTheme?.(theme);
  }
}

systemThemeQuery.addEventListener('change', () => {
  if (canonicalSettings.appearance?.theme !== 'system') return;
  document.documentElement.dataset.theme = systemThemeQuery.matches ? 'dark' : 'light';
});

async function persistSetting(path: string, value: unknown) {
  const api = settingsApi();
  if (!api?.saveFabricSettings) return;
  const before = structuredClone(canonicalSettings);
  const patch = settingsModel.patchForSetting(path, value);
  const row = document.querySelector<HTMLElement>(`[data-setting-row="${CSS.escape(path)}"]`);
  if (row) row.dataset.saveState = 'saving';
  setSettingsStatus('saving');
  try {
    const response = await api.saveFabricSettings(patch);
    if (!response?.ok || !response.settings) throw new Error(response?.error || '主进程没有确认这次设置。');
    hydrateCanonical(response.settings);
    const savedRow = document.querySelector<HTMLElement>(`[data-setting-row="${CSS.escape(path)}"]`);
    if (savedRow) savedRow.dataset.saveState = 'saved';
    setSettingsStatus('saved');
  } catch (error) {
    hydrateCanonical(before);
    const failedRow = document.querySelector<HTMLElement>(`[data-setting-row="${CSS.escape(path)}"]`);
    if (failedRow) {
      failedRow.dataset.saveState = 'error';
      const message = failedRow.querySelector<HTMLElement>('.settings-row-error');
      if (message) {
        message.hidden = false;
        message.textContent = error instanceof Error ? error.message : String(error);
      }
    }
    setSettingsStatus('error', error instanceof Error ? error.message : String(error));
  }
}

function queueSettingSave(path: string, value: unknown) {
  settingsSaveQueue = settingsSaveQueue.then(() => persistSetting(path, value));
}

function parseSettingValue(element: HTMLInputElement | HTMLSelectElement) {
  const control = element.dataset.control;
  if (control === 'select') {
    try { return JSON.parse(element.value); } catch (_) { return element.value; }
  }
  if (control === 'range') return Number(element.value);
  if (control === 'tags') return element.value.split(',').map((item) => item.trim()).filter(Boolean);
  return element.value;
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const nav = target.closest<HTMLElement>('[data-settings-page]');
  if (nav) {
    activeSettingsPage = nav.dataset.settingsPage || 'general';
    settingsQuery = '';
    renderSettings();
    return;
  }
  const toggle = target.closest<HTMLElement>('[data-control="toggle"][data-setting]');
  if (!toggle) return;
  const next = toggle.getAttribute('aria-checked') !== 'true';
  toggle.setAttribute('aria-checked', String(next));
  toggle.classList.toggle('is-on', next);
  queueSettingSave(toggle.dataset.setting || '', next);
});

document.addEventListener('input', (event) => {
  const search = (event.target as HTMLElement).closest<HTMLInputElement>('#settings-search');
  if (search) {
    settingsQuery = search.value;
    renderSettings();
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
    return;
  }
  const range = (event.target as HTMLElement).closest<HTMLInputElement>('[data-control="range"]');
  if (range) range.parentElement?.querySelector('output')?.replaceChildren(String(range.value));
});

document.addEventListener('change', (event) => {
  const control = (event.target as HTMLElement).closest<HTMLInputElement | HTMLSelectElement>('[data-setting]');
  if (!control || control.dataset.control === 'toggle') return;
  queueSettingSave(control.dataset.setting || '', parseSettingValue(control));
});

async function hydrateSettings() {
  const api = settingsApi();
  if (!api?.getFabricSettings) return;
  try {
    const response = await api.getFabricSettings();
    if (response?.ok && response.settings) hydrateCanonical(response.settings, response.modelStatus);
    else setSettingsStatus('error', response?.error || '设置没有载入。');
  } catch (error) {
    setSettingsStatus('error', error instanceof Error ? error.message : String(error));
  }
}

if (!settingsHydrated) void hydrateSettings();
