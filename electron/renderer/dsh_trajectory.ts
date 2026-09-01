/* exported DshTrajectory */

/**
 * Native-DOM adapter for deepseek-harness ui-trajectory.
 * Source structure retained: TrajectoryToolbar -> TrajectoryTimeline ->
 * TrajectoryTable. Data comes from Magic Pointer's persisted loop ledger;
 * missing calls or timings remain absent.
 */
const DshTrajectory = (() => {
  interface ShimNode {
    tagName: string;
    attrs: Record<string, string>;
    children: (string | ShimNode)[];
    setAttribute(key: string, value: string): void;
    appendChild(child: string | ShimNode): unknown;
    readonly outerHTML: string;
  }
  type TrajectoryNode = Element | ShimNode;
  type Child = TrajectoryNode | string | number | null | undefined;
  type TrajectoryKind = 'system' | 'user' | 'request' | 'context' | 'compacted' | 'message' | 'tool' | 'subtool';
  interface TrajectoryRow {
    index: number;
    recordId: string;
    turn: number;
    kind: TrajectoryKind;
    label: string;
    text: string;
    result?: string;
    tokens?: number;
    latencyMs?: number;
    firstTokenMs?: number;
    startedAt?: number;
    backend?: string;
    failed?: boolean;
    callId?: string;
    request?: number;
  }

  const DOC = typeof document !== 'undefined' ? document : null;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const KIND_LABEL: Record<TrajectoryKind, string> = {
    system: 'SYSTEM', user: 'USER', request: 'REQUEST', context: 'CONTEXT', compacted: 'COMPACTED',
    message: 'ASSISTANT', tool: 'TOOL', subtool: 'SUBTOOL',
  };
  const KIND_LANE: Record<TrajectoryKind, number> = {
    system: 0, user: 0, request: 0, context: 0, compacted: 0, message: 1, tool: 2, subtool: 2,
  };

  function shim(tag: string): ShimNode {
    const node: ShimNode = {
      tagName: tag, attrs: {}, children: [],
      setAttribute(key, value) { node.attrs[key] = String(value); },
      appendChild(child) { node.children.push(child); return child; },
      get outerHTML() {
        const attrs = Object.entries(node.attrs).map(([key, value]) =>
          ` ${key}="${value.replace(/[&<>"]/g, char => ESC[char])}"`).join('');
        const body = node.children.map(child => typeof child === 'string'
          ? child.replace(/[&<>"']/g, char => ESC[char]) : child.outerHTML).join('');
        return `<${tag}${attrs}>${body}</${tag}>`;
      },
    };
    return node;
  }

  function append(parent: TrajectoryNode, child: Child): void {
    if (child === null || child === undefined) return;
    if (DOC) (parent as Element).appendChild(typeof child === 'string' || typeof child === 'number'
      ? DOC.createTextNode(String(child)) : child as Node);
    else (parent as ShimNode).appendChild(typeof child === 'string' || typeof child === 'number'
      ? String(child) : child as ShimNode);
  }

  function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): TrajectoryNode {
    const node = DOC ? DOC.createElement(tag) : shim(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    for (const child of children.flat()) append(node, child);
    return node;
  }

  function s(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): TrajectoryNode {
    const node = DOC ? DOC.createElementNS(SVG_NS, tag) : shim(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    for (const child of children.flat()) append(node, child);
    return node;
  }

  function finite(value: unknown): number | undefined {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  function duration(record: Record<string, any>): number | undefined {
    const direct = finite(record.latencyMs);
    if (direct !== undefined) return Math.max(0, direct);
    const start = finite(record.startedAt);
    const end = finite(record.completedAt);
    return start === undefined || end === undefined ? undefined : Math.max(0, end - start);
  }

  function titleForTool(name: string): string {
    const normalized = String(name || '').toLowerCase();
    if (normalized === 'pwsh') return 'Pwsh';
    if (['bash', 'shell', 'Bash', 'BashRead'].includes(normalized)) return 'Bash';
    if (['read', 'read_around', 'dump_subtree', 'web_fetch', 'Read', 'Around', 'Tree', 'Fetch', 'Observe', 'Look', 'ListApps', 'ListWindows', 'GetFocus', 'Wait'].includes(normalized)) return 'Read';
    if (['grep', 'glob', 'find_in_window', 'web_search', 'Grep', 'Glob', 'Find', 'Search', 'Tools', 'Recall'].includes(normalized)) return 'Search';
    if (['edit', 'write', 'Edit', 'Patch', 'Write', 'SaveSkill'].includes(normalized)) return normalized === 'edit' || normalized === 'Edit' || normalized === 'Patch' ? 'Edit' : 'Write';
    return name || 'Tool';
  }

  function recordId(kind: TrajectoryKind, record: Record<string, any>, index: number): string {
    if (record.recordId) return String(record.recordId);
    if (record.callId) return `${kind}\u0000call\u0000${String(record.callId)}`;
    if (record.seq !== undefined) return `${kind}\u0000seq\u0000${String(record.seq)}`;
    return `${kind}\u0000index\u0000${index}`;
  }

  function mapStoredRecord(record: Record<string, any>, fallbackIndex: number): TrajectoryRow | null {
    const rawKind = String(record.kind || '');
    const kind = (rawKind === 'request-header' ? 'request'
      : rawKind === 'input' ? 'user'
        : rawKind === 'think' || rawKind === 'output' ? 'message'
          : rawKind) as TrajectoryKind;
    if (!Object.prototype.hasOwnProperty.call(KIND_LABEL, kind)) return null;
    const index = Math.max(1, Math.round(finite(record.seq) ?? fallbackIndex));
    const turn = Math.max(1, Math.round(finite(record.turn) ?? 1));
    const name = String(record.name || record.tool || '');
    const startedAt = finite(record.startedAt);
    const firstTokenAt = finite(record.firstTokenAt);
    const outputTokens = finite(record.outputTokens ?? record.tokens);
    const elapsed = duration(record);
    const text = kind === 'request'
      ? [
        `Prompt cache: ${record.promptCache === true
          ? 'on'
          : record.promptCache === false ? 'off' : 'not recorded'}`,
        record.usedBackend ? `Backend: ${String(record.usedBackend)}` : '',
        finite(record.maxTokens) !== undefined ? `Max tokens: ${finite(record.maxTokens)}` : '',
      ].filter(Boolean).join(' · ')
      : kind === 'tool'
        ? String(record.text ?? record.arguments ?? '')
        : String(record.text ?? '');
    return {
      index,
      recordId: recordId(kind, record, index),
      turn,
      kind,
      label: kind === 'tool' ? titleForTool(name) : KIND_LABEL[kind],
      text,
      ...(record.result === undefined ? {} : { result: String(record.result) }),
      ...(outputTokens === undefined ? {} : { tokens: outputTokens }),
      ...(elapsed === undefined ? {} : { latencyMs: elapsed }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(firstTokenAt === undefined || startedAt === undefined
        ? {}
        : { firstTokenMs: Math.max(0, firstTokenAt - startedAt) }),
      ...(record.usedBackend ? { backend: String(record.usedBackend) } : {}),
      ...(record.isError === true || record.state === 'error' ? { failed: true } : {}),
      ...(record.callId ? { callId: String(record.callId) } : {}),
      ...(record.request ? { request: Number(record.request) } : {}),
    };
  }

  /** Historical Studio turns predate the event ledger; project only facts they actually retained. */
  function legacyRecords(turn: Record<string, any>, number: number): Record<string, any>[] {
    const usage = turn.modelUsage && typeof turn.modelUsage === 'object' ? turn.modelUsage : {};
    const records: Record<string, any>[] = [{
      seq: 1, kind: 'user', turn: number, text: String(turn.question || ''),
      tokens: finite(usage.inputTokens), startedAt: finite(turn.at),
    }];
    const models = Array.isArray(turn.activities)
      ? turn.activities.filter((activity: Record<string, unknown>) => activity?.kind === 'model') : [];
    if (models.length) {
      models.forEach((activity: Record<string, any>, index: number) => records.push({
        seq: records.length + 1, kind: 'message', turn: number,
        text: index === models.length - 1 ? String(turn.answer || '') : `Step ${index + 1}`,
        outputTokens: finite(usage.outputTokens), latencyMs: finite(activity.latencyMs),
        firstTokenAt: finite(activity.firstTokenMs), startedAt: 0,
        usedBackend: turn.usedBackend, state: activity.state,
      }));
    } else if (turn.answer) {
      records.push({
        seq: records.length + 1, kind: 'message', turn: number, text: String(turn.answer),
        outputTokens: finite(usage.outputTokens), latencyMs: finite(turn.timingMs),
        usedBackend: turn.usedBackend,
      });
    }
    for (const event of Array.isArray(turn.events) ? turn.events : []) records.push({
      seq: records.length + 1, kind: 'tool', turn: number,
      name: event.name || event.tool, text: typeof event.arguments === 'string'
        ? event.arguments : JSON.stringify(event.arguments || {}),
      result: event.result, latencyMs: finite(event.latencyMs), usedBackend: event.usedBackend,
      isError: event.isError,
    });
    return records;
  }

  function project(turns: Array<Record<string, any>>): TrajectoryRow[] {
    const rows: TrajectoryRow[] = [];
    let fallbackIndex = 1;
    turns.forEach((turn, turnIndex) => {
      const usage = turn.modelUsage && typeof turn.modelUsage === 'object' ? turn.modelUsage : {};
      const records = Array.isArray(turn.trajectory) && turn.trajectory.length
        ? turn.trajectory : legacyRecords(turn, turnIndex + 1);
      for (const record of records) {
        const row = mapStoredRecord(record, fallbackIndex);
        fallbackIndex += 1;
        if (row !== null) {
          if (row.kind === 'user' && row.tokens === undefined) {
            const inputTokens = finite(usage.inputTokens);
            if (inputTokens !== undefined) row.tokens = inputTokens;
          }
          rows.push(row);
        }
      }
    });
    return rows;
  }

  function styleForSpan(row: TrajectoryRow, index: number, rows: TrajectoryRow[]): string {
    const sequenceWidth = 100 / Math.max(1, rows.length);
    const actualTotal = rows.reduce((sum, item) => sum + Math.max(1, item.latencyMs ?? 1), 0);
    const actualBefore = rows.slice(0, index).reduce((sum, item) => sum + Math.max(1, item.latencyMs ?? 1), 0);
    const actualWidth = Math.max(1, row.latencyMs ?? 1) / actualTotal * 100;
    return [
      `--trajectory-span-lane:${KIND_LANE[row.kind]}`,
      `--trajectory-span-left:${(index * sequenceWidth).toFixed(4)}%`,
      `--trajectory-span-width:${sequenceWidth.toFixed(4)}%`,
      `--trajectory-actual-left:${(actualBefore / actualTotal * 100).toFixed(4)}%`,
      `--trajectory-actual-width:${actualWidth.toFixed(4)}%`,
    ].join(';');
  }

  function timeline(rows: TrajectoryRow[]): TrajectoryNode {
    const root = h('section', { class: 'dsh-trajectory-timeline', 'aria-label': 'Trajectory timeline' });
    const plot = h('div', { class: 'dsh-trajectory-plot' });
    append(plot, h('div', { class: 'dsh-trajectory-lane-labels', 'aria-hidden': 'true' },
      h('span', {}, 'Input'), h('span', {}, 'Model'), h('span', {}, 'Tools')));
    const track = h('div', { class: 'dsh-trajectory-track', tabindex: '0' });
    const lanes = h('div', { class: 'dsh-trajectory-lanes' });
    rows.forEach((row, index) => {
      append(lanes, h('span', {
        class: 'dsh-trajectory-span', 'data-timeline-span': row.kind,
        'data-record-index': String(row.index), 'data-error': row.failed ? 'true' : 'false',
        style: styleForSpan(row, index, rows),
        title: `${KIND_LABEL[row.kind]}${row.latencyMs === undefined ? '' : ` · ${Math.round(row.latencyMs)} ms`}`,
      }));
    });
    append(track, lanes);
    append(plot, track);
    append(root, plot);
    return root;
  }

  function toolbar(): TrajectoryNode {
    const root = h('div', { class: 'dsh-trajectory-toolbar', role: 'toolbar', 'aria-label': '轨迹工具栏' });
    const inner = h('div', { class: 'dsh-trajectory-toolbar-inner' });
    const actions = h('div', { class: 'dsh-trajectory-actions' });
    const durationButton = h('button', {
      type: 'button', class: 'dsh-trajectory-toggle', 'data-trajectory-action': 'duration',
      'aria-pressed': 'true', title: 'Use equal-width operations',
    });
    append(durationButton, s('svg', { class: 'dsh-trajectory-duration-icon', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
      s('circle', { cx: '8', cy: '8', r: '5.25' }), s('path', { d: 'M8 4.75V8l2.25 1.5' })));
    append(durationButton, 'Duration');
    append(actions, durationButton);
    append(actions, h('button', {
      type: 'button', class: 'dsh-trajectory-action', 'data-trajectory-action': 'turns',
      'aria-pressed': 'false', title: 'Collapse turns',
    }, h('span', { class: 'dsh-trajectory-action-icon', 'aria-hidden': 'true' }, '⊟'), 'Turns'));
    append(actions, h('button', {
      type: 'button', class: 'dsh-trajectory-action', 'data-trajectory-action': 'calls',
      'aria-pressed': 'false', title: 'Collapse calls',
    }, h('span', { class: 'dsh-trajectory-action-icon', 'aria-hidden': 'true' }, '⊟'), 'Calls'));
    append(inner, actions);
    const search = h('label', { class: 'dsh-trajectory-search' });
    if (typeof DshIcons !== 'undefined') append(search, DshIcons.node('search', 11));
    append(search, h('input', {
      type: 'search', class: 'dsh-trajectory-search-input', 'data-trajectory-search': '',
      'aria-label': '搜索轨迹', placeholder: '搜索',
    }));
    append(inner, search);
    append(root, inner);
    return root;
  }

  function eventIcon(kind: TrajectoryKind): TrajectoryNode {
    if (kind === 'tool' || kind === 'subtool') {
      // TrajectoryTable.tsx ToolWrenchIcon, copied verbatim from DSH.
      return s('svg', {
        viewBox: '0 0 16 16', width: '13', height: '13', fill: 'none',
        stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round',
        'stroke-linejoin': 'round', 'data-role-icon': 'wrench', 'aria-hidden': 'true',
      }, s('path', { d: 'M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z' }));
    }
    return h('span', { class: 'dsh-trajectory-kind-dot', 'aria-hidden': 'true' });
  }

  function ledger(rows: TrajectoryRow[]): TrajectoryNode {
    const split = h('div', { class: 'dsh-trajectory-split' });
    const pane = h('div', { class: 'dsh-trajectory-table-pane', 'data-trajectory-scroll': '' });
    const table = h('table', { class: 'dsh-trajectory-table', 'aria-rowcount': String(rows.length) });
    append(table, h('colgroup', {}, h('col', { class: 'dsh-trajectory-event-column' }), h('col', { class: 'dsh-trajectory-content-column' })));
    const body = h('tbody');
    let lastTurn = 0;
    rows.forEach((row, position) => {
      const turnStart = row.turn !== lastTurn;
      const rowNode = h('tr', {
        tabindex: '0', 'aria-rowindex': String(position + 1),
        'aria-label': `${KIND_LABEL[row.kind]}, ${row.text || 'no content'}`,
        'data-kind': row.kind, 'data-record-index': String(row.index),
        'data-record-id': row.recordId, 'data-error': row.failed ? 'true' : 'false',
        'data-turn-start': turnStart ? 'true' : 'false',
      });
      const event = h('td', { class: 'dsh-trajectory-event' });
      if (turnStart) {
        append(event, h('span', { class: 'dsh-trajectory-turn-label', 'aria-label': `Turn ${row.turn}` }, `Turn ${row.turn}`));
        append(event, h('span', { class: 'dsh-trajectory-turn-rail', 'aria-hidden': 'true' }));
        lastTurn = row.turn;
      }
      const eventInner = h('div', { class: 'dsh-trajectory-event-inner' });
      const tag = h('span', { class: `dsh-trajectory-kind-tag dsh-trajectory-kind-${row.kind}`, 'data-role-kind': row.kind });
      append(tag, h('span', { class: 'dsh-trajectory-kind-icon', 'aria-hidden': 'true' }, eventIcon(row.kind)));
      append(tag, h('span', { class: 'dsh-trajectory-kind-label' }, KIND_LABEL[row.kind]));
      append(eventInner, tag);
      append(event, eventInner);
      append(rowNode, event);
      const content = h('td', { class: 'dsh-trajectory-content' });
      const text = h('span', { class: row.result === undefined ? 'dsh-trajectory-content-text' : 'dsh-trajectory-result-preview' });
      if (row.kind === 'tool') {
        const request = row.result === undefined
          ? text
          : h('span', { class: 'dsh-trajectory-result-request' });
        append(request, h('span', { class: 'dsh-trajectory-tool-name' }, row.label));
        if (row.text) append(request, h('span', { class: 'dsh-trajectory-tool-payload' }, row.text));
        if (request !== text) append(text, request);
      } else append(text, row.text || '—');
      if (row.result !== undefined) append(text, h('span', { class: row.failed ? 'dsh-trajectory-inline-result is-error' : 'dsh-trajectory-inline-result' },
        h('span', { class: 'dsh-trajectory-arrow' }, '→'),
        h('span', { class: 'dsh-trajectory-inline-result-text' }, row.result || 'No output')));
      append(content, text);
      append(rowNode, content);
      append(body, rowNode);
    });
    append(table, body);
    append(pane, table);
    append(split, pane);
    return split;
  }

  function bind(root: Element): void {
    const durationButton = root.querySelector<HTMLElement>('[data-trajectory-action="duration"]');
    durationButton?.addEventListener('click', () => {
      const actual = durationButton.getAttribute('aria-pressed') !== 'true';
      durationButton.setAttribute('aria-pressed', String(actual));
      root.setAttribute('data-actual-duration', String(actual));
      durationButton.setAttribute('title', actual ? 'Use equal-width operations' : 'Use actual duration');
    });
    for (const name of ['calls', 'turns']) {
      const button = root.querySelector<HTMLElement>(`[data-trajectory-action="${name}"]`);
      button?.addEventListener('click', () => {
        const collapsed = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', String(collapsed));
        root.setAttribute(`data-${name}-collapsed`, String(collapsed));
        const icon = button.querySelector('.dsh-trajectory-action-icon');
        if (icon) icon.textContent = collapsed ? '⊞' : '⊟';
      });
    }
    const search = root.querySelector<HTMLInputElement>('[data-trajectory-search]');
    search?.addEventListener('input', () => {
      const query = search.value.trim().toLocaleLowerCase();
      root.querySelectorAll<HTMLElement>('.dsh-trajectory-table tbody tr').forEach(row => {
        row.hidden = Boolean(query) && !String(row.textContent || '').toLocaleLowerCase().includes(query);
      });
    });
  }

  function render(rows: TrajectoryRow[]): TrajectoryNode {
    const root = h('div', { class: 'dsh-trajectory', 'data-actual-duration': 'true' });
    append(root, toolbar());
    append(root, timeline(rows));
    append(root, h('div', { class: 'dsh-trajectory-ledger' }, ledger(rows)));
    if (DOC) bind(root as Element);
    return root;
  }

  return { project, render, titleForTool };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DshTrajectory;
