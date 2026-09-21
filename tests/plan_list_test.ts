import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = fs.readFileSync('electron/renderer/plan_list.ts', 'utf8');
class Element {
  children: Element[] = [];
  attributes: Record<string, string> = {};
  handlers: Record<string, () => void> = {};
  hidden = false;
  className = '';
  textContent = '';
  type = '';
  ownerDocument = document;
  classList = { add: (name: string) => { this.className += ` ${name}`; } };
  constructor(public tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(event: string, handler: () => void) { this.handlers[event] = handler; }
  focus() {}
  querySelector(selector: string): Element | null {
    return this.all('button').find(element => `.${element.className}` === selector) ?? null;
  }
  all(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.all(tag)]); }
}
const document = { createElement: (tag: string) => new Element(tag) };
const sandbox: any = { document };
vm.runInNewContext(transformSync(source, { loader: 'ts' }).code, sandbox);
const planList = sandbox.PlanList;
const value = (input: unknown) => JSON.parse(JSON.stringify(input));

const saved = [{ trajectory: [{ kind: 'tool', name: 'Todo', callId: 'todo-1', state: 'done',
  text: JSON.stringify({ todos: [{ content: 'Read evidence', status: 'completed' }] }),
  result: JSON.stringify({ plan: [{ content: 'Read evidence', status: 'completed' }, { content: 'Verify result', status: 'blocked' }] }),
}] }];
assert.deepEqual(value(planList.project(saved)), { steps: [
  { content: 'Read evidence', status: 'completed', anchorToolUseId: 'todo-1' },
  { content: 'Verify result', status: 'blocked', anchorToolUseId: 'todo-1' },
] }, 'reopening a saved task restores the latest successful plan with real states and a tool anchor');
assert.equal(planList.project([{ answer: 'No plan was made.' }]), null);
const live = [...saved, { liveProgress: { trajectory: [{ kind: 'tool', name: 'todo_write', callId: 'todo-2', state: 'running',
  text: JSON.stringify({ todos: [{ content: 'Verify result', status: 'in_progress' }] }),
}] } }];
assert.deepEqual(value(planList.project(live)), { steps: [
  { content: 'Verify result', status: 'in_progress', anchorToolUseId: 'todo-2' },
] }, 'the live turn updates the durable task plan before the final answer');
assert.deepEqual(value(planList.project([...saved, { plan: { steps: [{ content: 'Cancelled by user', status: 'cancelled' }] } }])), {
  steps: [{ content: 'Cancelled by user', status: 'cancelled' }],
}, 'stored turn.plan snapshots restore without inventing a tool anchor');
assert.deepEqual(value(planList.project([...saved, { plan: { steps: [{ content: 'old snapshot', status: 'pending' }] },
  trajectory: [{ kind: 'tool', name: 'TodoWrite', callId: 'clear', state: 'done', text: '{"todos":[]}' }],
}])), { steps: [] }, 'an explicit empty latest plan clears old work instead of falling back to history');
assert.deepEqual(value(planList.project([...saved, { trajectory: [{ kind: 'tool', name: 'Todo', state: 'error',
  text: '{"todos":[]}', result: '{"plan":[]}', isError: true }],
}])), value(planList.project(saved)), 'a failed plan update does not erase the last accepted plan');
console.log('PlanList projection passed');

const rail = new Element('section');
const jumps: string[] = [];
const options = { sessionKey: 'task-one', onJump: (id: string) => jumps.push(id) };
const longPlan = { steps: Array.from({ length: 9 }, (_, index) => ({
  content: `Step ${index + 1}`, status: index < 5 ? 'completed' : index === 5 ? 'in_progress' : 'pending',
  anchorToolUseId: `call-${index + 1}`,
})) };
planList.render(rail, longPlan, options);
assert.equal(rail.hidden, false);
assert.deepEqual(rail.all('li').map(step => step.attributes['aria-label']), [
  'Step 4 — completed', 'Step 5 — completed', 'Step 6 — in progress',
  'Step 7 — pending', 'Step 8 — pending', 'Step 9 — pending',
], 'a long plan shows six steps around the current step');
const toggle = () => rail.all('button').find(button => button.className === 'mp-plan-toggle')!;
assert.equal(toggle().textContent, 'Show all 9 steps');
rail.all('button')[2].handlers.click();
assert.deepEqual(jumps, ['call-6'], 'a plan step jumps only to its real originating tool');
toggle().handlers.click();
assert.equal(rail.all('li').length, 9);
const expandedToggle = toggle();
planList.render(rail, { steps: longPlan.steps.map(step => ({ ...step })) }, options);
assert.equal(rail.all('li').length, 9, 'streaming updates keep the current task expansion choice');
assert.equal(toggle(), expandedToggle, 'unrelated streaming deltas preserve the focused expansion button');
toggle().handlers.click();
assert.equal(rail.all('li').length, 6);
planList.render(rail, { steps: longPlan.steps.map(step => ({ ...step, status: 'completed' })) }, options);
assert.equal(rail.all('li')[0].attributes['aria-label'], 'Step 4 — completed', 'a finished plan keeps its final six steps visible');
assert.equal(rail.all('li').filter(item => item.attributes['aria-current']).length, 0, 'completed work does not pretend to still run');
planList.render(rail, longPlan, { sessionKey: 'task-two' });
assert.equal(rail.all('li').length, 6, 'a second task starts with its own six-step window');
assert.equal(rail.all('button').length, 1, 'steps without a jump handler are static rows');
planList.render(rail, { steps: [] }, options);
assert.equal(rail.hidden, true);
assert.equal(rail.children.length, 0, 'clearing the plan removes old rows');
console.log('PlanList rail interaction passed');
