'use strict';

type PlanListStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
interface PlanListStep {
  content: string;
  status: PlanListStatus;
  anchorToolUseId?: string;
}
interface PlanListModel { steps: PlanListStep[] }
interface PlanListOptions {
  sessionKey: string;
  onJump?: (toolUseId: string) => void;
}

/* Code's session rail is a projection of durable tool history. Keep MP's
   blocked/cancelled states: neither one proves the step was completed. */
const planListApi = (() => {
  function object(value: unknown): Record<string, unknown> | null {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return null; }
    }
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  }

  function snapshot(value: unknown, anchor?: string): PlanListModel | null {
    if (!Array.isArray(value)) return null;
    const steps: PlanListStep[] = [];
    for (const item of value) {
      const step = object(item);
      if (!step || typeof step.content !== 'string' || !step.content.trim()) continue;
      const status: PlanListStatus = step.status === 'in_progress' || step.status === 'completed'
        || step.status === 'blocked' || step.status === 'cancelled' ? step.status : 'pending';
      steps.push({ content: step.content, status, ...(anchor ? { anchorToolUseId: anchor } : {}) });
    }
    return { steps };
  }

  function project(turns: unknown): PlanListModel | null {
    if (!Array.isArray(turns)) return null;
    let plan: PlanListModel | null = null;
    for (const turnValue of turns) {
      const turn = object(turnValue);
      if (!turn) continue;
      const returnedPlan = object(turn.plan);
      const returnedSnapshot = snapshot(returnedPlan?.steps ?? turn.plan);
      if (returnedSnapshot) plan = returnedSnapshot;
      const live = object(turn.liveProgress);
      const trajectory = [
        ...(Array.isArray(turn.trajectory) ? turn.trajectory : []),
        ...(Array.isArray(live?.trajectory) ? live.trajectory : []),
      ];
      for (const record of trajectory) {
        const tool = object(record);
        if (!tool || tool.kind !== 'tool' || !['Todo', 'todo_write', 'TodoWrite'].includes(String(tool.name))) continue;
        if (tool.isError === true || tool.state === 'error' || tool.state === 'failed') continue;
        const anchor = typeof tool.callId === 'string' ? tool.callId : undefined;
        const args = object(tool.text ?? tool.arguments ?? tool.input);
        const result = object(tool.result);
        const next = snapshot(result?.plan, anchor) ?? snapshot(args?.todos, anchor);
        if (next) plan = next;
      }
    }
    return plan;
  }

  const expandedSessions = new Map<string, boolean>();
  const rendered = new WeakMap<HTMLElement, PlanListOptions & { steps: PlanListStep[]; expanded: boolean }>();

  function render(host: HTMLElement, plan: PlanListModel | null, options: PlanListOptions): void {
    const steps = plan?.steps ?? [];
    const expanded = expandedSessions.get(options.sessionKey) === true;
    const previous = rendered.get(host);
    if (previous && previous.sessionKey === options.sessionKey && previous.expanded === expanded
      && Boolean(previous.onJump) === Boolean(options.onJump) && previous.steps.length === steps.length
      && previous.steps.every((step, index) => step.content === steps[index].content
        && step.status === steps[index].status && step.anchorToolUseId === steps[index].anchorToolUseId)) {
      previous.onJump = options.onJump;
      return;
    }
    rendered.set(host, { ...options, expanded, steps: steps.map(step => ({ ...step })) });
    host.hidden = steps.length === 0;
    host.replaceChildren();
    if (host.hidden) return;
    host.classList.add('mp-plan-list');
    const doc = host.ownerDocument;
    const heading = doc.createElement('h3');
    heading.className = 'mp-plan-heading';
    heading.textContent = 'Plan';
    const list = doc.createElement('ol');
    list.className = 'mp-plan-steps';
    list.setAttribute('aria-label', 'Task plan');

    let current = steps.findIndex(step => step.status === 'in_progress');
    if (current < 0 && steps.some(step => step.status === 'completed')) {
      current = steps.findIndex(step => step.status === 'pending');
    }
    let focus = current;
    if (focus < 0) {
      for (let index = 0; index < steps.length; index++) {
        if (steps[index].status === 'completed') focus = index;
      }
    }
    const start = expanded ? 0 : Math.min(Math.max(0, focus - 2), Math.max(0, steps.length - 6));
    const end = expanded ? steps.length : Math.min(steps.length, start + 6);

    for (let index = start; index < end; index++) {
      const step = steps[index];
      const item = doc.createElement('li');
      item.className = 'mp-plan-step' + (index === current ? ' is-current' : '')
        + (step.status === 'completed' ? ' is-done' : '');
      item.setAttribute('data-state', step.status);
      item.setAttribute('aria-label', `${step.content} — ${step.status.replace('_', ' ')}`);
      if (index === current) item.setAttribute('aria-current', 'step');
      const canJump = Boolean(step.anchorToolUseId && options.onJump);
      const row = doc.createElement(canJump ? 'button' : 'div');
      row.className = 'mp-plan-row';
      if (canJump) {
        (row as HTMLButtonElement).type = 'button';
        row.addEventListener('click', () => rendered.get(host)?.onJump?.(step.anchorToolUseId!));
      }
      const track = doc.createElement('span');
      track.className = 'mp-plan-track';
      track.setAttribute('aria-hidden', 'true');
      const upper = doc.createElement('span');
      upper.className = 'mp-plan-line' + (index <= focus ? ' is-walked' : '');
      const dot = doc.createElement('span');
      dot.className = 'mp-plan-dot';
      dot.hidden = index !== current;
      const lower = doc.createElement('span');
      lower.className = 'mp-plan-line' + (index < focus ? ' is-walked' : '');
      track.append(upper, dot, lower);
      const label = doc.createElement('span');
      label.className = 'mp-plan-label';
      label.textContent = `${step.status === 'blocked' ? 'Blocked: ' : step.status === 'cancelled' ? 'Cancelled: ' : ''}${step.content}`;
      row.append(track, label);
      item.append(row);
      list.append(item);
    }
    host.append(heading, list);
    if (steps.length > 6) {
      const toggle = doc.createElement('button');
      toggle.type = 'button';
      toggle.className = 'mp-plan-toggle';
      toggle.textContent = expanded ? 'Show fewer steps' : `Show all ${steps.length} steps`;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.addEventListener('click', () => {
        expandedSessions.set(options.sessionKey, !expanded);
        render(host, plan, options);
        host.querySelector<HTMLButtonElement>('.mp-plan-toggle')?.focus();
      });
      host.append(toggle);
    }
  }

  return { project, render };
})();

declare global { var PlanList: typeof planListApi; }
globalThis.PlanList = planListApi;
