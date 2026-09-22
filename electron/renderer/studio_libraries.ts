'use strict';

(() => {
type Row = { id: string; title?: string; createdAt?: number; updatedAt?: number; workspaceRoot?: string; taskContext?: any; agentSessionId?: string; hasPendingWork?: boolean; turns?: any[] };
type SessionPreference = { pinned?: boolean; archived?: boolean; group?: string; seenAt?: number; order?: number };
type Filters = { type: string; status: string; days: string; group: string; sort: string };
type Preferences = { filters: Filters; sessions: Record<string, SessionPreference>; hiddenNavigation: string[] };
const STORAGE_KEY = 'mp:library-preferences';
const defaults: Filters = { type: 'all', status: 'active', days: 'all', group: 'project', sort: 'activity' };
function loadPreferences(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { filters: { ...defaults, ...stored.filters }, sessions: stored.sessions || {}, hiddenNavigation: stored.hiddenNavigation || [] };
  } catch { return { filters: { ...defaults }, sessions: {}, hiddenNavigation: [] }; }
}
const preferences = loadPreferences();
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* readonly browser storage */ } }
function setFilter(key: keyof Filters, value: string) { preferences.filters[key] = value; save(); }
function sessionPreference(id: string): SessionPreference { return preferences.sessions[id] || {}; }
function sessionGroups(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(preferences.sessions)) {
    const group = String(value.group || '').trim();
    if (group) names.add(group);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
function setSessionGroup(id: string, group: string) { setSessionPreference(id, { group }); }
function setSessionPreference(id: string, patch: SessionPreference) { preferences.sessions[id] = { ...sessionPreference(id), ...patch }; save(); }
function movePinned(id: string, direction: number) {
  const pinned = Object.entries(preferences.sessions).filter(([, value]) => value.pinned).sort((a, b) => (a[1].order || 0) - (b[1].order || 0)).map(([key]) => key);
  const index = pinned.indexOf(id); const next = index + direction;
  if (index < 0 || next < 0 || next >= pinned.length) return;
  pinned.splice(index, 1); pinned.splice(next, 0, id);
  pinned.forEach((key, order) => { preferences.sessions[key].order = order; }); save();
}
function isTask(row: Row) { return Boolean(row.taskContext?.taskId || row.agentSessionId || row.hasPendingWork); }
function filterRows(rows: readonly Row[], query = '', now = Date.now()) {
  const filters = preferences.filters;
  const cutoff = filters.days === 'all' ? 0 : now - Number(filters.days) * 86400000;
  return rows.filter(row => {
    const local = sessionPreference(row.id);
    if (filters.status !== 'all' && Boolean(local.archived) !== (filters.status === 'archived')) return false;
    if (filters.type !== 'all' && isTask(row) !== (filters.type === 'task')) return false;
    return Number(row.updatedAt || 0) >= cutoff && (!query || `${row.title || ''} ${row.workspaceRoot || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  }).sort((a, b) => filters.sort === 'name' ? String(a.title || '').localeCompare(String(b.title || ''))
    : filters.sort === 'created' ? Number(b.createdAt || b.turns?.[0]?.at || 0) - Number(a.createdAt || a.turns?.[0]?.at || 0)
      : Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
type Section = { key: string; label: string; items: Row[]; virtual?: boolean };
function sections(rows: readonly Row[], projectGroups: Section[]) {
  const pinned = rows.filter(row => sessionPreference(row.id).pinned).sort((a, b) => (sessionPreference(a.id).order || 0) - (sessionPreference(b.id).order || 0));
  const rest = rows.filter(row => !sessionPreference(row.id).pinned);
  const groups: Section[] = pinned.length ? [{ key: '__pinned__', label: 'Pinned', items: pinned, virtual: true }] : [];
  if (preferences.filters.group === 'project') return groups.concat(projectGroups.map(group => ({ ...group, items: group.items.filter(row => !sessionPreference(row.id).pinned) })));
  const buckets = new Map<string, Row[]>();
  for (const row of rest) {
    const local = sessionPreference(row.id);
    const label = preferences.filters.group === 'custom' ? local.group || 'Ungrouped'
      : preferences.filters.group === 'type' ? isTask(row) ? 'Tasks' : 'Chats'
      : preferences.filters.group === 'unread' ? Number(row.updatedAt || 0) > Number(local.seenAt || 0) ? 'Unread' : 'Read'
      : preferences.filters.group === 'state' ? row.hasPendingWork ? 'In progress' : 'Completed'
      : preferences.filters.group === 'date' ? new Date(Number(row.updatedAt || 0)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : 'Chats and tasks';
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label)!.push(row);
  }
  return groups.concat([...buckets].map(([label, items]) => ({ key: `__group__${label}`, label, items, virtual: true })));
}
function scheduledSources(rows: readonly Row[]) {
  return rows.flatMap(row => (row.taskContext?.sources || []).filter((source: any) => source.identity?.absolutePath).map((source: any) => ({
    conversationId: row.id, sourceId: String(source.sourceId), label: `${source.title || source.identity.absolutePath} · ${row.title || 'Task'}`,
  })));
}
function nextScheduledRun(row: any) {
  if (!row.enabled || row.trigger?.kind !== 'schedule') return Infinity;
  const prior = row.lastRun?.triggerKind === 'schedule' ? Number(row.lastRun.dueThroughMs) : NaN;
  return Number.isFinite(prior) ? prior + Number(row.trigger.everyMs) : Number(row.trigger.startAtMs);
}
function sortProjects(items: MagicPointerProject[], rows: readonly Row[], sort: string) {
  const activity = (item: MagicPointerProject) => Math.max(Number(item.lastOpenedAt || 0), ...rows.filter(row => row.workspaceRoot === item.root).map(row => Number(row.updatedAt || 0)));
  return [...items].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'created' ? Number(b.addedAt || 0) - Number(a.addedAt || 0) : activity(b) - activity(a));
}
function sortSkills(items: MagicPointerSlashEntry[], sort: string) {
  return [...items].sort((a, b) => sort === 'edited' ? Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0) : sort === 'source' ? String(a.source || '').localeCompare(String(b.source || '')) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
}
function designRows(items: any[], tab = 'designs', query = '') {
  return items.filter(item => {
    const kind = String(item.kind || '');
    const system = ['design_system', 'design-system'].includes(kind);
    const visual = system || ['design', 'image', 'figma', 'figma_patch'].includes(kind) || /\.(?:svg|png|jpe?g|webp|html|fig)$/i.test(String(item.name || ''));
    return visual && (tab === 'systems' ? system : !system) && `${item.name || ''} ${item.summary || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  });
}
function escape(value: unknown) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function artifactPreviewMarkup(entry: any, content = '') {
  const text = String(content || entry.summary || '');
  const image = text.trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i.test(image)) return `<img class="mp-artifact-image-preview" src="${escape(image)}" alt="" loading="lazy" />`;
  if ((String(entry.kind) === 'image' || /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(String(entry.name))) && /^(?:[a-z]:[\\/]|file:\/\/\/)[^\r\n]+\.(?:png|jpe?g|gif|webp|bmp)$/i.test(image)) {
    const source = /^file:/i.test(image) ? image : `file:///${image.replaceAll('\\', '/')}`;
    return `<img class="mp-artifact-image-preview" src="${escape(encodeURI(source))}" alt="" loading="lazy" />`;
  }
  if (/\.(?:html?|svg)$/i.test(String(entry.name || '')) || /^\s*(?:<!doctype html|<html\b|<svg\b|<main\b)/i.test(text)) {
    const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: file:; font-src data:; form-action 'none'; base-uri 'none'";
    let markup = text;
    if (typeof DOMParser !== 'undefined') {
      const parsed = new DOMParser().parseFromString(text, 'text/html');
      parsed.querySelectorAll('script,iframe,object,embed,meta,base,link').forEach(node => node.remove());
      markup = parsed.documentElement.outerHTML;
    }
    const document = `<html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;min-height:100%;overflow:hidden}svg{max-width:100%;height:auto}</style></head><body>${markup}</body></html>`;
    return `<iframe class="mp-artifact-html-preview" title="${escape(entry.name || 'Artifact preview')}" sandbox="" tabindex="-1" srcdoc="${escape(document)}"></iframe>`;
  }
  return `<strong>${escape(entry.name || '')}</strong><span>${escape(text.slice(0, 1800))}</span>`;
}
function artifactDateGroups(items: any[], now = Date.now()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const buckets = new Map<string, any[]>();
  for (const item of [...items].sort((a, b) => Number(b.at || 0) - Number(a.at || 0))) {
    const date = new Date(Number(item.at || 0)); date.setHours(0, 0, 0, 0);
    const label = !item.at ? 'Earlier' : date.getTime() === today.getTime() ? 'Today' : date.getTime() === today.getTime() - 86400000 ? 'Yesterday' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (!buckets.has(label)) buckets.set(label, []); buckets.get(label)!.push(item);
  }
  return [...buckets].map(([label, entries]) => ({ label, items: entries }));
}
async function applyBulkConversationAction(ids: string[], action: string, remove: (id: string) => Promise<{ ok?: boolean; error?: string }>) {
  const completed: string[] = []; const errors: string[] = [];
  for (const id of ids) {
    if (action === 'delete') {
      try { const response = await remove(id); if (!response.ok) { errors.push(response.error || `Unable to delete ${id}`); continue; } }
      catch (reason) { errors.push(reason instanceof Error ? reason.message : String(reason)); continue; }
    } else setSessionPreference(id, { archived: action === 'archive' });
    completed.push(id);
  }
  return { completed, errors };
}
function glyph(name: string, size = 'small') { return (globalThis as any).CdsIcons.html(name, size); }
const pictograms = new Map<string, string>();
type Preview = { html: string; timeline?: { durationMs: number; tracks: Array<{ part: string; keyframes: Keyframe[] }> } };
let previews: Record<string, Preview> = {};
let pictogramsLoading: Promise<void> | null = null;
function loadPictograms() {
  if (!pictogramsLoading) pictogramsLoading = Promise.all([ ...['HandBlocks', 'HandShapes', 'ObjectStopwatch'].map(async name => {
    const response = await fetch(`assets/library-previews/${name}.svg`);
    if (response.ok) pictograms.set(name, await response.text());
  }), fetch('assets/library-previews/artifact-previews.json').then(async response => { if (response.ok) previews = await response.json(); }) ]).then(() => undefined).catch(() => undefined);
  return pictogramsLoading;
}
function pictogram(name: string) { return `<span class="mp-library-pictogram" aria-hidden="true">${pictograms.get(name) || ''}</span>`; }
function mountPreviews(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-original-preview]').forEach(host => {
    if (host.dataset.previewMounted) return;
    const preview = previews[String(host.dataset.originalPreview)];
    if (!preview) return;
    host.dataset.previewMounted = 'true'; host.innerHTML = preview.html;
    const button = host.closest('button');
    if (!button || !preview.timeline) return;
    const timeline = preview.timeline;
    let animations: Animation[] | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.reduceMotion === 'true';
    function stop() { clearTimeout(timer); const current = animations; animations = null; current?.forEach(animation => animation.cancel()); }
    function play() {
      if (!host.isConnected || reduced()) { stop(); return; }
      const current = timeline.tracks.flatMap(track => Array.from(host.querySelectorAll<HTMLElement>(`[data-preview-part="${track.part}"]`), element => element.animate([...track.keyframes], { duration: timeline.durationMs })));
      if (!current.length) return;
      animations = current;
      void Promise.all(current.map(animation => animation.finished)).then(() => { if (animations === current) play(); }, () => { if (animations === current) animations = null; });
    }
    function start() { if (!animations && timer === undefined && !reduced()) timer = setTimeout(() => { timer = undefined; play(); }, 150); }
    button.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') start(); });
    button.addEventListener('pointerleave', () => { if (!button.matches(':focus-visible')) { stop(); timer = undefined; } });
    button.addEventListener('focus', () => { if (button.matches(':focus-visible')) start(); });
    button.addEventListener('blur', () => { if (!button.matches(':hover')) { stop(); timer = undefined; } });
  });
}
function inventoryErrors(inventory: any) {
  return [inventory?.plugins?.error ? `Plugins: ${inventory.plugins.error}` : '', inventory?.mcp?.error ? `MCP: ${inventory.mcp.error}` : ''].filter(Boolean).join(' · ');
}
function submenuSide(left: number, width: number, viewportWidth: number) {
  return left + width + 190 > viewportWidth - 8 ? 'left' : 'right';
}
function chatsHeadingMarkup(selecting: boolean, searching: boolean, query: string) {
  return `<div class="mp-chats-heading"><h1>Chats and tasks</h1><div class="mp-library-toolbar"><button type="button" data-chat-search-toggle aria-label="Search chats" aria-expanded="${searching}">${glyph('search')}</button><button type="button" data-library-filters aria-label="Filter chats">${glyph('group-sort')}</button><button type="button" data-chat-selection>${selecting ? 'Done' : 'Select'}</button><button type="button" class="mp-library-primary" data-library-compose="">New</button></div></div>${searching ? `<label class="mp-library-search mp-chat-search">${glyph('search')}<input type="search" data-library-search placeholder="Search chats" value="${escape(query)}" aria-label="Search chats" /></label>` : ''}`;
}
function pluginDirectoryMarkup(plugins: any[], tab: string) {
  return `<div class="${tab === 'yours' ? 'mp-library-list' : 'mp-library-cards'}">${plugins.map(row => `<div class="${tab === 'yours' ? 'mp-library-list-row mp-plugin-row' : 'mp-library-card'}">${glyph('attach-plugins', 'large')}<div><strong>${escape(row.name)}</strong><p>${escape(row.description || '')}</p>${row.error ? `<p class="mp-library-error">${escape(row.error)}</p>` : ''}</div><small>${escape(row.state || row.source || 'Local')}</small></div>`).join('')}</div>`;
}
function projectOptionsMarkup(projects: MagicPointerProject[], currentRoot: string, query = '') {
  const rows = projects.filter(project => `${project.name} ${project.root}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return `${!query ? `<button type="button" data-project-root="" role="menuitemradio" aria-checked="${!currentRoot}"><span>No project</span>${!currentRoot ? glyph('check') : ''}</button>` : ''}${rows.map(project => `<button type="button" data-project-root="${escape(project.root)}" role="menuitemradio" aria-checked="${project.root === currentRoot}"><span>${escape(project.name)}</span>${project.root === currentRoot ? glyph('check') : ''}</button>`).join('')}${!rows.length ? `<p class="mp-library-note">${query ? 'No matching projects' : 'No projects yet'}</p>` : ''}`;
}
type FilterOption = [string, string, boolean?];
const FILTER_OPTIONS: Record<keyof Filters, FilterOption[]> = {
  type: [['all', 'All'], ['chat', 'Chat'], ['task', 'Task']],
  status: [['active', 'Active'], ['archived', 'Archived'], ['all', 'All']],
  days: [['all', 'All'], ['1', '1 day'], ['3', '3 days'], ['7', '7 days'], ['30', '30 days']],
  group: [['date', 'Date'], ['type', 'Type'], ['unread', 'Unread'], ['state', 'State'], ['custom', 'Custom groups'], ['project', 'Projects'], ['none', 'None', true]],
  sort: [['name', 'Name'], ['created', 'Date created'], ['activity', 'Last activity']],
};
const FILTER_LABELS: Record<keyof Filters, string> = { type: 'Type', status: 'Status', days: 'Last activity', group: 'Group by', sort: 'Sort by' };
interface ControllerOptions {
  data: MagicPointerDataApi;
  show(view: string): void;
  compose(prompt: string): void;
  openProject(): Promise<void>;
  selectProject(root: string): void;
  renameConversation(id: string, title: string): void;
  changeProject(id: string, anchor: HTMLElement): void;
  refreshSidebar(): Promise<void>;
  requestText(title: string, initial?: string, maximum?: number): Promise<string | null>;
  connectFigma(): void;
  conversationId(): string | null;
}
function createController(options: ControllerOptions) {
  let activeView = '';
  let query = '';
  let customizeTab = 'skills';
  let directoryTab = 'yours';
  let selectedSource = 'all';
  let connectorFilter = 'all';
  let designTab = 'designs';
  let designLayout: 'list' | 'grid' = 'list';
  let projectSort = 'activity';
  let scheduleSort = 'next';
  let skillSort = 'name';
  let selectingChats = false;
  let searchingChats = false;
  let searchingProjects = false;
  const selectedChats = new Set<string>();
  let bulkBusy = false;
  let designArtifacts: any[] = [];
  const designContents = new Map<string, string>();
  let conversations: Row[] = [];
  let projects: MagicPointerProject[] = [];
  let catalog: MagicPointerSlashDirectory | null = null;
  let trackers: any[] = [];
  let error = '';
  let customInventory: { plugins?: any[]; connectors?: any[] } = {};
  let figmaConnected = false;
  const hosts = ['projects', 'scheduled', 'customize', 'chats', 'designs'];
  const root = document.createElement('div');
  root.className = 'mp-library-popover'; root.hidden = true;
  root.setAttribute('role', 'menu'); document.body.append(root);
  let anchor: HTMLElement | null = null;
  function closeMenu() { root.hidden = true; anchor?.setAttribute('aria-expanded', 'false'); }
  function positionMenu(button: HTMLElement) {
    anchor = button; const bounds = button.getBoundingClientRect();
    root.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 260))}px`;
    root.style.top = `${Math.min(bounds.bottom + 6, window.innerHeight - 340)}px`;
    root.hidden = false; button.setAttribute('aria-expanded', 'true');
    const menuBounds = root.getBoundingClientRect();
    root.dataset.submenuSide = submenuSide(menuBounds.left, menuBounds.width, window.innerWidth);
  }
  function changed() { void options.refreshSidebar(); if (activeView === 'chats') paint(); }
  function filterMenu(button: HTMLElement) {
    root.innerHTML = (Object.keys(FILTER_LABELS) as Array<keyof Filters>).map((key, index) => `<div class="mp-library-menu-group${index === 3 ? ' has-divider' : ''}"><button type="button" class="mp-library-menu-parent">${FILTER_LABELS[key]}<span>${FILTER_OPTIONS[key].find(([value]) => value === preferences.filters[key])?.[1] || ''}${glyph('chevron-section', 'micro')}</span></button><div class="mp-library-submenu" role="menu">${FILTER_OPTIONS[key].map(([value, label, separatorBefore]) => `${separatorBefore ? '<hr />' : ''}<button type="button" role="menuitemradio" aria-checked="${preferences.filters[key] === value}" data-library-filter="${key}" data-value="${value}"><span>${label}</span>${preferences.filters[key] === value ? glyph('check') : ''}</button>`).join('')}</div></div>`).join('');
    positionMenu(button);
  }
  root.addEventListener('click', event => {
    const target = event.target as Element;
    const filter = target.closest<HTMLElement>('[data-library-filter]');
    if (filter) { setFilter(filter.dataset.libraryFilter as keyof Filters, String(filter.dataset.value)); closeMenu(); changed(); }
    const edit = target.closest('[data-edit-sidebar]');
    if (edit) {
      root.innerHTML = '<div class="mp-library-menu-heading">Sidebar</div>' + ['projects', 'artifacts', 'scheduled', 'designs', 'customize'].map(id => `<label class="mp-library-nav-option"><input type="checkbox" data-nav-visibility="${id}" ${preferences.hiddenNavigation.includes(id) ? '' : 'checked'} /><span>${id === 'designs' ? 'Design' : id[0].toUpperCase() + id.slice(1)}</span></label>`).join('');
    }
    const restore = target.closest<HTMLElement>('[data-restore-nav]');
    if (restore) { options.show(String(restore.dataset.restoreNav)); closeMenu(); }
  });
  root.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    if (!input.dataset.navVisibility) return;
    const id = input.dataset.navVisibility;
    preferences.hiddenNavigation = preferences.hiddenNavigation.filter(value => value !== id);
    if (!input.checked) preferences.hiddenNavigation.push(id);
    save(); applyNavigation();
  });
  function applyNavigation() { document.querySelectorAll<HTMLElement>('[data-library-nav]').forEach(button => { button.hidden = preferences.hiddenNavigation.includes(String(button.dataset.libraryNav)); }); }
  document.getElementById('sidebar-more')?.addEventListener('click', event => {
    if (!root.hidden && anchor === event.currentTarget) { closeMenu(); return; }
    root.innerHTML = preferences.hiddenNavigation.map(id => `<button type="button" data-restore-nav="${id}">${glyph(id === 'designs' ? 'design' : id)}<span>${id === 'designs' ? 'Design' : id[0].toUpperCase() + id.slice(1)}</span></button>`).join('') + `<button type="button" data-edit-sidebar>${glyph('mode-write')}<span>Edit sidebar…</span></button>`;
    positionMenu(event.currentTarget as HTMLElement);
  });
  document.getElementById('sidebar-group-sort')?.addEventListener('click', event => filterMenu(event.currentTarget as HTMLElement));
  document.addEventListener('pointerdown', event => { if (!root.contains(event.target as Node) && !anchor?.contains(event.target as Node) && !(event.target as Element).closest('.mp-project-assignment')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
  applyNavigation();
  document.getElementById('nav-artifact-create')?.addEventListener('click', () => options.compose('帮我创建一个可编辑产物。先确认目标、内容和参考材料。'));

  function toolbar(extra = '') { return `<div class="mp-library-toolbar"><label class="mp-library-search">${glyph('search')}<input type="search" data-library-search placeholder="Search" value="${escape(query)}" aria-label="搜索当前页面" /></label>${extra}</div>`; }
  function sortControl(domain: string, value: string, choices: [string, string][]) {
    const current = choices.find(([key]) => key === value)?.[1] || '';
    return `<details class="mp-library-new-menu mp-library-sort"><summary aria-label="Sort by ${escape(current)}" title="Sort by ${escape(current)}">${glyph('sort')}</summary><div role="menu">${choices.map(([key, label]) => `<button type="button" role="menuitemradio" aria-checked="${key === value}" data-library-sort="${domain}" data-sort-value="${key}"><span>${label}</span>${key === value ? glyph('check') : ''}</button>`).join('')}</div></details>`;
  }
  function empty(mark: string, title: string, note: string, action = '') {
    const illustration = mark === 'projects' ? pictogram('HandBlocks') : mark === 'scheduled' ? pictogram('ObjectStopwatch') : glyph(mark, 'large');
    return `<div class="mp-library-empty">${illustration}<h2>${title}</h2><p>${escape(note)}</p>${action}</div>`;
  }
  function projectPage() {
    const rows = sortProjects(projects.filter(project => `${project.name} ${project.root}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), conversations, projectSort);
    const header = `<div class="mp-library-head"><div class="mp-library-actions">`
      + `<button type="button" data-library-search-toggle aria-label="Search projects" aria-expanded="${searchingProjects}">${glyph('search')}</button>`
      + sortControl('projects', projectSort, [['activity','Last updated'],['created','Date created'],['name','Alphabetical']])
      + `<button type="button" class="mp-library-primary" data-library-open-project>${glyph('attach')} New project</button></div></div>`
      + (searchingProjects ? `<label class="mp-library-search mp-project-search">${glyph('search')}<input type="search" data-library-search placeholder="Search projects..." value="${escape(query)}" aria-label="Search projects" /></label>` : '');
    const body = projects.length === 0
      ? empty('projects', 'Looking to start a project?', 'Upload materials, set custom instructions, and organize conversations in one space.', '<button type="button" class="mp-library-primary" data-library-open-project>New project</button>')
      : rows.length === 0
        ? `<p class="mp-library-nomatch">No projects matching “${escape(query)}”</p>`
        : `<div class="mp-library-cards">${rows.map(project => `<button type="button" class="mp-library-card" data-library-project="${escape(project.root)}">${glyph('projects', 'large')}<strong>${escape(project.name)}</strong><p>${escape(project.root)}</p><small>${conversations.filter(row => row.workspaceRoot === project.root).length} conversations</small></button>`).join('')}</div>`;
    return header + body;
  }
  const suggestions = [
    ['Daily briefing', '整理所选材料最近的变化，给我一份简洁的每日简报。', 'sunrise'],
    ['Inbox triage', '检查所选收件箱导出材料，整理需要我回复和处理的项目。', 'mailbox'],
    ['Meeting prep', '阅读所选会议材料，整理议程、背景和需要确认的问题。', 'calendar'],
    ['Weekly review', '阅读所选工作材料，整理本周进展、未完成事项和下一步。', 'checklist'],
    ['Content ideas', '根据所选素材提出可执行的内容选题，并列出来源。', 'lightbulb'],
    ['Monitor a topic', '跟踪所选主题材料的变化，只报告新的信息和需要我处理的事项。', 'binoculars'],
  ];
  function scheduledPreview(index: number) {
    const bar = (width: string) => `<i style="width:${width}"></i>`;
    const content = index === 0 ? `<strong>Today's brief</strong><span class="mp-mini-line"><b class="mp-mini-check">${glyph('check', 'micro')}</b>${bar('80px')}</span><span class="mp-mini-line"><b class="mp-mini-box"></b>${bar('56px')}</span>`
      : index === 1 ? `<span class="mp-mini-line"><b class="mp-mini-priority"></b><strong>High priority</strong></span>${bar('92%')}${bar('75%')}`
      : index === 2 ? `<strong>Product review</strong><small>in 45 min</small><span class="mp-mini-people">${Array.from({ length: 4 }, () => `<b>${glyph('user', 'micro')}</b>`).join('')}</span>`
      : index === 3 ? `<span class="mp-mini-line"><svg viewBox="0 0 36 36" class="mp-mini-ring"><circle cx="18" cy="18" r="14" fill="none" stroke="var(--mp-rule)" stroke-width="3"/><circle cx="18" cy="18" r="14" fill="none" stroke="var(--mp-focus)" stroke-width="3" stroke-linecap="round" stroke-dasharray="62.832 87.965"/></svg><span><strong>5 completed</strong><small>2 still open</small></span></span>`
      : index === 4 ? `<strong>3 post ideas</strong>${['80px', '64px', '56px'].map((width, item) => `<span class="mp-mini-line"><small>${item + 1}.</small>${bar(width)}</span>`).join('')}`
      : `<strong>Mentioned on a podcast</strong>${bar('64px')}${bar('48px')}`;
    return `<span class="mp-scheduled-preview" aria-hidden="true"><span class="mp-scheduled-preview-card">${content}</span></span>`;
  }
  function scheduledPage() {
    const rows = trackers.filter(row => row.trigger?.kind === 'schedule' && String(row.task).toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => scheduleSort === 'name' ? String(a.task).localeCompare(String(b.task)) : scheduleSort === 'last' ? Number(b.lastRun?.startedAtMs || 0) - Number(a.lastRun?.startedAtMs || 0) : nextScheduledRun(a) - nextScheduledRun(b));
    return toolbar(sortControl('scheduled', scheduleSort, [['next','Next run'],['name','Name'],['last','Last run']]) + `<details class="mp-library-new-menu"><summary class="mp-library-primary">New task${glyph('account-chevron', 'micro')}</summary><div><button type="button" data-schedule-new="agent">${glyph('composer-aux1')}<span>Create with Agent</span></button><button type="button" data-schedule-new="manual">${glyph('settings')}<span>Set up manually</span></button></div></details>`)
      + (rows.length ? `<div class="mp-library-list">${rows.map(row => `<div class="mp-library-list-row">${glyph('scheduled', 'large')}<div><strong>${escape(row.task)}</strong><small>${row.enabled ? `Next run: ${nextScheduledRun(row) <= Date.now() ? 'Due now · app running' : new Date(nextScheduledRun(row)).toLocaleString()} · 每天` : 'Paused'}${row.lastRun ? ` · ${row.lastRun.ok ? '最近运行完成' : '最近运行失败'}` : ''}</small></div><button type="button" data-tracker-toggle="${escape(row.trackerId)}" data-enabled="${!row.enabled}">${row.enabled ? 'Pause' : 'Resume'}</button><button type="button" data-tracker-remove="${escape(row.trackerId)}" aria-label="删除定时任务">${glyph('dismiss')}</button></div>`).join('')}</div>` : empty('scheduled', 'No scheduled tasks', '让 Agent 每天检查你选择的本机材料。任务会使用现有材料关注执行器。'))
      + `<div class="mp-library-suggestions"><h2>Try a scheduled task</h2><p>以下建议均以所选本机材料为来源，当前支持每天运行。</p><div>${suggestions.map(([title, prompt, mark], index) => `<button type="button" data-schedule-prompt="${escape(prompt)}"><span class="mp-suggestion-mark">${glyph(mark, 'large')}<span class="mp-suggestion-plus">${glyph('attach', 'large')}</span></span><span><strong>${title}</strong><p>${escape(prompt)}</p><small>${glyph('scheduled', 'micro')}Daily · selected materials</small></span>${scheduledPreview(index)}</button>`).join('')}</div></div>`;
  }
  function customizePage() {
    const tabs = ['skills', 'connectors', 'plugins'];
    const top = `<div class="mp-library-tabs mp-library-top-tabs">${tabs.map(tab => `<button type="button" data-customize-tab="${tab}" class="${customizeTab === tab ? 'is-on' : ''}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join('')}</div>`;
    const directory = `<div class="mp-library-tabs">${['yours', 'discover'].map(tab => `<button type="button" data-directory-tab="${tab}" class="${directoryTab === tab ? 'is-on' : ''}">${tab === 'yours' ? 'Yours' : 'Discover'}</button>`).join('')}</div>`;
    if (customizeTab === 'skills') {
      const entries = catalog?.skills || [];
      const sources = [...new Set(entries.map(entry => entry.source || 'Local'))];
      const filtered = sortSkills(entries.filter(entry => (selectedSource === 'all' || (entry.source || 'Local') === selectedSource) && `${entry.name} ${entry.description} ${entry.source}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), skillSort);
      return top + toolbar(`<select data-library-source aria-label="技能来源"><option value="all">All sources</option>${sources.map(source => `<option ${selectedSource === source ? 'selected' : ''} value="${escape(source)}">${escape(source)}</option>`).join('')}</select>` + sortControl('skills', skillSort, [['name','Name'],['source','Source'], ...(entries.some(entry => entry.modifiedAt) ? [['edited','Last edited'] as [string,string]] : [])])) + directory
        + (directoryTab === 'discover' ? '<p class="mp-library-note">浏览当前 Runtime 已发现的技能；选择后会把真实 /命令 放入输入框。</p>' : '')
        + (filtered.length ? `<div class="${directoryTab === 'discover' ? 'mp-library-cards' : 'mp-library-list'}">${filtered.map(entry => `<button type="button" class="${directoryTab === 'discover' ? 'mp-library-card' : 'mp-library-list-row'}" data-library-skill="${escape(entry.name)}">${glyph('attach-skills', 'large')}<span><strong>${escape(entry.name)}</strong><p>${escape(entry.description || entry.whenToUse || '')}</p><small>${escape(entry.source || 'Local')}${entry.modifiedAt ? ` · ${new Date(entry.modifiedAt).toLocaleDateString()}` : ''}</small></span><span class="mp-library-trailing">${glyph('attach')}</span></button>`).join('')}</div>` : empty('attach-skills', 'No matching skills', catalog?.errors?.join(' · ') || '当前 Runtime 没有发现符合筛选条件的技能。'));
    }
    if (customizeTab === 'connectors') {
      const connectors = [{ id: 'figma', name: 'Figma', type: 'Local plugin', status: figmaConnected ? 'connected' : 'not-connected', description: '连接本任务的 Figma 插件，读取和编辑设计。' }, ...(customInventory.connectors || [])];
      const filtered = connectors.filter(row => `${row.name} ${row.description || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (connectorFilter === 'all' || (row.status === 'connected') === (connectorFilter === 'connected')));
      if (directoryTab === 'discover') return top + toolbar() + directory + `<h2 class="mp-library-section-title">Your custom connectors</h2><div class="mp-library-cards mp-connector-discover">${filtered.map(row => `<article class="mp-library-card" data-connector-card="${escape(row.id)}">${glyph('attach-connector','large')}<strong>${escape(row.name)}</strong><p>${escape(row.description || (row.type === 'stdio' ? '本机 stdio MCP 配置。' : '本机连接配置。'))}</p><small>${escape(row.type)} · ${escape(row.status)}</small>${row.error ? `<p class="mp-library-error">${escape(row.error)}</p>` : ''}${row.id === 'figma' ? `<button type="button" data-library-connector="figma">${glyph(figmaConnected ? 'check' : 'attach')}${figmaConnected ? 'Manage' : 'Connect'}</button>` : ''}</article>`).join('')}</div><p class="mp-library-note">这里只列出本机可用的连接配置，configured 不等于已连接。</p>`;
      return top + toolbar() + directory + `<div class="mp-library-tabs">${['all', 'connected', 'not-connected'].map(value => `<button type="button" data-connector-filter="${value}" class="${connectorFilter === value ? 'is-on' : ''}">${{ all: 'All', connected: 'Connected', 'not-connected': 'Not connected' }[value]}</button>`).join('')}</div><div class="mp-connector-table"><div class="mp-connector-head"><span>Connector</span><span>Type</span><span>Authorization</span><span>Status</span></div>${filtered.map(row => `<div class="mp-connector-row"><span>${glyph('attach-connector', 'large')}<strong>${escape(row.name)}</strong></span><span>${escape(row.type || 'MCP')}</span><span>Local</span>${row.id === 'figma' ? `<button type="button" data-library-connector="figma">${figmaConnected ? 'Manage' : 'Connect'}</button>` : `<span class="mp-library-connection-state" title="${escape(row.error || '')}">${escape(row.status)}</span>`}</div>`).join('')}</div><p class="mp-library-note">MCP 的 configured 仅表示本机配置有效；只有本任务实际配对的连接显示为已连接。</p>`;
    }
    const plugins = (customInventory.plugins || []).filter(row => `${row.name} ${row.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return top + toolbar() + directory + (plugins.length ? pluginDirectoryMarkup(plugins, directoryTab) : empty('attach-plugins', directoryTab === 'yours' ? 'Local Harness plugins' : 'Discover plugins', '此页读取本机插件目录的配置元数据；当前没有发现插件。配置状态不表示已启用或已批准。', '<button type="button" data-library-settings>Open plugin settings</button>'));
  }
  function chatsPage() {
    const rows = filterRows(conversations, query);
    const selection = selectingChats ? `<div class="mp-chat-bulk-toolbar"><label><input type="checkbox" data-chat-select-all ${rows.length && rows.every(row => selectedChats.has(row.id)) ? 'checked' : ''} /> Select all</label><span>${selectedChats.size} selected</span>${[['archive','Archive'],['unarchive','Unarchive'],['delete','Delete']].map(([action,label]) => `<button type="button" data-chat-bulk="${action}" ${!selectedChats.size || bulkBusy ? 'disabled' : ''}>${label}</button>`).join('')}</div>` : '';
    return chatsHeadingMarkup(selectingChats, searchingChats, query) + selection + (rows.length ? `<div class="mp-library-list">${rows.map(row => `<div class="mp-library-chat-row">${selectingChats ? `<input type="checkbox" data-chat-select="${escape(row.id)}" aria-label="选择 ${escape(row.title || 'Untitled')}" ${selectedChats.has(row.id) ? 'checked' : ''} />` : ''}<button type="button" data-open="${escape(row.id)}"><strong>${escape(row.title || 'Untitled')}</strong><small>${new Date(Number(row.updatedAt || 0)).toLocaleDateString()}</small></button><button type="button" data-library-chat-menu="${escape(row.id)}" aria-label="会话操作">${glyph('row-more')}</button></div>`).join('')}</div>` : empty('composer-aux1', 'No matching chats or tasks', '修改搜索条件或过滤器，或者开始一个新任务。'));
  }
  function designPage() {
    const rows = designRows(designArtifacts, designTab, query);
    const list = rows.length ? `<div class="mp-design-results" data-layout="${designLayout}">${artifactDateGroups(rows).map(group => `<section class="mp-design-date-group"><h2>${escape(group.label)}</h2><div class="mp-design-group-items">${group.items.map(item => `<button type="button" class="mp-library-list-row" ${item.artifactId ? `data-artifact-id="${escape(item.artifactId)}" data-artifact-conversation="${escape(item.conversationId)}"` : `data-open="${escape(item.conversationId)}"`}>${designLayout === 'grid' ? `<span class="mp-artifact-preview">${artifactPreviewMarkup(item, designContents.get(`${item.artifactId}:${item.revision || 0}`))}</span>` : glyph(item.kind === 'image' ? 'image' : 'design', 'large')}<span><strong>${escape(item.name || item.summary || 'Untitled design')}</strong><small>${escape(item.from || '')}</small></span><small>${item.at ? new Date(Number(item.at)).toLocaleDateString() : ''}</small></button>`).join('')}</div></section>`).join('')}</div>` : '<p class="mp-library-note">还没有符合条件的设计产物。已生成的图像、设计文件和设计系统会显示在这里。</p>';
    return toolbar(`<button type="button" data-design-layout aria-label="${designLayout === 'grid' ? 'List view' : 'Grid view'}">${glyph(designLayout === 'grid' ? 'layout-list' : 'layout-grid')}</button>`) + `<div class="mp-library-tabs"><button type="button" data-design-tab="designs" class="${designTab === 'designs' ? 'is-on' : ''}">Designs</button><button type="button" data-design-tab="systems" class="${designTab === 'systems' ? 'is-on' : ''}">Design systems</button></div><div class="mp-library-cards mp-design-templates">${[['Slides', '帮我制作一份演示文稿，先确认主题、受众和参考材料。', 'slides'], ['Design', '帮我完成一项设计，先确认设计目标和参考材料。', 'design'], ['Design system', '帮我创建一个设计系统，先确认品牌和组件要求。', 'system']].map(([title, prompt, mark]) => `<button type="button" class="mp-library-card" data-library-compose="${prompt}"><span class="mp-original-preview" data-original-preview="${mark}" aria-hidden="true"></span><strong>${title}</strong></button>`).join('')}</div>${list}<div class="mp-library-design-links"><button type="button" data-goto="stash">${glyph('attach-screenshot')}Browse captures and references</button><button type="button" data-goto="artifacts">${glyph('artifacts')}Open generated artifacts</button><button type="button" data-library-connector="figma">${glyph('design')}Connect Figma</button></div>`;
  }
  async function loadDesignContents() {
    await Promise.all(designRows(designArtifacts, designTab, query).slice(0, 24).map(async item => {
      const key = `${item.artifactId}:${item.revision || 0}`;
      if (!item.artifactId || !item.conversationId || designContents.has(key)) return;
      try { const result = await options.data.readArtifact(item.conversationId, item.artifactId); designContents.set(key, result.ok ? String(result.artifact?.content || '') : ''); }
      catch { designContents.set(key, ''); }
    }));
    if (activeView === 'designs' && designLayout === 'grid') paint();
  }
  function paint() {
    const host = document.getElementById(`library-${activeView}`);
    if (!host) return;
    host.innerHTML = (error ? `<p class="mp-library-error" role="status">${escape(error)}</p>` : '') + (activeView === 'projects' ? projectPage() : activeView === 'scheduled' ? scheduledPage() : activeView === 'customize' ? customizePage() : activeView === 'chats' ? chatsPage() : designPage());
    mountPreviews(host);
  }
  async function render(view: string) {
    if (!hosts.includes(view)) { activeView = ''; return; }
    if (activeView !== view) query = '';
    activeView = view; error = '';
    const snapshot = view;
    try {
      const [nextConversations, nextProjects] = await Promise.all([options.data.conversations(), options.data.projects(), loadPictograms()]);
      conversations = nextConversations; projects = nextProjects;
      if (view === 'designs') { designArtifacts = await options.data.artifacts(); if (designLayout === 'grid') void loadDesignContents(); }
      if (view === 'customize') {
        catalog = await options.data.slashDirectory();
        const inventory = await window.magicPointerDashboard?.extensions?.inventory();
        if (inventory?.ok) { customInventory = {
          plugins: (inventory.plugins?.items || []).map((item: any) => ({ ...item, state: item.status })),
          connectors: (inventory.mcp?.servers || []).map((item: any) => ({ ...item, id: `mcp:${item.name}`, type: item.transport })),
        }; error = inventoryErrors(inventory); }
        else if (inventory) error = String(inventory.error || '无法读取扩展目录。');
        const conversationId = options.conversationId();
        const figma = conversationId ? await options.data.figmaStatus(conversationId) : null;
        figmaConnected = Boolean(figma?.ok && figma?.connections?.length);
      }
      if (view === 'scheduled') {
        const response = await window.magicPointerDashboard?.contextTrackers?.list();
        if (!response?.ok) throw new Error(response?.error || '材料关注尚未就绪。');
        trackers = response.trackers || [];
      }
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    if (activeView === snapshot) paint();
  }
  async function newSchedule(prompt = '') {
    const sources = scheduledSources(conversations);
    const dialog = document.createElement('div'); dialog.className = 'mp-library-dialog-mask';
    dialog.innerHTML = `<form class="mp-library-dialog" role="dialog" aria-modal="true" aria-label="New scheduled task"><h2>New scheduled task</h2><label>Task<textarea name="task" rows="4" required>${escape(prompt)}</textarea></label><label>Source<select name="source" required>${sources.map((source, index) => `<option value="${index}">${escape(source.label)}</option>`).join('')}</select></label><p>每天运行一次，首次运行在创建后一天。应用需保持运行；生成草稿，不会自动写回源文件。</p><p class="mp-library-error" role="status">${sources.length ? '' : '先在对话中添加本机文件或文件夹，再为该材料创建定时任务。'}</p><footer><button type="button" data-schedule-cancel>Cancel</button>${sources.length ? '<button type="submit" class="mp-library-primary">Create task</button>' : '<button type="button" data-schedule-attach>Open a conversation</button>'}</footer></form>`;
    document.body.append(dialog);
    dialog.querySelector('[data-schedule-cancel]')?.addEventListener('click', () => dialog.remove());
    dialog.querySelector('[data-schedule-attach]')?.addEventListener('click', () => { dialog.remove(); options.compose(prompt); });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') dialog.remove(); });
    dialog.querySelector('form')!.addEventListener('submit', async event => {
      event.preventDefault();
      const source = sources[Number((dialog.querySelector('[name=source]') as HTMLSelectElement).value)];
      const task = (dialog.querySelector('[name=task]') as HTMLTextAreaElement).value.trim();
      if (!source || !task) return;
      const submit = dialog.querySelector<HTMLButtonElement>('[type=submit]')!; submit.disabled = true;
      try {
        const result = await options.data.trackMaterial({ ...source, action: 'follow', task, cadence: 'daily' });
        if (!result.ok) throw new Error(result.error || '创建失败');
        dialog.remove(); await render('scheduled');
      } catch (reason) { dialog.querySelector('.mp-library-error')!.textContent = reason instanceof Error ? reason.message : String(reason); submit.disabled = false; }
    });
    dialog.querySelector('textarea')?.focus();
  }
  for (const view of hosts) {
    const host = document.getElementById(`library-${view}`);
    host?.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      if (!input.matches('[data-library-search]')) return;
      const start = input.selectionStart; query = input.value; paint();
      const next = host.querySelector<HTMLInputElement>('[data-library-search]'); next?.focus();
      try { next?.setSelectionRange(start, start); } catch { /* type=search does not support selection in every Chromium build */ }
    });
    host?.addEventListener('change', event => {
      const select = event.target as HTMLInputElement;
      if (select.matches('[data-library-source]')) { selectedSource = select.value; paint(); }
      if (select.dataset.chatSelect) { if (select.checked) selectedChats.add(select.dataset.chatSelect); else selectedChats.delete(select.dataset.chatSelect); paint(); }
      if (select.matches('[data-chat-select-all]')) { for (const row of filterRows(conversations, query)) { if (select.checked) selectedChats.add(row.id); else selectedChats.delete(row.id); } paint(); }
    });
    host?.addEventListener('click', event => {
      const target = (event.target as Element).closest<HTMLElement>('button'); if (!target) return;
      const d = target.dataset;
      if (d.librarySort) { if (d.librarySort === 'projects') projectSort = String(d.sortValue); else if (d.librarySort === 'scheduled') scheduleSort = String(d.sortValue); else skillSort = String(d.sortValue); paint(); }
      if ('libraryOpenProject' in d) void options.openProject().then(() => render('projects'));
      if (d.libraryProject) { options.selectProject(d.libraryProject); options.compose(''); }
      if ('libraryCompose' in d) options.compose(d.libraryCompose || '');
      if (d.librarySkill) options.compose(`/${d.librarySkill} `);
      if (d.customizeTab) { customizeTab = d.customizeTab; query = ''; selectedSource = 'all'; paint(); }
      if (d.directoryTab) { directoryTab = d.directoryTab; paint(); }
      if (d.connectorFilter) { connectorFilter = d.connectorFilter; paint(); }
      if (d.designTab) { designTab = d.designTab; paint(); if (designLayout === 'grid') void loadDesignContents(); }
      if ('designLayout' in d) { designLayout = designLayout === 'list' ? 'grid' : 'list'; paint(); if (designLayout === 'grid') void loadDesignContents(); }
      if ('chatSelection' in d) { selectingChats = !selectingChats; if (!selectingChats) selectedChats.clear(); paint(); }
      if ('chatSearchToggle' in d) { searchingChats = !searchingChats; if (!searchingChats) query = ''; paint(); if (searchingChats) host.querySelector<HTMLInputElement>('[data-library-search]')?.focus(); }
      if ('librarySearchToggle' in d) { searchingProjects = !searchingProjects; if (!searchingProjects) query = ''; paint(); if (searchingProjects) host.querySelector<HTMLInputElement>('[data-library-search]')?.focus(); }
      if (d.chatBulk && !bulkBusy) {
        bulkBusy = true; paint();
        void applyBulkConversationAction([...selectedChats], d.chatBulk, id => options.data.deleteConversation(id)).then(async result => {
          result.completed.forEach(id => selectedChats.delete(id));
          bulkBusy = false; await render('chats'); error = result.errors.join(' · '); paint(); void options.refreshSidebar();
        });
      }
      if (d.libraryConnector) options.connectFigma();
      if ('librarySettings' in d) options.show('settings');
      if ('libraryFilters' in d) filterMenu(target);
      if ('scheduleNew' in d || 'schedulePrompt' in d) void newSchedule(d.schedulePrompt || '');
      if (d.trackerToggle || d.trackerRemove) {
        const api = window.magicPointerDashboard?.contextTrackers;
        const action = d.trackerToggle ? api?.setEnabled(d.trackerToggle, d.enabled === 'true') : api?.remove(d.trackerRemove!);
        void action?.then(response => { if (!response.ok) { error = response.error || '更新失败'; paint(); } else void render('scheduled'); });
      }
      if (d.libraryChatMenu) {
        const row = conversations.find(item => item.id === d.libraryChatMenu); if (!row) return;
        const local = sessionPreference(row.id);
        root.innerHTML = `<button type="button" data-chat-action="pin">${local.pinned ? 'Unpin' : 'Pin'}</button><button type="button" data-chat-action="rename">Rename</button><button type="button" data-chat-action="project">Change project</button><button type="button" data-chat-action="archive">${local.archived ? 'Unarchive' : 'Archive'}</button><button type="button" data-chat-action="delete" class="is-danger">Delete</button>`;
        root.querySelectorAll<HTMLElement>('[data-chat-action]').forEach(button => button.addEventListener('click', () => {
          const action = button.dataset.chatAction;
          if (action === 'pin') setSessionPreference(row.id, { pinned: !local.pinned });
          if (action === 'archive') setSessionPreference(row.id, { archived: !local.archived });
          if (action === 'rename') options.renameConversation(row.id, row.title || '');
          if (action === 'project') { options.changeProject(row.id, button); return; }
          if (action === 'delete') void options.data.deleteConversation(row.id).then(() => render('chats'));
          closeMenu(); changed();
        }));
        positionMenu(target);
      }
    });
  }
  return { render, changed, filterMenu, setInventory(value: typeof customInventory) { customInventory = value; if (activeView === 'customize') paint(); } };
}
const api = { preferences, filterRows, sections, sessionPreference, sessionGroups, setSessionGroup, setFilter, setSessionPreference, movePinned, scheduledSources, nextScheduledRun, sortProjects, sortSkills, designRows, artifactPreviewMarkup, artifactDateGroups, applyBulkConversationAction, loadPictograms, pictogram, mountPreviews, inventoryErrors, submenuSide, chatsHeadingMarkup, pluginDirectoryMarkup, projectOptionsMarkup, createController };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
(globalThis as any).StudioLibraries = api;
})();
