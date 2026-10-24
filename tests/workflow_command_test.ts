import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {
  WorkflowEngine,
  expandWorkflowCommand,
  requestWorkflowStop,
} from '../electron/runtime/workflow_engine';
import {directoryPayload} from '../electron/runtime/agent_services';

type Data = Record<string, any>;

const FIXTURE_SOURCE = (log: string, script: string) => `module.exports={name:'wf-cmd',async apply(ctx){
  const fs=require('node:fs');
  const LOG=${JSON.stringify(log)},SCRIPT=${JSON.stringify(script)};
  await ctx.provideUp('llm',async request=>{
    const text=(request.messages||[]).map(m=>String(m.content==null?'':m.content)).join('\\n');
    const stepId=(text.match(/\\[workflow-step ([^\\]\\s]+)\\]/)||[])[1]||'unknown';
    fs.appendFileSync(LOG,stepId+'\\n');
    const plan=JSON.parse(fs.readFileSync(SCRIPT,'utf8'));
    const queue=Array.isArray(plan[stepId])?plan[stepId].slice():['ok'];
    const outcome=queue.shift()||'ok';
    if(queue.length){plan[stepId]=queue;}else{delete plan[stepId];}
    fs.writeFileSync(SCRIPT,JSON.stringify(plan));
    if(String(outcome).indexOf('gate:')===0){
      const gate=String(outcome).slice(5);
      await new Promise((resolve,reject)=>{
        const timer=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(timer);resolve();}},20);
        const stop=()=>{clearInterval(timer);const error=new Error('aborted');error.name='AbortError';reject(error);};
        if(request.signal){if(request.signal.aborted){stop();return;}request.signal.addEventListener('abort',stop,{once:true});}
      });
    }
    return {text:stepId+' ok',tool_calls:[],usedBackend:'fixture.cmd'};
  });
}};`;

interface CommandHarness {
  root: string;
  parent: EventSession;
  engine: WorkflowEngine;
}

async function createHarness(): Promise<CommandHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-workflow-cmd-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, {recursive: true});
  const parent = await EventSession.open(root, 'wf-cmd-parent');
  const plugin = path.join(root, 'data', 'plugins', 'wf-cmd');
  await mkdir(plugin, {recursive: true});
  await writeFile(
    path.join(plugin, 'plugin.json'),
    JSON.stringify({name: 'wf-cmd', main: 'entry.cjs'}),
  );
  await writeFile(path.join(plugin, 'entry.cjs'), FIXTURE_SOURCE(path.join(root, 'exec.log'), path.join(root, 'script.json')));
  await writeFile(path.join(root, 'script.json'), '{}');
  await writeFile(
    path.join(root, 'data', 'harness.patch.json'),
    JSON.stringify({
      schemaVersion: 1,
      patch: {'llm-provider': {disabled: true}},
    }),
  );
  const engine = new WorkflowEngine({
    root,
    userDataDir: root,
    workspace,
    session: parent,
    config: {model: 'fixture'},
    permissionMode: 'safe',
  });
  return {root, parent, engine};
}

test('expandWorkflowCommand rewrites a /workflow task into an orchestration instruction', () => {
  const expanded = expandWorkflowCommand('/workflow 帮我调研三个方案');
  assert.ok(expanded, 'expansion result expected');
  assert.match(expanded, /Workflow\.run/);
  assert.match(expanded, /帮我调研三个方案/);
  assert.equal(expandWorkflowCommand('/workflow'), null);
  assert.equal(expandWorkflowCommand('普通任务'), null);
  assert.equal(expandWorkflowCommand('/workflowx 其他'), null);
});

test('the slash directory advertises the workflow command', async () => {
  const payload = await directoryPayload(undefined, undefined);
  const entry = payload
    .commands!.slice()
    .find((command: Data) => command.name === 'workflow');
  assert.ok(entry, 'workflow command entry expected');
  assert.equal(typeof entry.description, 'string');
});

test('the engine streams state snapshots and returns a workflow_run presentation', async () => {
  const harness = await createHarness();
  const snapshots: Array<Record<string, unknown>> = [];
  const result = (await harness.engine.run(
    {
      title: 'Cmd run',
      steps: [
        {id: 'a', title: 'First', instructions: 'x', depends_on: []},
        {id: 'b', title: 'Second', instructions: 'y', depends_on: ['a']},
      ],
    },
    {
      runId: 'cmd-run',
      onStep: snapshot => snapshots.push(snapshot),
    },
  )) as Data;
  assert.equal(result.ok, true);
  assert.ok(snapshots.length >= 3, `expected >=3 snapshots, got ${snapshots.length}`);
  const last = snapshots[snapshots.length - 1]!;
  assert.equal((last as Data).status, 'succeeded');
  const steps = (last as Data).steps as Data[];
  assert.equal(steps.length, 2);
  assert.equal(steps[1]!.id, 'b');
  assert.equal(steps[1]!.status, 'succeeded');
  const presentation = result.presentation as Data;
  assert.equal(presentation.kind, 'workflow_run');
  assert.equal(presentation.title, 'Cmd run');
  assert.equal(presentation.status, 'succeeded');
  const presented = presentation.steps as Data[];
  assert.equal(presented.length, 2);
  assert.deepEqual(presented[1]!.depends_on, ['a']);
  assert.equal(typeof presentation.tokens, 'number');
});

test('a stop marker file aborts a running workflow', async () => {
  const harness = await createHarness();
  const gate = path.join(harness.root, 'gate.txt');
  const script = path.join(harness.root, 'script.json');
  await writeFile(
    script,
    JSON.stringify({a: [`gate:${gate}`]}),
  );
  const controller = new AbortController();
  const running = harness.engine.run(
    {
      title: 'Stop run',
      steps: [
        {id: 'a', title: 'First', instructions: 'x', depends_on: []},
      ],
    },
    {runId: 'stop-run', signal: controller.signal},
  );
  await new Promise(resolve => setTimeout(resolve, 600));
  await requestWorkflowStop(harness.root, 'stop-run');
  const outcome = await Promise.race([
    running.then(
      () => 'settled',
      (error: Error) => `rejected:${error.name}`,
    ),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 8000)),
  ]);
  assert.notEqual(outcome, 'timeout');
  const journal = JSON.parse(
    await readFile(
      path.join(harness.root, 'workflow-runs', 'stop-run', 'run.json'),
      'utf8',
    ),
  ) as Data;
  assert.equal(journal.status, 'aborted');
});

test('step instructions tell subagents to report facts, not address the user', async () => {
  const harness = await createHarness();
  await harness.engine.run({
    title: 'Handoff run',
    steps: [{id: 'a', title: 'First', instructions: 'x', depends_on: []}],
  });
  const events = harness.parent.events.filter(
    event => event.type === 'workflow/step_started',
  );
  assert.ok(events.length >= 1);
  const child = await EventSession.open(
    harness.root,
    String((events[0]!.data as Data).childSessionId),
    false,
  );
  const configured = child.events.find(
    event => event.type === 'subagent/configured',
  );
  const task = String((configured!.data as Data).task);
  assert.match(task, /\[workflow-step a\]/);
  assert.match(task, /report/i);
});
