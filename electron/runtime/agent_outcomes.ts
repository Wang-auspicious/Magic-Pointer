import { canonicalJson, type SessionEvent } from './session';
import type { Effect, ToolCall, ToolResult } from './tools';

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const parse = (value: unknown): Data => { if (typeof value !== 'string') return object(value); try { return object(JSON.parse(value)); } catch { return {}; } };
const externalEffects = new Set(['external_send', 'destructive', 'purchase']);

function applicationEffectVerified(verification: Data, effect: string): boolean {
  if (verification.matched !== true || !String(verification.method ?? '').trim()) return false;
  const scope = String(verification.scope ?? '');
  if (scope === 'application_effect') return true;
  if (effect === 'external_send') return ['external_delivery', 'recipient_delivery', 'application_delivery'].includes(scope);
  if (effect === 'destructive') return ['application_state', 'target_state'].includes(scope);
  if (effect === 'purchase') return ['transaction_settlement', 'purchase_receipt'].includes(scope);
  return false;
}

export interface TargetOutcome {
  operationId: string; callId: string; tool: string; target: string;
  status: 'verified' | 'unverified' | 'unknown' | 'failed';
  method: string; scope: string; usedBackend: string | null;
  verificationCallId?: string;
  actionTarget?: Data;
  actionIndex?: number;
  effect?: string;
}

function targetKeys(args: Data, value: Data, fallback: string): string[] {
  const files = [value.path ?? args.path, ...rows(value.changed), ...rows(value.restored)].filter(item => typeof item === 'string' && item);
  if (files.length) return [...new Set(files.map(file => `file:${String(file).replaceAll('\\', '/')}`))];
  if (args.sourceId || args.source_id) return [`source:${args.sourceId || args.source_id}:${canonicalJson(args.locator ?? {})}`];
  if (args.artifactId || value.artifactId) return [`artifact:${args.artifactId || value.artifactId}`];
  if (args.state_id || args.snapshot_id) return [`desktop:${args.state_id || args.snapshot_id}:${args.ref ?? args.index ?? 'surface'}`];
  return [`operation:${fallback}`];
}

export function operationOutcomes(operation: Data, result: ToolResult, validatorRan: boolean): TargetOutcome[] {
  if (operation.effect === 'read' || operation.dispatched !== true) return [];
  const args = object(operation.arguments), value = parse(result.value);
  if (value.waitingForDesktop === true && value.notExecuted === true) return [];
  if (Array.isArray(value.actionResults)) return value.actionResults.flatMap(raw => {
    const action = object(raw), index = Number(action.index), childArgs = object(rows(args.actions)[index]);
    const effect = String(action.effect || operation.effect), external = ['external_send', 'purchase', 'destructive'].includes(effect);
    const verification = object(action.verification), postcondition = object(action.postcondition);
    const child = operationOutcomes({ ...operation, name: action.name, effect, arguments: { ...childArgs, submit: external || action.submit === true } },
      { ...result, value: { actionTarget: action.actionTarget, verification: !external && postcondition.matched === true ? postcondition : verification } }, false);
    return child.map(outcome => ({ ...outcome, target: `${outcome.target}:action-${index}`, actionIndex: index }));
  });
  const patches = rows(value.patches);
  const parts = patches.length ? patches.map(object) : [value];
  return parts.flatMap(part => {
    const verification = object(part.verification);
    const effect = String(operation.effect), external = externalEffects.has(effect);
    const matched = !result.is_error && result.outcome_known && (external
      ? applicationEffectVerified(verification, effect)
      : !['Click', 'click'].includes(String(operation.name)) && args.submit !== true && (verification.matched === true || validatorRan));
    return targetKeys(args, part, String(operation.operationId)).map(target => ({
      operationId: String(operation.operationId), callId: String(operation.callId), tool: String(operation.name), target,
      status: !result.outcome_known ? 'unknown' : result.is_error ? 'failed' : matched ? 'verified' : 'unverified',
      method: matched ? String(verification.method || 'tool_readback') : 'not_verified',
      scope: String(verification.scope || (args.submit ? 'input_only_not_delivery' : 'tool_postcondition')),
      usedBackend: result.used_backend,
      ...(value.actionTarget ? { actionTarget: object(value.actionTarget) } : {}), effect: String(operation.effect),
    }));
  });
}

export function taskOutcomes(events: readonly SessionEvent[]): { targets: TargetOutcome[]; wrote: boolean; verified: boolean; unfinished: string[]; artifactIds: string[] } {
  const previousSuccess = [...events].reverse().find(event => event.type === 'receipt/issued' && event.data.status === 'succeeded')?.seq ?? -1;
  const scope = events.filter(event => event.seq > previousSuccess);
  const current = new Map<string, TargetOutcome>();
  const prepared = new Map<string, Data>();
  const resolved = new Set(scope.filter(event => event.type === 'operation/recovery_resolved').map(event => String(event.data.operationId)));
  for (const event of scope) {
    if (event.type === 'operation/prepared') prepared.set(String(event.data.operationId), event.data);
    if (event.type !== 'operation/settled') continue;
    const operation = prepared.get(String(event.data.operationId));
    const message = object(event.data.message);
    const legacy = operation && event.data.targetOutcomes === undefined && event.data.outcome !== 'not_started' ? operationOutcomes(operation, {
      tool_call_id: String(operation.callId), tool_name: String(operation.name), arguments: object(operation.arguments),
      value: message.content, is_error: event.data.outcome === 'failed', outcome_known: event.data.outcome !== 'unknown',
      failure_type: null, latency_ms: Number(event.data.latencyMs ?? 0), used_backend: event.data.usedBackend ? String(event.data.usedBackend) : null,
    }, false) : [];
    for (const row of event.data.targetOutcomes === undefined ? legacy : rows(event.data.targetOutcomes)) {
      const outcome = row as TargetOutcome;
      const intent = canonicalJson([outcome.target, outcome.tool, operation?.arguments ?? outcome.operationId]);
      current.set(intent, outcome);
    }
    if (operation?.effect === 'read' && event.data.outcome === 'succeeded') {
      const value = parse(message.content), verification = object(value.verification);
      const method = String(verification.method ?? '').trim();
      if (verification.matched !== true || !method) continue;
      const covered = targetKeys(object(operation.arguments), value, 'no-target');
      for (const [intent, old] of current) {
        if (old.status !== 'unverified' && !(old.status === 'unknown' && resolved.has(old.operationId))) continue;
        if (externalEffects.has(old.effect ?? '') && !applicationEffectVerified(verification, old.effect ?? '')) continue;
        const desktop = old.actionTarget;
        const boundDesktop = verification.forCallId === old.callId && verification.forActionIndex === old.actionIndex && desktop &&
          verification.windowHwnd === desktop.windowHwnd && verification.pid === desktop.pid && verification.stateId === desktop.stateId &&
          !externalEffects.has(old.effect ?? '');
        const hasOperationId = Object.hasOwn(verification, 'operationId');
        const boundOther = !desktop && (verification.operationId === old.operationId || !hasOperationId && covered.includes(old.target) && [...current.values()].filter(item => item.target === old.target).length === 1);
        if (!boundDesktop && !boundOther) continue;
        current.set(intent, { ...old, status: 'verified', verificationCallId: String(operation.callId),
          method: String(verification.method || 'tool_readback'), scope: String(verification.scope || 'tool_postcondition') });
      }
    }
  }
  const targets = [...current.values()];
  const plan = [...scope].reverse().find(event => event.type === 'plan/updated')?.data.plan;
  const unfinished = rows(plan).map(object).filter(row => row.status !== 'completed').map(row => String(row.content));
  const artifactIds = [...new Set(scope.filter(event => ['artifact/generated', 'artifact/patched'].includes(event.type)).map(event => String(event.data.artifactId)))];
  return { targets, wrote: targets.length > 0, verified: targets.length > 0 && targets.every(row => row.status === 'verified'), unfinished, artifactIds };
}

const volatile = new Set(['observedAt', 'observedAtMs', 'capturedAtMs', 'latencyMs', 'elapsedMs', 'timingMs', 'state_id', 'snapshot_id', 'timestamp']);
function facts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(facts);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !volatile.has(key)).map(([key, child]) => [key, facts(child)]));
  if (typeof value === 'string') { try { return facts(JSON.parse(value)); } catch {} }
  return value;
}

export class ProgressTracker {
  private evidence = new Map<string, number>();
  private failures = new Map<string, number>();
  private actions = new Map<string, number>();
  observe(call: ToolCall, result: ToolResult, effect: Effect): { progress: boolean; warning: string; stalled: boolean } {
    const value = parse(result.value);
    let count: number, warning: string;
    if (result.is_error) {
      if (['steer_pending', 'permission_denied'].includes(String(result.failure_type))) return { progress: false, warning: '', stalled: false };
      const key = `${call.name}:${result.failure_type || 'tool_error'}`;
      count = (this.failures.get(key) ?? 0) + 1; this.failures.set(key, count);
      warning = 'This capability keeps failing despite changed arguments. Use a different supported path or report the specific blocker.';
    } else {
      this.failures.clear();
      const key = canonicalJson(facts(result.value));
      const store = effect === 'read' ? this.evidence : this.actions;
      const identity = effect === 'read' ? key : canonicalJson([call.name, call.arguments, key]);
      count = (store.get(identity) ?? 0) + 1; store.set(identity, count);
      if (effect !== 'read' && count === 1) this.evidence.clear();
      if (effect === 'read' && count === 1) this.actions.clear();
      const repeatableInput = ['press_key', 'scroll', 'drag', 'type_text', 'click', 'Click', 'act_ui'].includes(call.name);
      if (repeatableInput && count > 1) return { progress: false, warning: count === 2 ? 'Repeated input is not result verification; observe the changed target when needed.' : '', stalled: false };
      const waiting = ['Wait', 'wait', 'wait_for'].includes(call.name) && Number(value.elapsedMs ?? value.elapsed_ms ?? Number(value.elapsed_s) * 1000) > 0
        && (call.name === 'wait_for' ? value.matched === true : !!value.condition || !!object(call.arguments).expect || !!object(call.arguments).condition);
      if (waiting) return { progress: true, warning: '', stalled: false };
      warning = effect === 'read' ? 'The same evidence has already been read, including through other tools. Use it or change approach.' : 'The same successful action was repeated. Check the result before performing it again.';
    }
    return { progress: !result.is_error && count === 1, warning: count >= 2 ? warning : '', stalled: count >= 4 };
  }
}
