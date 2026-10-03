declare global {
  interface MagicPointerSessionLogInput {
    scope: string;
    turns: MagicPointerTurn[];
    workspaceBranch?: string;
    worktreeBranch?: string;
    waiting?: boolean;
    running?: boolean;
    onLocate?: (turnIndex: number, callId?: string) => void;
  }
  var ExecutionView: {
    render(host: HTMLElement, input: MagicPointerSessionLogInput): void;
  };
}

(() => {
  type Kind = 'input' | 'model' | 'tool' | 'context' | 'fork' | 'join';
  type State = 'done' | 'running' | 'error' | 'stopped' | 'waiting';

  interface TraceEntry {
    key: string;
    kind: Kind;
    turn: number;
    order: number;
    title: string;
    preview: string;
    state: State;
    status: string;
    body: string;
    args: string;
    output: string;
    backend: string;
    callId?: string;
    locateCallId?: string;
    branchId?: string;
    startedAt?: number;
    durationMs?: number;
    firstTokenMs?: number;
    tokens?: number;
    model?: string;
    childSteps?: Array<Record<string, unknown>>;
  }

  interface TimeRange {
    start: number;
    end: number;
  }
  interface ChildBranch {
    id: string;
    lane: number;
    forkKey: string;
    joinKey?: string;
    startedAt?: number;
    completedAt?: number;
  }
  interface View {
    input: MagicPointerSessionLogInput;
    root: HTMLElement;
    summary: HTMLElement;
    scopeLabel: HTMLElement;
    state: HTMLElement;
    mode: HTMLSelectElement;
    search: HTMLInputElement;
    list: HTMLElement;
    paths: SVGSVGElement;
    detail: HTMLElement;
    hint: HTMLElement;
    reset: HTMLButtonElement;
    rows: Map<string, HTMLButtonElement>;
    entries: TraceEntry[];
    branches: ChildBranch[];
    selected: string | null;
    range: TimeRange | null;
    rangeAnchor: string | null;
    query: string;
    zoom: number;
    follow: boolean;
    detailVersion: string;
  }

  const views = new WeakMap<HTMLElement, View>();
  const terminalStates = new Set([
    'completed',
    'failed',
    'stopped',
    'user_interrupt',
    'partial',
    'needs_verification',
    'provider_unavailable',
    'budget_exhausted',
    'invariant_failed',
  ]);
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls: string,
    value?: string,
  ) => {
    const node = document.createElement(tag);
    node.className = cls;
    if (value !== undefined) {
      node.textContent = value;
    }
    return node;
  };
  const obj = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const str = (value: unknown): string =>
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value);
  const isChinese = (): boolean =>
    document.documentElement.dataset.language === 'zh-CN';
  const locale = (english: string, chinese: string): string =>
    isChinese() ? chinese : english;
  const kindLabel = (kind: Kind): string =>
    ({
      input: locale('YOU', '你'),
      model: locale('GEN', '生成'),
      tool: locale('TOOL', '工具'),
      context: locale('CTX', '上下文'),
      fork: locale('FORK', '分支'),
      join: locale('JOIN', '汇合'),
    })[kind];
  const statusLabel = (status: string): string =>
    ({
      starting: locale('Starting', '启动中'),
      running: locale('Running', '运行中'),
      awaiting_user: locale('Needs input', '需要输入'),
      completed: locale('Completed', '已完成'),
      failed: locale('Failed', '失败'),
      stopped: locale('Stopped', '已停止'),
      Running: locale('Running', '运行中'),
      Failed: locale('Failed', '失败'),
      Stopped: locale('Stopped', '已停止'),
      Waiting: locale('Waiting', '等待输入'),
      Verified: locale('Verified', '已核验'),
      'Needs input': locale('Needs input', '需要输入'),
    })[status] || status;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const short = (value: string, max = 170) => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > max
      ? `${normalized.slice(0, max)}…`
      : normalized;
  };
  const duration = (ms: number): string =>
    ms < 1000
      ? `${Math.round(ms)}ms`
      : ms < 60000
        ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
        : ms < 3600000
          ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
          : `${(ms / 3600000).toFixed(1)}h`;
  const actualTime = (value: unknown): number | undefined => {
    const timestamp = num(value);
    return timestamp !== undefined && timestamp > 1e11 ? timestamp : undefined;
  };
  const content = (value: unknown): unknown => {
    let next = value;
    for (let count = 0; count < 3; count++) {
      if (typeof next === 'string') {
        try {
          next = JSON.parse(next);
        } catch {
          break;
        }
      } else if (next && typeof next === 'object' && 'value' in next) {
        next = (next as Record<string, unknown>).value;
      } else {
        break;
      }
    }
    return next;
  };

  function timing(
    row: Record<string, unknown>,
  ): Pick<TraceEntry, 'startedAt' | 'durationMs' | 'firstTokenMs'> {
    const raw = num(row.startedAt);
    const origin = actualTime(row.timeOriginMs);
    const startedAt =
      raw === undefined
        ? undefined
        : raw > 1e11
          ? raw
          : origin === undefined
            ? undefined
            : origin + raw;
    const completed = num(row.completedAt);
    const elapsed =
      raw !== undefined && completed !== undefined && completed >= raw
        ? completed - raw
        : num(row.latencyMs);
    const first = num(row.firstTokenAt);
    return {
      startedAt,
      durationMs: elapsed !== undefined && elapsed >= 0 ? elapsed : undefined,
      firstTokenMs:
        raw !== undefined && first !== undefined && first >= raw
          ? first - raw
          : undefined,
    };
  }

  function stateOf(row: Record<string, unknown>): State {
    if (row.state === 'running') {
      return 'running';
    }
    if (
      row.isError === true ||
      row.state === 'error' ||
      row.state === 'failed'
    ) {
      return 'error';
    }
    if (row.state === 'stopped') {
      return 'stopped';
    }
    if (row.state === 'waiting') {
      return 'waiting';
    }
    return 'done';
  }

  function childState(status: string): State {
    if (status === 'starting' || status === 'running') {
      return 'running';
    }
    if (status === 'awaiting_user') {
      return 'waiting';
    }
    if (
      status === 'failed' ||
      status === 'invariant_failed' ||
      status === 'provider_unavailable'
    ) {
      return 'error';
    }
    if (status === 'stopped' || status === 'user_interrupt') {
      return 'stopped';
    }
    return 'done';
  }

  function fromRaw(
    row: Record<string, unknown>,
    key: string,
    turn: number,
    order: number,
    branchId?: string,
    locateCallId?: string,
  ): TraceEntry {
    const rawKind = str(row.kind);
    const kind: Kind =
      rawKind === 'tool' || rawKind === 'subtool'
        ? 'tool'
        : ['message', 'think', 'output', 'model'].includes(rawKind)
          ? 'model'
          : ['user', 'input'].includes(rawKind)
            ? 'input'
            : 'context';
    const state = stateOf(row);
    const time = timing(row);
    const entry: TraceEntry = {
      key,
      kind,
      turn,
      order,
      state,
      title:
        kind === 'input'
          ? locale('You', '你')
          : kind === 'model'
            ? locale('Model', '模型')
            : locale('Context', '上下文'),
      preview: short(str(row.text)),
      status:
        state === 'running'
          ? 'Running'
          : state === 'error'
            ? 'Failed'
            : state === 'stopped'
              ? 'Stopped'
              : state === 'waiting'
                ? 'Waiting'
                : '',
      body: str(row.text),
      args: '',
      output: '',
      backend: str(row.usedBackend),
      callId: str(row.callId) || undefined,
      locateCallId,
      branchId,
      tokens: num(obj(row.modelUsage).totalTokens),
      model: str(row.model || row.modelId) || undefined,
      ...time,
    };
    if (kind === 'tool') {
      const name = str(row.name) || 'Tool';
      const args = str(row.text || row.arguments);
      const output = str(row.result);
      const model = ChatView.toolRowModel(
        name,
        args,
        state === 'running'
          ? undefined
          : {
              text: output,
              isError: state === 'error',
              interrupted: state === 'stopped',
            },
        entry.callId || '',
      );
      const result = obj(content(row.result));
      const returned = str(
        result.documentTitle ||
          result.title ||
          result.summary ||
          result.message ||
          result.error,
      );
      entry.title = name;
      entry.preview = short(
        [model.summary, returned].filter(Boolean).join(' · ') || model.title,
      );
      entry.args = model.body || args;
      entry.output = model.output || output;
      entry.body = '';
      entry.backend ||= str(result.usedBackend);
      if (
        obj(result.verification).verified === true ||
        obj(result.verification).matched === true
      ) {
        entry.status = 'Verified';
      }
      if (result.awaitingUserInput === true) {
        entry.state = 'waiting';
        entry.status = 'Needs input';
      }
    } else if (kind === 'model') {
      entry.title =
        rawKind === 'think'
          ? locale('Thought', '思考')
          : state === 'running'
            ? locale('Generating', '生成中')
            : locale('Model output', '模型输出');
      entry.body = [str(row.reasoning), str(row.text)]
        .filter(Boolean)
        .join('\n\n');
      entry.preview = short(
        str(row.text) ||
          str(row.reasoning) ||
          (state === 'running'
            ? locale('Generating…', '生成中…')
            : locale('Model returned', '模型已返回')),
      );
    } else if (rawKind === 'request-header') {
      entry.title = locale('Model request', '模型请求');
      entry.preview =
        str(row.modelId || row.model || row.usedBackend) ||
        locale('Context submitted', '上下文已提交');
      entry.body = JSON.stringify(row, null, 2);
    } else if (rawKind === 'compacted') {
      entry.title = locale('Context compacted', '上下文已压缩');
    }
    return entry;
  }

  function project(input: MagicPointerSessionLogInput): {
    entries: TraceEntry[];
    branches: ChildBranch[];
  } {
    const entries: TraceEntry[] = [];
    const branches: ChildBranch[] = [];
    const seenChildren = new Set<string>();
    const seenChildRows = new Set<string>();
    let order = 0;
    input.turns.forEach((turn, turnIndex) => {
      const liveRows = turn.liveProgress?.trajectory;
      const rows = liveRows?.length ? liveRows : turn.trajectory || [];
      const turnStart = actualTime(turn.startedAt) ?? actualTime(turn.at);
      const turnEnd = actualTime(turn.completedAt);
      if (
        turn.question &&
        !rows.some(
          row =>
            ['user', 'input'].includes(str(row.kind)) &&
            row.text === turn.question,
        )
      ) {
        entries.push(
          fromRaw(
            {kind: 'user', text: turn.question, startedAt: turnStart},
            `${turnIndex}:question`,
            turnIndex,
            order++,
          ),
        );
      }
      rows.forEach((raw, index) => {
        const callId = str(raw.callId);
        const identity = callId
          ? `${raw.kind}:${callId}:${raw.timeOriginMs || 'legacy'}`
          : raw.kind === 'message'
            ? `message:${raw.timeOriginMs || 'legacy'}:${raw.turn ?? raw.step ?? index}`
            : str(raw.recordId || `${raw.kind}:${raw.seq ?? index}`);
        const key = `${turnIndex}:${identity}`;
        const entry = fromRaw(raw, key, turnIndex, order++);
        if (entry.kind === 'model' && !entry.model) {
          entry.model = str(turn.modelId) || undefined;
        }
        entries.push(entry);
        if (entry.kind !== 'tool' || !callId) {
          return;
        }
        const snapshot = obj(raw.subagent);
        const childId = str(snapshot.id);
        const branchId = `${callId}:${childId}`;
        if (
          !childId ||
          str(snapshot.parentCallId) !== callId ||
          seenChildren.has(branchId)
        ) {
          return;
        }
        seenChildren.add(branchId);
        const result = obj(content(raw.result));
        const childStart = actualTime(snapshot.startedAt);
        const childStatus = str(snapshot.status || result.status);
        const childStatusLabel: Record<string, string> = {
          starting: locale('Starting', '启动中'),
          running: locale('Running', '运行中'),
          awaiting_user: locale('Needs input', '需要输入'),
          completed: locale('Completed', '已完成'),
          failed: locale('Failed', '失败'),
          stopped: locale('Stopped', '已停止'),
        };
        const childEnd = actualTime(snapshot.completedAt);
        const description = short(
          str(snapshot.description) || str(result.description) || childId,
          130,
        );
        const childTokens = num(obj(snapshot.modelUsage).totalTokens);
        const forkKey = `${key}:fork:${childId}`;
        entries.push({
          key: forkKey,
          kind: 'fork',
          turn: turnIndex,
          order: order++,
          title: description,
          preview: [
            childStatusLabel[childStatus] ||
              statusLabel(childStatus) ||
              locale('Dispatched', '已派发'),
            childTokens === undefined ? '' : `${childTokens} tokens`,
          ]
            .filter(Boolean)
            .join(' · '),
          state: childState(childStatus),
          status: childStatus,
          body: str(snapshot.summary || snapshot.reasoning || snapshot.answer),
          args: '',
          output: '',
          backend: 'subagent_session',
          branchId,
          locateCallId: callId,
          startedAt: childStart,
          tokens: childTokens,
          childSteps: Array.isArray(snapshot.steps)
            ? (snapshot.steps as Array<Record<string, unknown>>)
            : undefined,
        });
        const childRows = Array.isArray(snapshot.trajectory)
          ? (snapshot.trajectory as Array<Record<string, unknown>>)
          : [];
        childRows.forEach((child, childIndex) => {
          const childIdentity = `${childId}:${str(child.timeOriginMs)}:${str(child.seq ?? childIndex)}`;
          if (seenChildRows.has(childIdentity)) {
            return;
          }
          seenChildRows.add(childIdentity);
          const childCallId = str(child.callId);
          const childKey = `${forkKey}:${childCallId || child.seq || childIndex}`;
          const projected = fromRaw(
            child,
            childKey,
            turnIndex,
            order++,
            branchId,
            callId,
          );
          if (projected.kind === 'model' || projected.kind === 'tool') {
            entries.push(projected);
          }
        });
        let joinKey: string | undefined;
        if (terminalStates.has(childStatus)) {
          joinKey = `${key}:join:${childId}`;
          entries.push({
            key: joinKey,
            kind: 'join',
            turn: turnIndex,
            order: order++,
            title: description,
            preview:
              childStatus === 'completed'
                ? locale('Subtask returned', '子任务已返回')
                : `${locale('Subtask ended', '子任务结束')} · ${statusLabel(childStatus)}`,
            state: childState(childStatus),
            status: childStatus,
            body: str(snapshot.summary || result.summary),
            args: '',
            output: '',
            backend: 'subagent_session',
            branchId,
            locateCallId: callId,
            startedAt: childEnd,
          });
        }
        branches.push({
          id: branchId,
          lane: 0,
          forkKey,
          joinKey,
          startedAt: childStart,
          completedAt: childEnd,
        });
      });
      const answer = turn.liveProgress?.answer || turn.answer;
      if (
        answer &&
        !rows.some(
          row =>
            ['message', 'output'].includes(str(row.kind)) &&
            row.text === answer,
        )
      ) {
        entries.push(
          fromRaw(
            {kind: 'message', text: answer, startedAt: turnEnd},
            `${turnIndex}:answer`,
            turnIndex,
            order++,
          ),
        );
      }
    });
    const occupied: number[] = [];
    for (const branch of [...branches].sort(
      (left, right) =>
        (left.startedAt ?? Infinity) - (right.startedAt ?? Infinity),
    )) {
      const start = branch.startedAt ?? Infinity;
      let lane = occupied.findIndex(until => until <= start);
      if (lane < 0) {
        lane = occupied.length;
        occupied.push(Infinity);
      }
      occupied[lane] = branch.completedAt ?? Infinity;
      branch.lane = lane + 1;
    }
    return {entries, branches};
  }

  function ordered(view: View): TraceEntry[] {
    if (view.mode.value === 'sequence') {
      return [...view.entries].sort((a, b) => a.order - b.order);
    }
    return [...view.entries].sort((a, b) =>
      a.startedAt === undefined && b.startedAt === undefined
        ? a.order - b.order
        : a.startedAt === undefined
          ? 1
          : b.startedAt === undefined
            ? -1
            : a.startedAt - b.startedAt || a.order - b.order,
    );
  }

  function fixedBranchLaneCount(input: MagicPointerSessionLogInput): number {
    return (
      Number(Boolean(input.workspaceBranch)) +
      Number(Boolean(input.worktreeBranch))
    );
  }

  function renderScope(view: View): void {
    view.scopeLabel.replaceChildren();
    const scopes = [
      view.input.workspaceBranch
        ? {kind: 'git', label: 'Git', value: view.input.workspaceBranch}
        : null,
      view.input.worktreeBranch
        ? {
            kind: 'worktree',
            label: 'Worktree',
            value: view.input.worktreeBranch,
          }
        : null,
      view.branches.length
        ? {
            kind: 'subagent',
            label: 'Subagent',
            value: `${view.branches.length} branch${view.branches.length === 1 ? '' : 'es'}`,
          }
        : null,
    ].filter(Boolean) as Array<{kind: string; label: string; value: string}>;
    scopes.forEach(scope => {
      const chip = el('span', 'mp-trace-scope-chip');
      chip.dataset.scopeKind = scope.kind;
      const translated =
        scope.kind === 'worktree'
          ? locale('Worktree', '工作树')
          : scope.kind === 'subagent'
            ? locale('Subagent', '子代理')
            : scope.label;
      const branchCount =
        scope.kind === 'subagent'
          ? `${view.branches.length} ${
              view.branches.length === 1
                ? locale('branch', '分支')
                : locale('branches', '分支')
            }`
          : scope.value;
      chip.textContent = `${translated} · ${branchCount}`;
      view.scopeLabel.append(chip);
    });
  }

  function setText(node: HTMLElement, value: string): void {
    if (node.textContent !== value) {
      node.textContent = value;
    }
  }

  function showDetail(view: View): void {
    const record = view.entries.find(entry => entry.key === view.selected);
    view.detail.hidden = !record;
    if (!record) {
      view.detail.replaceChildren();
      view.detailVersion = '';
      return;
    }
    const version = `${isChinese() ? 'zh' : 'en'}:${JSON.stringify(record)}`;
    if (version === view.detailVersion) {
      return;
    }
    view.detailVersion = version;
    const heading = el('div', 'mp-trace-detail-heading');
    heading.append(el('strong', '', record.title));
    const close = el('button', 'mp-trace-control', '×');
    close.type = 'button';
    close.setAttribute(
      'aria-label',
      locale('Close event details', '关闭事件详情'),
    );
    close.onclick = () => {
      view.selected = null;
      filter(view);
      showDetail(view);
    };
    heading.append(close);
    const meta = [
      statusLabel(record.status),
      record.durationMs === undefined ? '' : duration(record.durationMs),
      record.backend,
      record.model,
      record.tokens === undefined ? '' : `${record.tokens} tokens`,
    ]
      .filter(Boolean)
      .join(' · ');
    const children: HTMLElement[] = [
      heading,
      el('p', 'mp-trace-detail-meta', meta),
    ];
    if (view.input.onLocate) {
      const locate = el(
        'button',
        'mp-trace-locate',
        locale('View in conversation', '在对话中查看'),
      );
      locate.type = 'button';
      locate.onclick = () =>
        view.input.onLocate?.(
          record.turn,
          record.locateCallId || record.callId,
        );
      children.push(locate);
    }
    if (record.firstTokenMs !== undefined && record.durationMs !== undefined) {
      children.push(
        el(
          'p',
          'mp-trace-detail-meta',
          locale(
            `First token ${duration(record.firstTokenMs)} · remainder ${duration(Math.max(0, record.durationMs - record.firstTokenMs))}`,
            `首字 ${duration(record.firstTokenMs)} · 后续 ${duration(Math.max(0, record.durationMs - record.firstTokenMs))}`,
          ),
        ),
      );
    }
    for (const [name, value] of [
      [locale('Content', '内容'), record.body],
      [locale('Input', '输入'), record.args],
      [locale('Output', '输出'), record.output],
    ]) {
      if (!value) {
        continue;
      }
      children.push(el('div', 'mp-trace-detail-label', name));
      children.push(el('pre', 'mp-trace-detail-text', value));
    }
    if (record.childSteps?.length) {
      children.push(
        el(
          'div',
          'mp-trace-detail-label',
          locale(
            'Recent subtask tool steps · start time unavailable',
            '最近的子任务工具步骤 · 开始时间不可用',
          ),
        ),
      );
      children.push(
        el(
          'pre',
          'mp-trace-detail-text',
          record.childSteps
            .map(step =>
              [
                str(step.tool),
                str(step.status),
                num(step.latencyMs) === undefined
                  ? ''
                  : duration(num(step.latencyMs)!),
              ]
                .filter(Boolean)
                .join(' · '),
            )
            .join('\n'),
        ),
      );
    }
    view.detail.replaceChildren(...children);
  }

  function filter(view: View): void {
    const display = ordered(view);
    const selectedOrder = new Map(
      display.map((entry, index) => [entry.key, index]),
    );
    let shown = 0;
    for (const entry of display) {
      const row = view.rows.get(entry.key);
      if (!row) {
        continue;
      }
      const matches =
        !view.query ||
        `${entry.title} ${entry.preview} ${entry.body} ${entry.args} ${entry.output} ${entry.model || ''} ${entry.backend} ${entry.status}`
          .toLocaleLowerCase()
          .includes(view.query);
      const coordinate =
        view.mode.value === 'sequence'
          ? selectedOrder.get(entry.key)
          : entry.startedAt;
      const inRange =
        !view.range ||
        (coordinate !== undefined &&
          coordinate >= view.range.start &&
          coordinate <= view.range.end);
      row.hidden = !matches || !inRange;
      row.dataset.selected = String(entry.key === view.selected);
      row.setAttribute('aria-expanded', String(entry.key === view.selected));
      if (!row.hidden) {
        shown++;
      }
    }
    view.list.dataset.empty = shown ? 'false' : 'true';
    view.reset.hidden = !view.range;
    requestAnimationFrame(() => drawPaths(view));
  }

  function drawPaths(view: View): void {
    if (!view.root.isConnected) {
      return;
    }
    const rows = view.rows;
    const visible = ordered(view).filter(
      entry =>
        !rows.get(entry.key)?.hidden &&
        (view.mode.value === 'sequence' || entry.startedAt !== undefined),
    );
    const last = [...visible]
      .reverse()
      .find(entry => !entry.branchId && entry.kind !== 'fork');
    const first = visible.find(
      entry => !entry.branchId && entry.kind !== 'fork',
    );
    const bounds = (entry?: TraceEntry) => {
      const row = entry && rows.get(entry.key);
      return row ? row.offsetTop + row.offsetHeight / 2 : undefined;
    };
    const height = Math.max(view.list.scrollHeight, 1);
    const width =
      Number(
        view.root.style
          .getPropertyValue('--trace-rail-width')
          .replace('px', ''),
      ) || 64;
    view.paths.setAttribute('width', String(width));
    view.paths.setAttribute('height', String(height));
    view.paths.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const paths: SVGPathElement[] = [];
    const path = (data: string, cls: string) => {
      const node = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      );
      node.setAttribute('d', data);
      node.setAttribute('class', cls);
      paths.push(node);
    };
    const firstY = bounds(first);
    const lastY = bounds(last);
    if (firstY !== undefined && lastY !== undefined) {
      path(`M 18 ${firstY} L 18 ${lastY}`, 'mp-trace-main-path');
      const fixedLanes = fixedBranchLaneCount(view.input);
      for (let lane = 1; lane <= fixedLanes; lane += 1) {
        const x = 18 + lane * 22;
        path(`M ${x} ${firstY} L ${x} ${lastY}`, 'mp-trace-scope-path');
      }
    }
    const fixedLanes = fixedBranchLaneCount(view.input);
    for (const branch of view.branches) {
      const fork = view.entries.find(entry => entry.key === branch.forkKey);
      const join = view.entries.find(entry => entry.key === branch.joinKey);
      const start = bounds(fork);
      if (start === undefined || rows.get(branch.forkKey)?.hidden) {
        continue;
      }
      const x = 18 + (fixedLanes + branch.lane) * 22;
      const end = join && !rows.get(join.key)?.hidden ? bounds(join) : lastY;
      path(
        `M 18 ${start - 7} C 18 ${start}, ${x} ${start}, ${x} ${start + 8}${end !== undefined && end > start + 8 ? ` L ${x} ${end - 8}` : ''}`,
        'mp-trace-branch-path',
      );
      if (join && end !== undefined && !rows.get(join.key)?.hidden) {
        path(
          `M ${x} ${end - 8} C ${x} ${end}, 18 ${end}, 18 ${end + 7}`,
          'mp-trace-branch-path',
        );
      }
    }
    view.paths.replaceChildren(...paths);
  }

  function choose(view: View, entry: TraceEntry, shift: boolean): void {
    if (shift && view.rangeAnchor) {
      const display = ordered(view);
      const anchor = display.find(item => item.key === view.rangeAnchor);
      const left =
        view.mode.value === 'sequence'
          ? display.indexOf(anchor!)
          : anchor?.startedAt;
      const right =
        view.mode.value === 'sequence'
          ? display.indexOf(entry)
          : entry.startedAt;
      if (
        left !== undefined &&
        right !== undefined &&
        left >= 0 &&
        right >= 0
      ) {
        view.range = {start: Math.min(left, right), end: Math.max(left, right)};
        filter(view);
      }
    } else {
      view.selected = view.selected === entry.key ? null : entry.key;
      view.rangeAnchor = entry.key;
      filter(view);
      showDetail(view);
    }
  }

  function renderRows(view: View): void {
    const display = ordered(view);
    const keys = new Set<string>();
    const fixedLanes = fixedBranchLaneCount(view.input);
    const laneCount =
      fixedLanes + Math.max(0, ...view.branches.map(branch => branch.lane));
    const railWidth = 42 + laneCount * 22;
    view.root.style.setProperty('--trace-rail-width', `${railWidth}px`);
    const laneById = new Map(
      view.branches.map(branch => [branch.id, branch.lane]),
    );
    let unknownStarted = false;
    for (const [index, entry] of display.entries()) {
      keys.add(entry.key);
      let row = view.rows.get(entry.key);
      if (!row) {
        row = el('button', 'mp-trace-row');
        row.type = 'button';
        row.dataset.sessionRow = entry.key;
        row.append(
          el('span', 'mp-trace-gutter'),
          el('span', 'mp-trace-kind'),
          el('span', 'mp-trace-content'),
          el('span', 'mp-trace-meta'),
        );
        view.rows.set(entry.key, row);
      }
      row.onclick = event => choose(view, entry, event.shiftKey);
      row.dataset.kind = entry.kind;
      row.dataset.state = entry.state;
      row.dataset.untimed = String(entry.startedAt === undefined);
      row.dataset.untimedStart = String(
        entry.startedAt === undefined && !unknownStarted,
      );
      if (entry.startedAt === undefined) {
        unknownStarted = true;
      }
      row.style.setProperty(
        '--trace-x',
        `${entry.kind === 'join' ? 18 : entry.branchId ? 18 + (fixedLanes + (laneById.get(entry.branchId) || 1)) * 22 : 18}px`,
      );
      row.setAttribute(
        'aria-label',
        [
          kindLabel(entry.kind),
          entry.title,
          entry.preview,
          entry.durationMs === undefined ? '' : duration(entry.durationMs),
          entry.model || '',
          entry.tokens === undefined ? '' : `${entry.tokens} tokens`,
          statusLabel(entry.status),
        ]
          .filter(Boolean)
          .join(' · '),
      );
      const gutter = row.children[0] as HTMLElement;
      gutter.dataset.marker = entry.kind;
      setText(row.children[1] as HTMLElement, kindLabel(entry.kind));
      const contentHost = row.children[2] as HTMLElement;
      const title =
        contentHost.querySelector<HTMLElement>('.mp-trace-title') ||
        el('span', 'mp-trace-title');
      const preview =
        contentHost.querySelector<HTMLElement>('.mp-trace-preview') ||
        el('span', 'mp-trace-preview');
      setText(title, entry.title);
      setText(
        preview,
        entry.preview ||
          (entry.kind === 'fork'
            ? locale('Subtask dispatched', '子任务已派发')
            : '—'),
      );
      if (!title.isConnected) {
        contentHost.append(title, preview);
      }
      const meta = row.children[3] as HTMLElement;
      const modelStats =
        meta.querySelector<HTMLElement>('.mp-trace-model-stats') ||
        el('span', 'mp-trace-model-stats');
      const modelNode =
        modelStats.querySelector<HTMLElement>('.mp-trace-model-name') ||
        el('span', 'mp-trace-model-name');
      const tokensNode =
        modelStats.querySelector<HTMLElement>('.mp-trace-token-count') ||
        el('span', 'mp-trace-token-count');
      const durationNode =
        meta.querySelector<HTMLElement>('.mp-trace-duration') ||
        el('span', 'mp-trace-duration');
      setText(modelNode, entry.model || '—');
      modelNode.title =
        entry.model || locale('Model unavailable', '模型不可用');
      setText(
        tokensNode,
        entry.tokens === undefined ? '—' : entry.tokens.toLocaleString('en-US'),
      );
      if (!modelNode.isConnected) {
        modelStats.append(modelNode, tokensNode);
      }
      setText(
        durationNode,
        entry.durationMs === undefined ? '—' : duration(entry.durationMs),
      );
      if (!durationNode.isConnected) {
        meta.append(modelStats, durationNode);
      }
      if (entry.callId) {
        row.dataset.callId = entry.callId;
      }
      if (view.list.children[index + 1] !== row) {
        view.list.insertBefore(row, view.list.children[index + 1] || null);
      }
    }
    for (const [key, row] of view.rows) {
      if (!keys.has(key)) {
        row.remove();
        view.rows.delete(key);
      }
    }
    if (view.selected && !keys.has(view.selected)) {
      view.selected = null;
      view.detailVersion = '';
    }
    view.hint.textContent = locale(
      'Event sequence · click to inspect · Shift-click to select a range',
      '事件顺序 · 点击查看详情 · Shift-点击选择范围',
    );
    filter(view);
    showDetail(view);
  }

  function create(host: HTMLElement, input: MagicPointerSessionLogInput): View {
    const root = el('section', 'mp-trace-root');
    root.setAttribute('aria-label', locale('Conversation history', '对话历史'));
    const header = el('header', 'mp-trace-header');
    const heading = el('div', 'mp-trace-heading');
    const summary = el('span', 'mp-trace-summary');
    const scopeLabel = el('span', 'mp-trace-scope');
    const state = el('span', 'mp-trace-state');
    heading.append(
      el('strong', '', locale('Conversation history', '对话历史')),
      state,
    );
    header.append(heading, summary, scopeLabel);
    const controls = el('div', 'mp-trace-controls');
    const mode = el('select', 'mp-trace-mode');
    mode.setAttribute('aria-label', locale('Event order', '事件顺序'));
    for (const [value, title] of [
      ['sequence', locale('Event order', '事件顺序')],
    ]) {
      const option = el('option', '', title);
      option.value = value;
      mode.append(option);
    }
    mode.hidden = true;
    const reset = el(
      'button',
      'mp-trace-control',
      locale('Show all', '显示全部'),
    );
    reset.type = 'button';
    reset.hidden = true;
    const shrink = el('button', 'mp-trace-control', '−');
    shrink.type = 'button';
    shrink.setAttribute('aria-label', locale('Reduce row size', '缩小行高'));
    const expand = el('button', 'mp-trace-control', '+');
    expand.type = 'button';
    expand.setAttribute('aria-label', locale('Increase row size', '放大行高'));
    controls.append(mode, reset, shrink, expand);
    const hint = el('p', 'mp-trace-hint');
    const search = el('input', 'mp-trace-search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = locale(
      'Search the conversation, files, or actions',
      '搜索对话、文件或操作',
    );
    search.dataset.sessionSearch = '';
    search.setAttribute(
      'aria-label',
      locale('Search conversation events', '搜索对话事件'),
    );
    const columnHead = el('div', 'mp-trace-column-head');
    for (const title of [
      '',
      locale('Event', '事件'),
      locale('Content', '内容'),
      locale('Model / tokens', '模型 / tokens'),
      locale('Duration', '耗时'),
    ]) {
      columnHead.append(el('span', '', title));
    }
    const list = el('div', 'mp-trace-list');
    list.setAttribute('role', 'group');
    list.setAttribute(
      'aria-label',
      locale('Conversation events in sequence', '按顺序排列的对话事件'),
    );
    const paths = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    paths.classList.add('mp-trace-paths');
    paths.setAttribute('aria-hidden', 'true');
    list.append(paths);
    const detail = el('section', 'mp-trace-detail');
    detail.hidden = true;
    detail.setAttribute(
      'aria-label',
      locale('Trace event details', '轨迹事件详情'),
    );
    root.append(header, controls, hint, search, columnHead, list, detail);
    host.replaceChildren(root);
    const view: View = {
      input,
      root,
      summary,
      scopeLabel,
      state,
      mode,
      search,
      list,
      paths,
      detail,
      hint,
      reset,
      rows: new Map(),
      entries: [],
      branches: [],
      selected: null,
      range: null,
      rangeAnchor: null,
      query: '',
      zoom: 1,
      follow: true,
      detailVersion: '',
    };
    search.oninput = () => {
      view.query = search.value.trim().toLocaleLowerCase();
      filter(view);
    };
    mode.onchange = () => {
      view.range = null;
      renderRows(view);
    };
    reset.onclick = () => {
      view.range = null;
      filter(view);
    };
    shrink.onclick = () => {
      view.zoom = Math.max(0.8, view.zoom - 0.1);
      root.style.setProperty('--trace-scale', String(view.zoom));
      requestAnimationFrame(() => drawPaths(view));
    };
    expand.onclick = () => {
      view.zoom = Math.min(1.4, view.zoom + 0.1);
      root.style.setProperty('--trace-scale', String(view.zoom));
      requestAnimationFrame(() => drawPaths(view));
    };
    list.onkeydown = event => {
      if (event.key === 'Escape') {
        view.range = null;
        filter(view);
      }
    };
    list.onscroll = () => {
      view.follow = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    };
    return view;
  }

  function refreshChrome(view: View): void {
    view.root.setAttribute(
      'aria-label',
      locale('Conversation history', '对话历史'),
    );
    const heading = view.root.querySelector<HTMLElement>(
      '.mp-trace-heading strong',
    );
    if (heading) {
      heading.textContent = locale('Conversation history', '对话历史');
    }
    view.mode.setAttribute('aria-label', locale('Event order', '事件顺序'));
    const option = view.mode.querySelector<HTMLOptionElement>('option');
    if (option) {
      option.textContent = locale('Event order', '事件顺序');
    }
    view.reset.textContent = locale('Show all', '显示全部');
    const shrink = view.root.querySelector<HTMLButtonElement>(
      '[aria-label="Reduce row size"], [aria-label="缩小行高"]',
    );
    if (shrink) {
      shrink.setAttribute('aria-label', locale('Reduce row size', '缩小行高'));
    }
    const expand = view.root.querySelector<HTMLButtonElement>(
      '[aria-label="Increase row size"], [aria-label="放大行高"]',
    );
    if (expand) {
      expand.setAttribute(
        'aria-label',
        locale('Increase row size', '放大行高'),
      );
    }
    view.search.placeholder = locale(
      'Search the conversation, files, or actions',
      '搜索对话、文件或操作',
    );
    view.search.setAttribute(
      'aria-label',
      locale('Search conversation events', '搜索对话事件'),
    );
    view.list.setAttribute(
      'aria-label',
      locale('Conversation events in sequence', '按顺序排列的对话事件'),
    );
    view.detail.setAttribute(
      'aria-label',
      locale('Trace event details', '轨迹事件详情'),
    );
    const columns = view.root.querySelectorAll<HTMLElement>(
      '.mp-trace-column-head > span',
    );
    [
      '',
      locale('Event', '事件'),
      locale('Content', '内容'),
      locale('Model / tokens', '模型 / tokens'),
      locale('Duration', '耗时'),
    ].forEach((value, index) => {
      if (columns[index]) {
        columns[index].textContent = value;
      }
    });
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
      view.input = input;
      refreshChrome(view);
      const oldCount = view.entries.length;
      const projected = project(input);
      view.entries = projected.entries;
      view.branches = projected.branches;
      if (
        !oldCount &&
        !view.entries.some(entry => entry.startedAt !== undefined)
      ) {
        view.mode.value = 'sequence';
      }
      const tools = view.entries.filter(
        entry => entry.kind === 'tool' && !entry.branchId,
      ).length;
      const tokens = input.turns.reduce(
        (total, turn) => total + (turn.modelUsage?.totalTokens || 0),
        0,
      );
      const failures = view.entries.filter(
        entry => entry.state === 'error',
      ).length;
      setText(
        view.summary,
        [
          locale(
            `${input.turns.length} turn${input.turns.length === 1 ? '' : 's'}`,
            `${input.turns.length} 回合`,
          ),
          locale(`${tools} action${tools === 1 ? '' : 's'}`, `${tools} 个操作`),
          view.branches.length
            ? locale(
                `${view.branches.length} subtask${view.branches.length === 1 ? '' : 's'}`,
                `${view.branches.length} 个子任务`,
              )
            : '',
          tokens
            ? locale(
                `${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`,
                `${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`,
              )
            : '',
          failures ? locale(`${failures} failed`, `${failures} 失败`) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      );
      renderScope(view);
      setText(
        view.state,
        input.waiting
          ? locale('Needs input', '需要输入')
          : input.running
            ? locale('Running', '运行中')
            : '',
      );
      renderRows(view);
      if (
        input.running &&
        view.follow &&
        oldCount !== view.entries.length &&
        !view.query &&
        !view.range
      ) {
        view.list.scrollTop = view.list.scrollHeight;
      }
    },
  };
})();
