'use strict';

interface HomeAttentionItem {
  id: string;
  title?: string;
  state?: string;
  updatedAt?: number;
  hasPendingWork?: boolean;
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
  heatmap: Array<{ date: string; messages: number; future: boolean }>;
}

interface StudioHomeApi {
  renderStatsCard(stats: HomeStatsLike | null): string;
  selectAttentionItems(items: readonly HomeAttentionItem[]): HomeAttentionItem[];
  render(options: {
    stats: HomeStatsLike | null;
    conversations: readonly HomeAttentionItem[];
    onOpenConversation?: (id: string) => void;
  }): void;
}

const PRIORITY: Record<string, number> = {
  awaiting: 0,
  running: 1,
  review: 2,
  resumable: 3,
  ready: 4,
};

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

function compactNumber(value: unknown): string {
  const number = finite(value);
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return Math.round(number).toLocaleString('zh-CN');
}

function stateOf(item: HomeAttentionItem): string {
  const state = String(item.state ?? '').trim();
  if (state) return state;
  return item.hasPendingWork ? 'resumable' : '';
}

function selectAttentionItems(items: readonly HomeAttentionItem[]): HomeAttentionItem[] {
  return items
    .filter((item) => stateOf(item) in PRIORITY)
    .sort((a, b) => PRIORITY[stateOf(a)] - PRIORITY[stateOf(b)]
      || finite(b.updatedAt) - finite(a.updatedAt)
      || String(a.id).localeCompare(String(b.id)))
    .slice(0, 8);
}

function statTile(label: string, value: string): string {
  return `<div class="mp-home-stat"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`;
}

function heatLevel(messages: number, max: number): number {
  if (messages <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((messages / max) * 4)));
}

function renderStatsCard(stats: HomeStatsLike | null): string {
  if (!stats) {
    return '<p class="mp-home-stats-unavailable">统计暂不可用；对话仍可正常开始。</p>';
  }
  const heatmap = Array.isArray(stats.heatmap) ? stats.heatmap : [];
  const max = Math.max(0, ...heatmap.map((day) => finite(day.messages)));
  const tiles = [
    statTile('会话', compactNumber(stats.sessions)),
    statTile('消息', compactNumber(stats.messages)),
    statTile('总 token', compactNumber(stats.totalTokens)),
    statTile('活跃天数', compactNumber(stats.activeDays)),
    statTile('当前连续', `${compactNumber(stats.currentStreak)}天`),
    statTile('最长连续', `${compactNumber(stats.longestStreak)}天`),
    statTile('高峰时段', stats.peakHour === null ? '—' : `${String(stats.peakHour).padStart(2, '0')}:00`),
    statTile('常用模型', stats.favoriteModel || '—'),
  ].join('');
  const cells = heatmap.map((day) => {
    const messages = finite(day.messages);
    return `<i data-level="${heatLevel(messages, max)}"${day.future ? ' data-future="true"' : ''} title="${esc(day.date)} · ${messages} 条消息"></i>`;
  }).join('');
  return `<div class="mp-home-stat-grid">${tiles}</div><div class="mp-home-heatmap" aria-label="近半年活动热力图">${cells}</div>`;
}

function attentionLabel(state: string): string {
  switch (state) {
    case 'awaiting': return '等待你的决定';
    case 'running': return '正在运行';
    case 'review': return '可以审阅';
    case 'resumable': return '可以继续';
    case 'ready': return '已有新结果';
    default: return '';
  }
}

function render(options: {
  stats: HomeStatsLike | null;
  conversations: readonly HomeAttentionItem[];
  onOpenConversation?: (id: string) => void;
}): void {
  const grid = document.getElementById('studio-home-stat-grid');
  const heatmap = document.getElementById('studio-home-heatmap');
  const attentionHost = document.getElementById('studio-home-attention');
  if (options.stats) {
    const markup = renderStatsCard(options.stats);
    const template = document.createElement('template');
    template.innerHTML = markup;
    const renderedGrid = template.content.querySelector('.mp-home-stat-grid');
    const renderedHeatmap = template.content.querySelector('.mp-home-heatmap');
    if (grid && renderedGrid) grid.replaceChildren(...renderedGrid.childNodes);
    if (heatmap && renderedHeatmap) heatmap.replaceChildren(...renderedHeatmap.childNodes);
  } else {
    grid?.replaceChildren();
    heatmap?.replaceChildren();
  }

  if (!attentionHost) return;
  const attention = selectAttentionItems(options.conversations);
  attentionHost.hidden = attention.length === 0;
  const nodes = attention.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mp-home-attention-row';
    button.dataset.conversationId = item.id;
    const title = document.createElement('strong');
    title.textContent = String(item.title || '未命名会话');
    const state = document.createElement('span');
    state.textContent = attentionLabel(stateOf(item));
    button.append(title, state);
    button.addEventListener('click', () => options.onOpenConversation?.(item.id));
    return button;
  });
  attentionHost.replaceChildren(...nodes);
}

const StudioHome: StudioHomeApi = {
  renderStatsCard,
  selectAttentionItems,
  render,
};

if (typeof module !== 'undefined' && module.exports) module.exports = StudioHome;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { StudioHome?: StudioHomeApi }).StudioHome = StudioHome;
}
