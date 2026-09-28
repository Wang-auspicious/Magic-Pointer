declare global {
  var ExecutionView: {
    render(host: HTMLElement, input: { scope: string; trajectory: Record<string, unknown>[];
      timingMs?: number; totalTokens?: number; waiting?: boolean; running?: boolean }): void;
  };
}

(() => {
  type Phase = 'prepare' | 'read' | 'act';
  interface Step {
    key: string; phase: Phase; title: string; target: string; state: string; outcome: string;
    label: string; duration: string; args: string; output: string; backend: string;
  }
  interface StepView { node: HTMLDetailsElement; summary: HTMLElement; detail: HTMLElement; step?: Step }
  interface PhaseView { node: HTMLDetailsElement; title: HTMLElement; count: HTMLElement; body: HTMLElement }
  interface View {
    scope: string; visible: number; overview: HTMLElement; phases: HTMLElement; more: HTMLButtonElement;
    steps: Map<string, StepView>; groups: Map<string, PhaseView>;
    projection: Map<string, { source: Record<string, unknown>; step: Step }>;
  }
  const views = new WeakMap<HTMLElement, View>();
  const labels: Record<Phase, string> = { prepare: '准备工具', read: '读取与查找', act: '执行操作' };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
    const result = document.createElement(tag); result.className = cls;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  function decode(value: unknown): unknown {
    for (let i = 0; i < 4; i++) {
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return value; } }
      else if (value && typeof value === 'object' && 'value' in value) value = (value as Record<string, unknown>).value;
      else break;
    }
    return value;
  }
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const text = (value: unknown): string => typeof value === 'string' ? value : '';
  const compact = (value: string, max = 160): string => {
    const line = value.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max)}…` : line;
  };
  const duration = (ms: number): string => !Number.isFinite(ms) || ms < 0 ? ''
    : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${Math.round(ms / 1000)}s`
      : `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`;
  function project(call: Record<string, unknown>, index: number): Step {
    const name = String(call.name || 'Tool');
    const args = typeof call.text === 'string' ? call.text : JSON.stringify(call.text || {});
    const output = call.result === undefined ? '' : typeof call.result === 'string' ? call.result : JSON.stringify(call.result);
    const row = ChatView.toolRowModel(name, args, call.state === 'running' ? undefined : {
      text: output, isError: call.state === 'error' || call.isError === true, interrupted: call.state === 'stopped',
    }, String(call.callId || ''));
    const data = decode(call.result), result = object(data), verification = object(result.verification);
    const phase: Phase = /^(Tools|Todo|TodoWrite|todo_write|ToolSearch)$/.test(name) ? 'prepare'
      : ['read', 'search', 'ls', 'glob', 'grep', 'fetch'].includes(row.variant)
        || /^(list_|get_|read_|observe_|search_|find_|capture_|inspect_|expand_|Look$|Recall$|Context\.|Knowledge\.|ToolResult\.)/.test(name) ? 'read' : 'act';
    const state = result.awaitingUserInput === true ? 'waiting' : row.state;
    const verified = verification.verified === true || verification.matched === true;
    const label = state === 'running' ? '进行中' : state === 'error' ? '失败'
      : state === 'stopped' ? '已停止' : state === 'waiting' ? '等你处理' : verified ? '已核验' : '已返回';
    let outcome = '';
    if (state === 'error') outcome = text(result.error) || text(result.error_message) || text(result.message) || output;
    else if (state === 'waiting') outcome = text(result.question) || '回答后继续这一步';
    else if (state === 'running') outcome = '正在等待工具返回';
    else if (state === 'stopped') outcome = '操作已停止';
    else if (phase === 'prepare') outcome = '本轮所需能力已就绪';
    else outcome = text(result.documentTitle) || text(result.title) || text(result.summary) || text(result.message)
      || (Array.isArray(data) ? `返回 ${data.length} 项` : typeof data === 'string' ? data : '')
      || (verified ? '已核对目标应用中的结果' : '工具已返回，可展开查看原始记录');
    return { key: String(call.callId || `step-${index}`), phase, title: row.title, target: row.summary || row.name,
      state, outcome: compact(outcome), label,
      duration: typeof call.startedAt === 'number' && typeof call.completedAt === 'number'
        ? duration(call.completedAt - call.startedAt) : '',
      args: row.body || '', output: row.output || '', backend: text(call.usedBackend) || text(result.usedBackend) };
  }
  function detail(view: StepView): void {
    view.detail.replaceChildren();
    if (!view.node.open) return;
    const { step } = view;
    if (!step) return;
    for (const [label, value] of [['输入', step.args], ['返回', step.output], ['执行方式', step.backend]]) {
      if (!value) continue;
      view.detail.append(node('div', 'mp-execution-detail-label', label), node('pre', 'mp-execution-raw', value));
    }
    if (!view.detail.childElementCount) view.detail.append(node('p', 'mp-execution-note', '这一步没有额外记录。'));
  }
  function updateStep(step: Step, view: StepView): void {
    if (step === view.step) return;
    view.step = step;
    view.node.dataset.state = step.state;
    const top = node('div', 'mp-execution-step-top');
    top.append(node('strong', 'mp-execution-step-title', step.title), node('span', 'mp-execution-status', step.label));
    const target = node('div', 'mp-execution-target', step.target); target.title = step.target;
    const bottom = node('div', 'mp-execution-result');
    bottom.append(node('span', '', step.outcome));
    if (step.duration) bottom.append(node('time', '', step.duration));
    view.summary.replaceChildren(top, target, bottom);
    detail(view);
  }
  globalThis.ExecutionView = {
    render(host, input) {
      let view = views.get(host);
      if (!view || view.scope !== input.scope || !host.contains(view.overview)) {
        const overview = node('header', 'mp-execution-overview');
        const phases = node('div', 'mp-execution-phases');
        const more = node('button', 'mp-execution-more', '显示更早的步骤'); more.type = 'button';
        view = { scope: input.scope, visible: 24, overview, phases, more, steps: new Map(), groups: new Map(), projection: new Map() };
        views.set(host, view); host.replaceChildren(overview, more, phases);
      }
      const calls = input.trajectory.filter(call => call.kind === 'tool');
      const steps = calls.map((call, index) => {
        const key = String(call.callId || `step-${index}`), cached = view.projection.get(key);
        if (cached && ['name', 'text', 'result', 'state', 'isError', 'startedAt', 'completedAt', 'usedBackend']
          .every(field => cached.source[field] === call[field])) return cached.step;
        const step = project(call, index); view.projection.set(key, { source: { ...call }, step }); return step;
      });
      const keys = new Set(steps.map(step => step.key));
      for (const key of view.projection.keys()) if (!keys.has(key)) view.projection.delete(key);
      const failures = steps.filter(step => step.state === 'error').length;
      const current = [...steps].reverse().find(step => step.state === 'running');
      const waiting = input.waiting;
      const heading = node('div', 'mp-execution-overline', '这一轮的工作');
      const title = node('h3', 'mp-execution-title', waiting ? '等你做一个决定' : current ? current.title
        : input.running ? '正在继续任务' : failures ? '有步骤需要留意' : steps.length ? '执行记录已就绪' : '从这里看清每一步');
      const metrics = node('div', 'mp-execution-metrics');
      if (steps.length) metrics.append(node('span', '', `${steps.length} 次调用`));
      if (input.timingMs && !input.running) metrics.append(node('span', '', duration(input.timingMs)));
      if (input.totalTokens) metrics.append(node('span', '', `${input.totalTokens >= 1000 ? `${(input.totalTokens / 1000).toFixed(1)}k` : input.totalTokens} tokens`));
      if (failures) metrics.append(node('span', 'mp-execution-failure-count', `${failures} 项失败`));
      const legend = node('div', 'mp-execution-legend');
      for (const phase of ['prepare', 'read', 'act'] as const) {
        const count = steps.filter(step => step.phase === phase).length;
        if (!count) continue;
        const item = node('span', '', `${labels[phase]} ${count}`); item.dataset.phase = phase; legend.append(item);
      }
      view.overview.replaceChildren(heading, title, metrics, legend);
      if (!steps.length) view.overview.append(node('p', 'mp-execution-note', '目标、读到的内容和执行结果会留在这里，随时可以回看。'));
      const visible = steps.slice(-view.visible);
      view.more.hidden = steps.length <= view.visible;
      view.more.textContent = `显示更早的 ${Math.min(24, steps.length - view.visible)} 步`;
      const currentView = view;
      view.more.onclick = () => { currentView.visible += 24; ExecutionView.render(host, input); };
      const groups: Array<{ key: string; phase: Phase; steps: Step[] }> = [];
      for (const step of visible) {
        const last = groups.at(-1);
        if (last?.phase === step.phase) last.steps.push(step);
        else groups.push({ key: step.key, phase: step.phase, steps: [step] });
      }
      const liveGroups = new Set<string>(), liveSteps = new Set<string>();
      groups.forEach((group, index) => {
        liveGroups.add(group.key);
        let section = view.groups.get(group.key);
        if (!section) {
          const root = node('details', 'mp-execution-phase'); root.dataset.phase = group.phase;
          root.open = group.phase !== 'prepare' || group.steps.some(step => step.state !== 'ok');
          const summary = node('summary', 'mp-execution-phase-heading');
          const title = node('span', '', labels[group.phase]), count = node('span', 'mp-execution-phase-count');
          summary.append(title, count);
          const body = node('div', 'mp-execution-phase-body'); root.append(summary, body);
          section = { node: root, title, count, body }; view.groups.set(group.key, section);
        }
        section.count.textContent = `${group.steps.length} 步`;
        if (view.phases.children[index] !== section.node) view.phases.insertBefore(section.node, view.phases.children[index] || null);
        group.steps.forEach((step, stepIndex) => {
          liveSteps.add(step.key);
          let entry = view.steps.get(step.key);
          if (!entry) {
            const root = node('details', 'mp-execution-step'); root.dataset.callId = step.key;
            const summary = node('summary', 'mp-execution-step-summary');
            const content = node('div', 'mp-execution-detail'); root.append(summary, content);
            entry = { node: root, summary, detail: content };
            const currentEntry = entry;
            root.addEventListener('toggle', () => detail(currentEntry));
            view.steps.set(step.key, entry);
          }
          updateStep(step, entry);
          if (section!.body.children[stepIndex] !== entry.node) section!.body.insertBefore(entry.node, section!.body.children[stepIndex] || null);
        });
      });
      for (const [key, group] of view.groups) if (!liveGroups.has(key)) { group.node.remove(); view.groups.delete(key); }
      for (const [key, step] of view.steps) if (!liveSteps.has(key)) { step.node.remove(); view.steps.delete(key); }
    },
  };
})();
