declare global {
  interface MagicPointerSessionLogInput {
    scope: string;
    turns: MagicPointerTurn[];
    waiting?: boolean;
    running?: boolean;
    onLocate?: (turnIndex: number, callId?: string) => void;
  }
  var ExecutionView: {
    render(host: HTMLElement, input: MagicPointerSessionLogInput): void;
  };
}

(() => {
  type Kind = 'input' | 'model' | 'tool' | 'context';
  interface RecordEntry {
    key: string;
    kind: Kind;
    turn: number;
    title: string;
    preview: string;
    state: string;
    status: string;
    body: string;
    args: string;
    output: string;
    backend: string;
    callId?: string;
    start?: number;
    durationMs?: number;
    firstTokenMs?: number;
  }
  interface Span {
    record: RecordEntry;
    start: number;
    end: number;
  }
  interface Range {
    start: number;
    end: number;
  }
  interface RowView {
    row: HTMLButtonElement;
    title: HTMLElement;
    preview: HTMLElement;
    time: HTMLElement;
    index: HTMLElement;
  }
  interface View {
    input: MagicPointerSessionLogInput;
    root: HTMLElement;
    summary: HTMLElement;
    state: HTMLElement;
    mode: HTMLSelectElement;
    search: HTMLInputElement;
    track: HTMLElement;
    axis: HTMLElement;
    hint: HTMLElement;
    selection: HTMLElement;
    reset: HTMLButtonElement;
    list: HTMLElement;
    detail: HTMLElement;
    rows: Map<string, RowView>;
    bars: Map<string, HTMLButtonElement>;
    projected: Map<
      string,
      {source: Record<string, unknown>; entry: RecordEntry}
    >;
    records: RecordEntry[];
    spans: Span[];
    range: Range | null;
    viewport: Range | null;
    domain: Range;
    selected: string | null;
    follow: boolean;
    query: string;
    detailVersion: string;
    drag: {
      pointer: number;
      clientX: number;
      time: number;
      key: string | null;
      moved: boolean;
    } | null;
  }
  const views = new WeakMap<HTMLElement, View>();
  const lane = (kind: Kind) => (kind === 'tool' ? 2 : kind === 'model' ? 1 : 0);
  const kindLabel: Record<Kind, string> = {
    input: '你',
    model: '回复',
    tool: '操作',
    context: '上下文',
  };
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls: string,
    text?: string,
  ) => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };
  const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const text = (value: unknown): string =>
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value);
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const compact = (value: string, max = 180) => {
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  };
  const duration = (ms: number): string =>
    ms < 1000
      ? `${Math.round(ms)}ms`
      : ms < 60000
        ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
        : ms < 3600000
          ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
          : `${(ms / 3600000).toFixed(1)}h`;
  const clock = (ms: number) =>
    new Date(ms).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  function decode(value: unknown): unknown {
    for (let count = 0; count < 4; count++) {
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      } else if (value && typeof value === 'object' && 'value' in value) {
        value = (value as Record<string, unknown>).value;
      } else {
        break;
      }
    }
    return value;
  }
  function timing(
    record: Record<string, unknown>,
  ): Pick<RecordEntry, 'start' | 'durationMs' | 'firstTokenMs'> {
    const raw = finite(record.startedAt);
    const origin = finite(record.timeOriginMs);
    const end = finite(record.completedAt);
    const start =
      raw === undefined
        ? undefined
        : origin !== undefined
          ? origin + raw
          : raw > 1e11
            ? raw
            : undefined;
    const elapsed =
      raw !== undefined && end !== undefined && end >= raw
        ? end - raw
        : finite(record.latencyMs);
    const first = finite(record.firstTokenAt);
    return {
      start,
      durationMs: elapsed !== undefined && elapsed >= 0 ? elapsed : undefined,
      firstTokenMs:
        raw !== undefined && first !== undefined && first >= raw
          ? first - raw
          : undefined,
    };
  }
  function recordEntry(
    raw: Record<string, unknown>,
    key: string,
    turn: number,
  ): RecordEntry {
    const rawKind = String(raw.kind || 'context');
    const kind: Kind = ['tool', 'subtool'].includes(rawKind)
      ? 'tool'
      : ['message', 'think', 'output'].includes(rawKind)
        ? 'model'
        : ['user', 'input'].includes(rawKind)
          ? 'input'
          : 'context';
    const state =
      raw.state === 'running'
        ? 'running'
        : raw.isError === true || raw.state === 'error'
          ? 'error'
          : raw.state === 'stopped'
            ? 'stopped'
            : 'done';
    const entry: RecordEntry = {
      key,
      kind,
      turn,
      title: kindLabel[kind],
      preview: compact(text(raw.text)),
      state,
      status:
        state === 'running'
          ? '进行中'
          : state === 'error'
            ? '失败'
            : state === 'stopped'
              ? '已停止'
              : '',
      body: text(raw.text),
      args: '',
      output: '',
      backend: text(raw.usedBackend),
      ...timing(raw),
    };
    if (kind === 'tool') {
      const name = text(raw.name) || 'Tool';
      const args = text(raw.text || raw.arguments);
      const output = text(raw.result);
      const row = ChatView.toolRowModel(
        name,
        args,
        state === 'running'
          ? undefined
          : {
              text: output,
              isError: state === 'error',
              interrupted: state === 'stopped',
            },
        text(raw.callId),
      );
      const data = decode(raw.result);
      const result = object(data);
      const verification = object(result.verification);
      const titles: Record<string, string> = {
        Read: '读取文件',
        Write: '保存文件',
        Edit: '修改文件',
        'Browser.navigate': '打开网页',
        Tools: '准备工具',
        list_windows: '查找窗口',
        AskUser: '向你提问',
        AskUserQuestion: '向你提问',
        TodoWrite: '更新计划',
        Wait: '等待',
      };
      const returned =
        text(
          result.documentTitle ||
            result.title ||
            result.summary ||
            result.message ||
            result.error,
        ) ||
        (typeof data === 'string'
          ? data
          : Array.isArray(data)
            ? `返回 ${data.length} 项`
            : '');
      entry.callId = text(raw.callId);
      entry.title = titles[name] || row.title;
      entry.preview = compact(
        [row.summary || '', returned].filter(Boolean).join(' · '),
      );
      entry.args = row.body || args;
      entry.output = row.output || output;
      entry.body = '';
      entry.backend ||= text(result.usedBackend);
      if (verification.verified === true || verification.matched === true) {
        entry.status = '已核验';
      }
      if (result.awaitingUserInput === true) {
        entry.state = 'waiting';
        entry.status = '等你处理';
      }
    } else if (kind === 'model') {
      entry.title =
        rawKind === 'think'
          ? '思考'
          : state === 'running'
            ? '正在回复'
            : '回复';
      entry.body = [text(raw.reasoning), text(raw.text)]
        .filter(Boolean)
        .join('\n\n');
      entry.preview = compact(
        text(raw.text) ||
          text(raw.reasoning) ||
          (state === 'running' ? '正在组织回复…' : '模型已返回'),
      );
    } else if (rawKind === 'request-header') {
      entry.title = '请求模型';
      entry.preview =
        text(raw.modelId || raw.model || raw.usedBackend) || '准备本次上下文';
      entry.body = JSON.stringify(raw, null, 2);
    } else if (rawKind === 'compacted') {
      entry.title = '整理上下文';
    }
    return entry;
  }
  function project(
    turns: MagicPointerTurn[],
    cache: View['projected'],
  ): RecordEntry[] {
    const records: RecordEntry[] = [];
    const fields = [
      'kind',
      'name',
      'text',
      'arguments',
      'result',
      'state',
      'isError',
      'timeOriginMs',
      'startedAt',
      'completedAt',
      'latencyMs',
      'firstTokenAt',
      'usedBackend',
      'reasoning',
      'modelId',
      'model',
    ];
    const keys = new Set<string>();
    const add = (
      source: Record<string, unknown>,
      key: string,
      turn: number,
    ) => {
      keys.add(key);
      const previous = cache.get(key);
      if (
        previous &&
        fields.every(field => previous.source[field] === source[field])
      ) {
        records.push(previous.entry);
        return;
      }
      const entry = recordEntry(source, key, turn);
      cache.set(key, {source: {...source}, entry});
      records.push(entry);
    };
    turns.forEach((turn, turnIndex) => {
      const raw = turn.liveProgress?.trajectory || turn.trajectory || [];
      const prefix = `${turnIndex}:`;
      const from = finite(turn.startedAt) ?? finite(turn.at);
      const to = finite(turn.completedAt);
      if (
        turn.question &&
        !raw.some(
          row =>
            ['user', 'input'].includes(String(row.kind)) &&
            row.text === turn.question,
        )
      ) {
        add(
          {kind: 'user', text: turn.question, startedAt: from},
          `${prefix}question`,
          turnIndex,
        );
      }
      raw.forEach((row, index) => {
        const identity = row.callId
          ? `${row.kind}:${row.callId}:${row.timeOriginMs ?? 'legacy'}`
          : row.kind === 'message'
            ? `message:${row.timeOriginMs ?? 'legacy'}:${row.turn ?? row.step ?? index}`
            : String(row.recordId || `${row.kind}:${row.seq ?? index}`);
        add(row, `${prefix}${identity}`, turnIndex);
      });
      const answer = turn.liveProgress?.answer || turn.answer;
      if (
        answer &&
        !raw.some(
          row =>
            ['message', 'output'].includes(String(row.kind)) &&
            row.text === answer,
        )
      ) {
        add(
          {kind: 'message', text: answer, startedAt: to},
          `${prefix}answer`,
          turnIndex,
        );
      }
    });
    for (const key of cache.keys()) {
      if (!keys.has(key)) {
        cache.delete(key);
      }
    }
    return records;
  }
  function setText(node: HTMLElement, value: string): void {
    if (node.textContent !== value) {
      node.textContent = value;
    }
  }
  function choose(view: View, key: string): void {
    view.selected = view.selected === key ? null : key;
    filter(view);
    showDetail(view);
    view.rows.get(key)?.row.scrollIntoView({block: 'nearest'});
  }
  function showDetail(view: View): void {
    const record = view.records.find(item => item.key === view.selected);
    view.detail.hidden = !record;
    if (!record) {
      view.detail.replaceChildren();
      view.detailVersion = '';
      return;
    }
    const version = JSON.stringify(record);
    if (version === view.detailVersion) {
      return;
    }
    view.detailVersion = version;
    const heading = element('div', 'mp-session-detail-heading');
    heading.append(element('strong', '', record.title));
    const close = element('button', 'mp-session-button', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭记录详情');
    close.onclick = () => {
      view.selected = null;
      filter(view);
      showDetail(view);
    };
    heading.append(close);
    const metadata = [
      record.status,
      record.start === undefined ? '开始时间未记录' : clock(record.start),
      record.durationMs === undefined ? '' : duration(record.durationMs),
      record.backend,
    ]
      .filter(Boolean)
      .join(' · ');
    const children: HTMLElement[] = [
      heading,
      element('p', 'mp-session-detail-meta', metadata),
    ];
    if (view.input.onLocate) {
      const locate = element('button', 'mp-session-locate', '在对话中查看');
      locate.type = 'button';
      locate.dataset.sessionLocate = '';
      locate.onclick = () => view.input.onLocate?.(record.turn, record.callId);
      children.push(locate);
    }
    if (record.firstTokenMs !== undefined && record.durationMs !== undefined) {
      children.push(
        element(
          'p',
          'mp-session-detail-meta',
          `等待首字 ${duration(record.firstTokenMs)} · 生成 ${duration(Math.max(0, record.durationMs - record.firstTokenMs))}`,
        ),
      );
    }
    for (const [label, value] of [
      ['内容', record.body],
      ['输入', record.args],
      ['结果', record.output],
    ]) {
      if (!value) {
        continue;
      }
      if (record.kind === 'tool') {
        children.push(element('div', 'mp-session-detail-label', label));
      }
      children.push(element('pre', 'mp-session-detail-text', value));
    }
    view.detail.replaceChildren(...children);
  }
  function filter(view: View): void {
    const spans = new Map(view.spans.map(span => [span.record.key, span]));
    let shown = 0;
    view.records.forEach(record => {
      const span = spans.get(record.key);
      const matches =
        !view.query ||
        `${record.title} ${record.preview} ${record.body} ${record.args} ${record.output}`
          .toLocaleLowerCase()
          .includes(view.query);
      const inRange =
        !view.range ||
        Boolean(
          span && span.start <= view.range.end && span.end >= view.range.start,
        );
      const row = view.rows.get(record.key)!.row;
      row.hidden = !matches || !inRange;
      if (!row.hidden) {
        shown++;
      }
      row.dataset.selected = String(record.key === view.selected);
      row.setAttribute('aria-expanded', String(record.key === view.selected));
      const bar = view.bars.get(record.key);
      if (bar) {
        bar.dataset.dimmed = String(!matches || !inRange);
        bar.dataset.selected = String(record.key === view.selected);
      }
    });
    view.list.dataset.empty = shown ? 'false' : 'true';
    view.reset.hidden = !view.range && !view.viewport;
    if (view.range) {
      const domain = view.viewport || view.domain;
      const width = Math.max(1, domain.end - domain.start);
      view.selection.hidden = false;
      view.selection.style.left = `${((view.range.start - domain.start) / width) * 100}%`;
      view.selection.style.width = `${((view.range.end - view.range.start) / width) * 100}%`;
    } else {
      view.selection.hidden = true;
    }
  }
  function drawTimeline(view: View): void {
    const sequence = view.mode.value === 'sequence';
    view.spans = view.records.flatMap((record, index): Span[] =>
      sequence
        ? [{record, start: index, end: index + 1}]
        : record.start === undefined
          ? []
          : [
              {
                record,
                start: record.start,
                end: record.start + (record.durationMs ?? 0),
              },
            ],
    );
    const starts = view.spans.map(span => span.start);
    const ends = view.spans.map(span => span.end);
    view.domain = starts.length
      ? {start: Math.min(...starts), end: Math.max(...ends)}
      : {start: 0, end: 1};
    if (view.domain.end <= view.domain.start) {
      view.domain.end = view.domain.start + 1;
    }
    const domain = view.viewport || view.domain;
    const width = domain.end - domain.start;
    const keys = new Set<string>();
    for (const span of view.spans) {
      const record = span.record;
      keys.add(record.key);
      let bar = view.bars.get(record.key);
      if (!bar) {
        bar = element('button', 'mp-session-span');
        bar.type = 'button';
        bar.dataset.sessionSpan = record.key;
        bar.tabIndex = -1;
        bar.onclick = event => {
          if (event.detail === 0) {
            choose(view, record.key);
          }
        };
        view.bars.set(record.key, bar);
        view.track.append(bar);
      }
      bar.dataset.kind = record.kind;
      bar.dataset.state = record.state;
      if (record.callId) {
        bar.dataset.callId = record.callId;
      }
      bar.hidden = span.end < domain.start || span.start > domain.end;
      bar.style.left = `${((Math.max(domain.start, span.start) - domain.start) / width) * 100}%`;
      bar.style.width = `${(Math.max(0, Math.min(domain.end, span.end) - Math.max(domain.start, span.start)) / width) * 100}%`;
      bar.style.top = `${lane(record.kind) * 24 + 5}px`;
      bar.dataset.instant = String(span.start === span.end);
      if (record.firstTokenMs !== undefined && record.durationMs) {
        bar.style.setProperty(
          '--first-token',
          `${Math.min(100, (record.firstTokenMs / record.durationMs) * 100)}%`,
        );
      } else {
        bar.style.removeProperty('--first-token');
      }
      bar.title = [
        record.title,
        record.preview,
        record.start === undefined ? '时间未记录' : clock(record.start),
        record.durationMs === undefined ? '' : duration(record.durationMs),
        record.status,
      ]
        .filter(Boolean)
        .join('\n');
      bar.setAttribute('aria-label', bar.title);
    }
    for (const [key, bar] of view.bars) {
      if (!keys.has(key)) {
        bar.remove();
        view.bars.delete(key);
      }
    }
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(fraction =>
      element(
        'span',
        '',
        sequence
          ? String(Math.round(domain.start + width * fraction))
          : duration(width * fraction),
      ),
    );
    view.axis.replaceChildren(...ticks);
    const missing = view.records.length - view.spans.length;
    setText(
      view.hint,
      sequence
        ? '按发生顺序排列 · 横向拖选可筛选记录'
        : `${view.spans.length ? `${clock(domain.start)} 起 · ` : ''}横向拖选可筛选记录${missing ? ` · ${missing} 条未记录开始时间` : ''}`,
    );
    filter(view);
  }
  function create(host: HTMLElement, input: MagicPointerSessionLogInput): View {
    const root = element('section', 'mp-session-log');
    root.setAttribute('aria-label', '完整对话记录');
    const header = element('header', 'mp-session-header');
    const heading = element('div', 'mp-session-heading');
    const summary = element('span', 'mp-session-summary');
    const state = element('span', 'mp-session-state');
    heading.append(element('strong', '', '完整会话'), state);
    header.append(heading, summary);
    const controls = element('div', 'mp-session-controls');
    const mode = element('select', 'mp-session-mode');
    mode.dataset.sessionMode = '';
    mode.setAttribute('aria-label', '时间线排列方式');
    for (const [value, label] of [
      ['time', '实际时间'],
      ['sequence', '事件顺序'],
    ]) {
      const option = element('option', '', label);
      option.value = value;
      mode.append(option);
    }
    const reset = element('button', 'mp-session-button', '显示全部');
    reset.type = 'button';
    reset.hidden = true;
    const zoomOut = element('button', 'mp-session-button', '−');
    const zoomIn = element('button', 'mp-session-button', '+');
    zoomOut.type = zoomIn.type = 'button';
    zoomOut.setAttribute('aria-label', '缩小时间线');
    zoomIn.setAttribute('aria-label', '放大时间线');
    controls.append(mode, reset, zoomOut, zoomIn);
    const plot = element('div', 'mp-session-plot');
    const labels = element('div', 'mp-session-lanes');
    ['输入', '模型', '操作'].forEach((label, index) => {
      const item = element('span', '', label);
      item.dataset.sessionLane = String(index);
      labels.append(item);
    });
    const track = element('div', 'mp-session-track');
    track.tabIndex = 0;
    track.setAttribute(
      'aria-label',
      '对话时间线，拖动选择范围，Escape 显示全部',
    );
    const selection = element('div', 'mp-session-selection');
    selection.hidden = true;
    track.append(selection);
    const axis = element('div', 'mp-session-axis');
    const hint = element('p', 'mp-session-hint');
    plot.append(labels, track, axis);
    const search = element('input', 'mp-session-search');
    search.type = 'search';
    search.placeholder = '查找对话、文件或操作';
    search.dataset.sessionSearch = '';
    search.setAttribute('aria-label', '查找对话记录');
    const list = element('div', 'mp-session-list');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', '按发生顺序的事件');
    const detail = element('section', 'mp-session-detail');
    detail.hidden = true;
    detail.setAttribute('aria-label', '记录详情');
    root.append(header, controls, plot, hint, search, list, detail);
    host.replaceChildren(root);
    const view: View = {
      input,
      root,
      summary,
      state,
      mode,
      search,
      track,
      axis,
      hint,
      selection,
      reset,
      list,
      detail,
      rows: new Map(),
      bars: new Map(),
      projected: new Map(),
      records: [],
      spans: [],
      range: null,
      viewport: null,
      domain: {start: 0, end: 1},
      selected: null,
      follow: true,
      query: '',
      detailVersion: '',
      drag: null,
    };
    search.oninput = () => {
      view.query = search.value.trim().toLocaleLowerCase();
      filter(view);
    };
    mode.onchange = () => {
      view.range = null;
      view.viewport = null;
      drawTimeline(view);
    };
    const resetRange = () => {
      view.range = null;
      view.viewport = null;
      drawTimeline(view);
    };
    reset.onclick = resetRange;
    track.ondblclick = resetRange;
    track.onkeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        resetRange();
      }
    };
    const zoom = (factor: number, fraction = 0.5) => {
      const full = view.domain.end - view.domain.start;
      const current = view.viewport || view.domain;
      const width = Math.min(
        full,
        Math.max(
          view.mode.value === 'sequence' ? 3 : 100,
          (current.end - current.start) * factor,
        ),
      );
      const anchor = current.start + (current.end - current.start) * fraction;
      const start = Math.max(
        view.domain.start,
        Math.min(view.domain.end - width, anchor - width * fraction),
      );
      view.viewport = width >= full ? null : {start, end: start + width};
      drawTimeline(view);
    };
    zoomIn.onclick = () => zoom(0.5);
    zoomOut.onclick = () => zoom(2);
    track.addEventListener(
      'wheel',
      event => {
        event.preventDefault();
        const bounds = track.getBoundingClientRect();
        zoom(
          Math.exp(event.deltaY * 0.002),
          Math.max(
            0,
            Math.min(1, (event.clientX - bounds.left) / bounds.width),
          ),
        );
      },
      {passive: false},
    );
    const timeAt = (clientX: number) => {
      const bounds = track.getBoundingClientRect();
      const domain = view.viewport || view.domain;
      return (
        domain.start +
        Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) *
          (domain.end - domain.start)
      );
    };
    track.onpointerdown = event => {
      if (event.button !== 0) {
        return;
      }
      view.drag = {
        pointer: event.pointerId,
        clientX: event.clientX,
        time: timeAt(event.clientX),
        key:
          (event.target as HTMLElement).closest<HTMLElement>(
            '[data-session-span]',
          )?.dataset.sessionSpan || null,
        moved: false,
      };
      track.setPointerCapture(event.pointerId);
    };
    track.onpointermove = event => {
      const drag = view.drag;
      if (!drag || drag.pointer !== event.pointerId) {
        return;
      }
      if (Math.abs(event.clientX - drag.clientX) < 4 && !drag.moved) {
        return;
      }
      drag.moved = true;
      const point = timeAt(event.clientX);
      view.range = {
        start: Math.min(drag.time, point),
        end: Math.max(drag.time, point),
      };
      filter(view);
    };
    track.onpointerup = event => {
      const drag = view.drag;
      if (!drag || drag.pointer !== event.pointerId) {
        return;
      }
      if (!drag.moved && drag.key) {
        event.preventDefault();
        choose(view, drag.key);
      }
      if (!drag.moved && !drag.key) {
        view.range = null;
        filter(view);
      }
      track.releasePointerCapture(event.pointerId);
      view.drag = null;
    };
    track.onpointercancel = () => {
      view.drag = null;
      view.range = null;
      filter(view);
    };
    list.onscroll = () => {
      view.follow = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    };
    return view;
  }
  globalThis.ExecutionView = {
    render(host, input) {
      let view = views.get(host);
      if (
        !view ||
        view.input.scope !== input.scope ||
        !host.contains(view.root)
      ) {
        view = create(host, input);
        views.set(host, view);
      }
      const current = view;
      view.input = input;
      const oldCount = view.records.length;
      view.records = project(input.turns, view.projected);
      if (
        !oldCount &&
        view.records.length &&
        !view.records.some(
          record =>
            record.start !== undefined && record.durationMs !== undefined,
        )
      ) {
        view.mode.value = 'sequence';
      }
      const toolCount = view.records.filter(
        record => record.kind === 'tool',
      ).length;
      const tokens = input.turns.reduce(
        (sum, turn) => sum + (turn.modelUsage?.totalTokens || 0),
        0,
      );
      const failures = view.records.filter(
        record => record.state === 'error',
      ).length;
      setText(
        view.summary,
        [
          `${input.turns.length} 次提问`,
          `${toolCount} 次操作`,
          tokens
            ? `${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`
            : '',
          failures ? `${failures} 项失败` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      );
      setText(
        view.state,
        input.waiting ? '等你回复' : input.running ? '进行中' : '',
      );
      const keys = new Set<string>();
      view.records.forEach((record, index) => {
        keys.add(record.key);
        let row = current.rows.get(record.key);
        if (!row) {
          const root = element('button', 'mp-session-row');
          root.type = 'button';
          root.dataset.sessionRow = record.key;
          root.onclick = () => choose(current, record.key);
          const ordinal = element('span', 'mp-session-index');
          const title = element('span', 'mp-session-event');
          const preview = element('span', 'mp-session-preview');
          const time = element('span', 'mp-session-duration');
          root.append(ordinal, title, preview, time);
          row = {row: root, title, preview, time, index: ordinal};
          current.rows.set(record.key, row);
        }
        const root = row.row;
        root.dataset.kind = record.kind;
        root.dataset.state = record.state;
        root.dataset.turnStart = String(
          index === 0 || current.records[index - 1].turn !== record.turn,
        );
        if (record.callId) {
          root.dataset.callId = record.callId;
        }
        root.title = [record.title, record.preview, record.status]
          .filter(Boolean)
          .join(' · ');
        setText(row.index, String(index + 1).padStart(2, '0'));
        setText(row.title, record.title);
        setText(row.preview, record.preview || '—');
        setText(
          row.time,
          record.durationMs === undefined
            ? record.state === 'running'
              ? '…'
              : '—'
            : duration(record.durationMs),
        );
        if (current.list.children[index] !== root) {
          current.list.insertBefore(root, current.list.children[index] || null);
        }
      });
      for (const [key, row] of view.rows) {
        if (!keys.has(key)) {
          row.row.remove();
          view.rows.delete(key);
        }
      }
      if (view.selected && !keys.has(view.selected)) {
        view.selected = null;
      }
      drawTimeline(view);
      showDetail(view);
      if (
        view.follow &&
        oldCount !== view.records.length &&
        !view.query &&
        !view.range
      ) {
        view.list.scrollTop = view.list.scrollHeight;
      }
    },
  };
})();
