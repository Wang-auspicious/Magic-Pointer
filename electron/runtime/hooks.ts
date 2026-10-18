import {record} from './context';

type Data = Record<string, unknown>;
export type ToolHook = (payload: Data) => Data | void | Promise<Data | void>;

export class HookManager {
  readonly pre: ToolHook[] = [];
  readonly post: ToolHook[] = [];
  readonly stop: ToolHook[] = [];

  add(phase: 'pre' | 'post' | 'stop', hook: ToolHook): () => void {
    this[phase].push(hook);
    return () => {
      const index = this[phase].indexOf(hook);
      if (index >= 0) {
        this[phase].splice(index, 1);
      }
    };
  }

  async run(phase: 'pre' | 'post' | 'stop', payload: Data): Promise<Data> {
    let current = structuredClone(payload);
    let reason = '';
    let extra = '';
    for (const hook of this[phase]) {
      let decision: Data;
      try {
        decision = record(await hook(structuredClone(current)));
      } catch {
        continue;
      }
      if (decision.input && phase === 'pre') {
        current = {...current, input: structuredClone(decision.input)};
      }
      if (decision.extraContext) {
        extra += '\n' + String(decision.extraContext ?? '');
      }
      if (decision.decision === 'block') {
        reason = String(decision.reason || 'blocked by hook');
        if (phase === 'pre') {
          break;
        }
      }
      if (decision.decision === 'approve' && phase === 'pre') {
        break;
      }
    }
    return {...current, allowed: !reason, reason, extraContext: extra.trim()};
  }
}
