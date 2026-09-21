import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';

const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const ast = ts.createSourceFile('studio.ts', studio, ts.ScriptTarget.Latest, true);
const render = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'renderPendingBody');
assert.ok(render);
let planPaints = 0;
const previous = { steps: [{ content: 'Earlier accepted plan', status: 'pending', anchorToolUseId: 'old' }] };
const context: any = {
  pendingConversation: { transcript: { trajectory: [] }, records: new Map(), renderer: { update() {} } },
  composerPlan: previous, pendingClockWrite: null,
  renderPlanCard: () => { planPaints++; },
};
vm.runInNewContext(transformSync(fs.readFileSync('electron/renderer/plan_list.ts', 'utf8'), { loader: 'ts' }).code, context);
vm.runInNewContext(transformSync(render.getText(ast), { loader: 'ts' }).code, context);

context.renderPendingBody();
assert.equal(context.composerPlan, previous, 'a new turn without a Todo update preserves the earlier task plan');
assert.equal(planPaints, 0);
context.composerPlan = { steps: [{ content: 'Verify result', status: 'in_progress' }] };
context.pendingConversation.transcript.trajectory = [{ kind: 'tool', name: 'Todo', callId: 'live-todo', state: 'done',
  text: '{"todos":[{"content":"Verify result","status":"in_progress"}]}',
  result: '{"plan":[{"content":"Verify result","status":"in_progress"}]}',
}];
context.renderPendingBody();
assert.equal(context.composerPlan.steps[0].anchorToolUseId, 'live-todo',
  'the tool result upgrades the unanchored phase-plan snapshot into a clickable live plan');
assert.equal(planPaints, 1);
context.pendingConversation.transcript.trajectory.push({ kind: 'tool', name: 'Todo', callId: 'clear', state: 'done', text: '{"todos":[]}' });
context.renderPendingBody();
assert.equal(context.composerPlan.steps.length, 0, 'an explicit live clear removes the visible plan');
assert.equal(planPaints, 2);
console.log('Studio live plan projection passed');
