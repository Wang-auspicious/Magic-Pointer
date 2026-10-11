'use strict';

type HomeView = 'overview' | 'models';
type HomeRange = 'all' | '30d' | '7d';

interface HomeAttentionItem {
  id: string;
  title?: string;
  state?: string;
  updatedAt?: number;
  hasPendingWork?: boolean;
  lastOutcome?: string;
  lastFailed?: boolean;
  lastPendingInputKind?: string;
  workspaceRoot?: string;
  archived?: boolean;
  pinned?: boolean;
  acknowledgedAt?: number;
}

interface HomeProjectItem {
  project: MagicPointerProject;
  updatedAt: number;
  running: boolean;
}

interface HomeDailyLike {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  messages?: number;
}

interface HomeModelLike {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  share: number;
}

interface HomeStatsLike {
  sessions: number;
  messages: number;
  totalTokens: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  peakHour: number | null;
  favoriteModel: string | null;
  heatmap: Array<{date: string; messages: number; future: boolean}>;
  daily?: HomeDailyLike[];
  models?: HomeModelLike[];
  ranges?: Partial<Record<HomeRange, HomeStatsLike>>;
}

interface HomeRenderOptions {
  stats: HomeStatsLike | null;
  conversations: readonly HomeAttentionItem[];
  onOpenConversation?: (id: string) => void;
  projects?: readonly MagicPointerProject[];
  onOpenProject?: (root: string) => void;
  displayName?: string;
}

interface StudioHomeApi {
  renderStatsCard(stats: HomeStatsLike | null): string;
  renderModelsCard(stats: HomeStatsLike | null): string;
  formatStatsNote(stats: Pick<HomeStatsLike, 'totalTokens'> | null): string;
  selectAttentionItems(
    items: readonly HomeAttentionItem[],
  ): HomeAttentionItem[];
  selectActiveProjects(
    projects: readonly MagicPointerProject[],
    conversations: readonly HomeAttentionItem[],
    now?: number,
  ): HomeProjectItem[];
  render(options: HomeRenderOptions): void;
}

const PRIORITY: Record<string, number> = {
  awaiting: 0,
  failed: 1,
  running: 1,
  review: 2,
  resumable: 3,
  ready: 4,
};

let homeView: HomeView = 'overview';
let homeRange: HomeRange = 'all';
let cachedOptions: HomeRenderOptions | null = null;
let controlsBound = false;
let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
const expandedHomeSections = new Set<string>();

function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function formatStatsNote(
  stats: Pick<HomeStatsLike, 'totalTokens'> | null,
): string {
  if (!stats) {
    return 'Stats unavailable. You can still start a task.';
  }
  const totalTokens = finite(stats.totalTokens);
  if (totalTokens <= 0) {
    return 'No usage yet. Start a task to see your stats.';
  }
  const books = Math.max(1, Math.round(totalTokens / 158_662));
  return `You've used ~${books}× more tokens than Pride and Prejudice.`;
}

function compactNumber(value: unknown): string {
  const number = finite(value);
  if (number >= 1_000_000_000) {
    return `${(number / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  }
  if (number >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (number >= 1_000) {
    return `${(number / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return Math.round(number).toLocaleString('zh-CN');
}

function countNumber(value: unknown): string {
  return Math.round(finite(value)).toLocaleString('en-US');
}

function stateOf(item: HomeAttentionItem): string {
  const state = String(item.state ?? '').trim();
  if (state) {
    return state;
  }
  if (item.lastPendingInputKind) {
    return 'awaiting';
  }
  if (item.lastFailed || item.lastOutcome === '失败') {
    return 'failed';
  }
  if (
    item.hasPendingWork &&
    ['进行中', 'running', 'in_progress'].includes(item.lastOutcome || '')
  ) {
    return 'running';
  }
  return item.hasPendingWork ? 'resumable' : '';
}

function selectAttentionItems(
  items: readonly HomeAttentionItem[],
): HomeAttentionItem[] {
  return items
    .filter(
      item =>
        !item.archived &&
        !item.pinned &&
        stateOf(item) in PRIORITY &&
        !(item.updatedAt && Number(item.acknowledgedAt || 0) >= item.updatedAt),
    )
    .sort(
      (a, b) =>
        PRIORITY[stateOf(a)] - PRIORITY[stateOf(b)] ||
        finite(b.updatedAt) - finite(a.updatedAt) ||
        String(a.id).localeCompare(String(b.id)),
    );
}

function selectActiveProjects(
  projects: readonly MagicPointerProject[],
  conversations: readonly HomeAttentionItem[],
  now = Date.now(),
): HomeProjectItem[] {
  const key = (root: string) =>
    root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const activity = new Map<string, {updatedAt: number; running: boolean}>();
  for (const conversation of conversations) {
    if (!conversation.workspaceRoot || conversation.archived) {
      continue;
    }
    const root = key(conversation.workspaceRoot);
    const prior = activity.get(root);
    activity.set(root, {
      updatedAt: Math.max(prior?.updatedAt || 0, conversation.updatedAt || 0),
      running: Boolean(prior?.running || stateOf(conversation) === 'running'),
    });
  }
  return projects
    .filter(project => !project.archived)
    .flatMap(project => {
      const latest = activity.get(key(project.root));
      return latest && (latest.running || latest.updatedAt >= now - 604800000)
        ? [{project, ...latest}]
        : [];
    })
    .sort(
      (a, b) =>
        Number(b.running) - Number(a.running) ||
        b.updatedAt - a.updatedAt ||
        a.project.name.localeCompare(b.project.name),
    );
}

function statTile(label: string, value: string): string {
  return `<div class="mp-home-stat"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`;
}

function heatLevel(messages: number, max: number): number {
  if (messages <= 0 || max <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(4, Math.ceil((messages / max) * 4)));
}

function renderStatsCard(stats: HomeStatsLike | null): string {
  if (!stats) {
    return '<p class="mp-home-stats-unavailable">Stats unavailable. You can still start a task.</p>';
  }
  const heatmap = Array.isArray(stats.heatmap) ? stats.heatmap : [];
  const max = Math.max(0, ...heatmap.map(day => finite(day.messages)));
  const tiles = [
    statTile('Sessions', countNumber(stats.sessions)),
    statTile('Messages', countNumber(stats.messages)),
    statTile('Total tokens', compactNumber(stats.totalTokens)),
    statTile('Active days', countNumber(stats.activeDays)),
    statTile('Current streak', `${countNumber(stats.currentStreak)}d`),
    statTile('Longest streak', `${countNumber(stats.longestStreak)}d`),
    statTile(
      'Peak hour',
      stats.peakHour === null
        ? '—'
        : `${((stats.peakHour + 11) % 12) + 1} ${stats.peakHour >= 12 ? 'PM' : 'AM'}`,
    ),
    statTile('Favorite model', stats.favoriteModel || '—'),
  ].join('');
  const cells = heatmap
    .map(day => {
      const messages = finite(day.messages);
      const tooltip = `${day.date} · ${messages} messages`;
      return `<button type="button" class="mp-home-heatmap-cell" data-level="${heatLevel(messages, max)}"${day.future ? ' data-future="true"' : ''} data-home-tooltip="${esc(tooltip)}" aria-label="${esc(tooltip)}" aria-describedby="studio-home-tooltip" tabindex="0"></button>`;
    })
    .join('');
  return `<div class="mp-home-stat-grid">${tiles}</div><div class="mp-home-heatmap" aria-label="Activity by day">${cells}</div>`;
}

function renderModelsCard(stats: HomeStatsLike | null): string {
  if (!stats) {
    return '<p class="mp-home-stats-unavailable">Model stats unavailable.</p>';
  }
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const models = Array.isArray(stats.models) ? stats.models : [];
  const maxDaily = Math.max(0, ...daily.map(day => finite(day.totalTokens)));
  const chart = daily
    .map(day => {
      const total = finite(day.totalTokens);
      const height = maxDaily > 0 ? Math.max(2, (total / maxDaily) * 100) : 0;
      const tooltip = `${day.date} · ${countNumber(total)} tokens`;
      return `<button type="button" class="mp-home-model-day" style="--mp-home-day-height:${height.toFixed(2)}%" data-home-tooltip="${esc(tooltip)}" aria-label="${esc(tooltip)}" aria-describedby="studio-home-tooltip"><span class="mp-home-model-day-bar"></span></button>`;
    })
    .join('');
  const rows = models
    .map(
      model =>
        `<div class="mp-home-model-row"><div class="mp-home-model-name"><strong>${esc(model.modelId)}</strong><small>${countNumber(model.turns)} turn${finite(model.turns) === 1 ? '' : 's'}</small></div><div class="mp-home-model-share"><i style="--mp-home-model-share:${Math.max(0, Math.min(100, finite(model.share))).toFixed(2)}%"></i></div><span>${countNumber(model.inputTokens)} input</span><span>${countNumber(model.outputTokens)} output</span><b>${compactNumber(model.totalTokens)}</b></div>`,
    )
    .join('');
  return `<div class="mp-home-model-chart" aria-label="Daily token usage">${chart}</div><div class="mp-home-model-legend"><span>Daily tokens</span><span>${compactNumber(stats.totalTokens)} total</span></div><div class="mp-home-model-list">${rows || '<p class="mp-home-stats-unavailable">No model usage in this range.</p>'}</div>`;
}

function attentionLabel(state: string): string {
  switch (state) {
    case 'awaiting':
      return 'Needs your input';
    case 'failed':
      return 'Needs attention';
    case 'running':
      return 'Running';
    case 'review':
      return 'Ready to review';
    case 'resumable':
      return 'Continue';
    case 'ready':
      return 'New result';
    default:
      return '';
  }
}

function selectedStats(stats: HomeStatsLike | null): HomeStatsLike | null {
  if (!stats) {
    return null;
  }
  return stats.ranges?.[homeRange] ?? stats;
}

function cancelTooltipTimer(): void {
  if (tooltipTimer !== null) {
    clearTimeout(tooltipTimer);
  }
  tooltipTimer = null;
}

function hideTooltip(): void {
  cancelTooltipTimer();
  const tooltip = document.getElementById('studio-home-tooltip');
  if (tooltip) {
    tooltip.hidden = true;
  }
}

function showTooltip(target: HTMLElement, delay = 0): void {
  cancelTooltipTimer();
  tooltipTimer = setTimeout(() => {
    const tooltip = document.getElementById('studio-home-tooltip');
    const text = target.dataset.homeTooltip;
    if (!tooltip || !text) {
      return;
    }
    tooltip.textContent = text;
    tooltip.hidden = false;
    tooltip.style.visibility = 'hidden';
    const targetRect = target.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const margin = 12;
    const left = Math.max(
      margin,
      Math.min(
        window.innerWidth - width - margin,
        targetRect.left + targetRect.width / 2 - width / 2,
      ),
    );
    const top =
      targetRect.top - height - 8 >= margin
        ? targetRect.top - height - 8
        : Math.min(window.innerHeight - height - margin, targetRect.bottom + 8);
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.visibility = 'visible';
  }, delay);
}

function bindTooltips(): void {
  document
    .querySelectorAll<HTMLElement>('[data-home-tooltip]')
    .forEach(target => {
      target.addEventListener('pointerenter', () => showTooltip(target, 120));
      target.addEventListener('pointerleave', hideTooltip);
      target.addEventListener('focus', () => showTooltip(target));
      target.addEventListener('blur', hideTooltip);
      target.addEventListener('click', () => showTooltip(target));
    });
}

function updateTabState(): void {
  document
    .querySelectorAll<HTMLButtonElement>('[data-home-view]')
    .forEach(button => {
      const selected = button.dataset.homeView === homeView;
      button.classList.toggle('is-on', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  document
    .querySelectorAll<HTMLButtonElement>('[data-home-range]')
    .forEach(button => {
      const selected = button.dataset.homeRange === homeRange;
      button.classList.toggle('is-on', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
}

function renderSelectedStats(): void {
  if (!cachedOptions) {
    return;
  }
  hideTooltip();
  updateTabState();
  const stats = selectedStats(cachedOptions.stats);
  const grid = document.getElementById('studio-home-stat-grid');
  const heatmap = document.getElementById('studio-home-heatmap');
  const models = document.getElementById('studio-home-models');
  const note = document.getElementById('studio-home-stats-note');
  if (homeView === 'overview') {
    const template = document.createElement('template');
    template.innerHTML = renderStatsCard(stats);
    const renderedGrid = template.content.querySelector('.mp-home-stat-grid');
    const renderedHeatmap = template.content.querySelector('.mp-home-heatmap');
    if (grid) {
      grid.hidden = false;
      grid.replaceChildren(
        ...(renderedGrid
          ? renderedGrid.childNodes
          : template.content.childNodes),
      );
    }
    if (heatmap) {
      heatmap.hidden = false;
      heatmap.replaceChildren(...(renderedHeatmap?.childNodes ?? []));
    }
    if (models) {
      models.hidden = true;
      models.replaceChildren();
    }
    if (note) {
      note.textContent = formatStatsNote(stats);
    }
  } else {
    if (grid) {
      grid.hidden = true;
      grid.replaceChildren();
    }
    if (heatmap) {
      heatmap.hidden = true;
      heatmap.replaceChildren();
    }
    if (models) {
      models.hidden = false;
      models.innerHTML = renderModelsCard(stats);
    }
    if (note) {
      note.textContent = stats
        ? `${countNumber(stats.models?.length ?? 0)} models used in this range.`
        : 'Model stats unavailable.';
    }
  }
  bindTooltips();
}

function bindControlsOnce(): void {
  if (controlsBound) {
    return;
  }
  controlsBound = true;
  document
    .querySelectorAll<HTMLButtonElement>('[data-home-view]')
    .forEach(button => {
      button.addEventListener('click', () => {
        const view = button.dataset.homeView;
        if (view !== 'overview' && view !== 'models') {
          return;
        }
        homeView = view;
        renderSelectedStats();
      });
    });
  document
    .querySelectorAll<HTMLButtonElement>('[data-home-range]')
    .forEach(button => {
      button.addEventListener('click', () => {
        const range = button.dataset.homeRange;
        if (range !== 'all' && range !== '30d' && range !== '7d') {
          return;
        }
        homeRange = range;
        renderSelectedStats();
      });
    });
}

function render(options: HomeRenderOptions): void {
  cachedOptions = options;
  bindControlsOnce();
  const attention = selectAttentionItems(
    options.conversations.filter(item => stateOf(item) !== 'running'),
  );
  const projects = selectActiveProjects(
    options.projects || [],
    options.conversations,
  );
  const clear = attention.length === 0 && projects.length === 0;
  const title = document.getElementById('studio-home-title');
  const name = options.displayName?.trim();
  if (title) {
    title.textContent = clear
      ? `What's up next${name ? `, ${name}` : ''}?`
      : `Welcome back${name ? `, ${name}` : ''}`;
  }
  const stats = document.getElementById('studio-home-stats');
  if (stats) {
    stats.hidden = !clear;
  }
  if (clear) {
    renderSelectedStats();
  } else {
    hideTooltip();
  }

  const attentionHost = document.getElementById('studio-home-attention');
  if (!attentionHost) {
    return;
  }
  attentionHost.hidden = clear;
  const limit = Math.min(
    5,
    3 + Number(window.innerHeight >= 800) + Number(window.innerHeight >= 900),
  );
  function section(label: string, nodes: HTMLElement[]): HTMLElement {
    const section = document.createElement('section');
    section.className = 'mp-home-section';
    const header = document.createElement('header');
    const heading = document.createElement('h2');
    heading.textContent = label;
    header.append(heading);
    const expanded = expandedHomeSections.has(label);
    if (nodes.length > limit) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mp-home-section-toggle';
      toggle.textContent = expanded
        ? 'Show less'
        : `Show ${nodes.length - limit} more`;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.addEventListener('click', () => {
        if (expanded) {
          expandedHomeSections.delete(label);
        } else {
          expandedHomeSections.add(label);
        }
        render(cachedOptions!);
      });
      header.append(toggle);
    }
    const list = document.createElement('div');
    list.className = 'mp-home-section-list';
    list.append(...(expanded ? nodes : nodes.slice(0, limit)));
    section.append(header, list);
    return section;
  }
  function row(
    label: string,
    state: string,
    detail: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mp-home-attention-row';
    button.dataset.state = state;
    const dot = document.createElement('i');
    dot.className = 'mp-home-state-dot';
    dot.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = label;
    const meta = document.createElement('span');
    meta.textContent = detail;
    const arrow = document.createElement('span');
    arrow.className = 'mp-home-row-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';
    button.append(dot, title, meta, arrow);
    return button;
  }
  const sessionNodes = attention.map(item => {
    const state = stateOf(item);
    const button = row(item.title || 'Untitled', state, attentionLabel(state));
    button.dataset.conversationId = item.id;
    button.addEventListener('click', () =>
      options.onOpenConversation?.(item.id),
    );
    return button;
  });
  const projectNodes = projects.map(item => {
    const button = row(
      item.project.name,
      item.running ? 'running' : '',
      item.running
        ? 'Working'
        : new Date(item.updatedAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          }),
    );
    button.dataset.projectRoot = item.project.root;
    button.addEventListener('click', () =>
      options.onOpenProject?.(item.project.root),
    );
    return button;
  });
  attentionHost.replaceChildren(
    ...(sessionNodes.length ? [section('Sessions', sessionNodes)] : []),
    ...(projectNodes.length ? [section('Projects', projectNodes)] : []),
  );
}

const StudioHome: StudioHomeApi = {
  renderStatsCard,
  renderModelsCard,
  formatStatsNote,
  selectAttentionItems,
  selectActiveProjects,
  render,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = StudioHome;
}
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & {StudioHome?: StudioHomeApi}).StudioHome =
    StudioHome;
}
