import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventSession} from '../electron/runtime/session';
import {registerSubagentTools, stopAgent} from '../electron/runtime/agent_background';
import {ToolRegistry} from '../electron/runtime/tools';
import {
  WorkflowEngine,
  WORKFLOW_RUN_TOOL,
  registerWorkflowRunTool,
} from '../electron/runtime/workflow_engine';

type Data = Record<string, any>;

function fixtureSource(
  log: string,
  script: string,
  inflight: string,
  peak: string,
): string {
  return `module.exports={name:'wf-fixture',async apply(ctx){
  const fs=require('node:fs');
  const LOG=${JSON.stringify(log)},SCRIPT=${JSON.stringify(script)},INFLIGHT=${JSON.stringify(inflight)},PEAK=${JSON.stringify(peak)};
  const bump=delta=>{const n=Number(fs.readFileSync(INFLIGHT,'utf8'))+delta;fs.writeFileSync(INFLIGHT,String(n));const p=Number(fs.readFileSync(PEAK,'utf8'));if(n>p){fs.writeFileSync(PEAK,String(n));}return n;};
  await ctx.provideUp('llm',async request=>{
    const text=(request.messages||[]).map(m=>String(m.content==null?'':m.content)).join('\\n');
    const stepId=(text.match(/\\[workflow-step ([^\\]\\s]+)\\]/)||[])[1]||'unknown';
    bump(1);
    try{
      fs.appendFileSync(LOG,stepId+'\\n');
      const plan=JSON.parse(fs.readFileSync(SCRIPT,'utf8'));
      const queue=Array.isArray(plan[stepId])?plan[stepId].slice():['ok'];
      const outcome=queue.shift()||'ok';
      if(queue.length){plan[stepId]=queue;}else{delete plan[stepId];}
      fs.writeFileSync(SCRIPT,JSON.stringify(plan));
      if(outcome==='ok'){return{text:stepId+' ok',tool_calls:[],usedBackend:'fixture.workflow'};}
      if(outcome==='fail'){throw new Error('fixture step failure '+stepId);}
      if(String(outcome).indexOf('gate:')===0){
        const gate=String(outcome).slice(5);
        await new Promise((resolve,reject)=>{
          const timer=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(timer);resolve();}},20);
          const stop=()=>{clearInterval(timer);const error=new Error('aborted');error.name='AbortError';reject(error);};
          if(request.signal){if(request.signal.aborted){stop();return;}request.signal.addEventListener('abort',stop,{once:true});}
        });
        return{text:stepId+' ok',tool_calls:[],usedBackend:'fixture.workflow'};}
      throw new Error('fixture unknown outcome '+String(outcome));
    }finally{bump(-1);}
  });
}};`;
}

interface Harness {
  root: string;
  parent: EventSession;
  engine: WorkflowEngine;
  gateFile: string;
  peakFile: string;
  readLog(): Promise<string[]>;
  scenario(value: Data): Promise<void>;
  readJournal(runId: string): Promise<Data>;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-workflow-engine-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, {recursive: true});
  const log = path.join(root, 'exec.log');
  const script = path.join(root, 'script.json');
  const inflight = path.join(root, 'inflight');
  const peak = path.join(root, 'peak');
  const parent = await EventSession.open(root, 'wf-parent');
  const plugin = path.join(root, 'data', 'plugins', 'wf-fixture');
  await mkdir(plugin, {recursive: true});
  await writeFile(
    path.join(plugin, 'plugin.json'),
    JSON.stringify({name: 'wf-fixture', main: 'entry.cjs'}),
  );
  await writeFile(
    path.join(plugin, 'entry.cjs'),
    fixtureSource(log, script, inflight, peak),
  );
  await writeFile(
    path.join(root, 'data', 'harness.patch.json'),
    JSON.stringify({
      schemaVersion: 1,
      patch: {'llm-provider': {disabled: true}},
    }),
  );
  await writeFile(script, '{}');
  await writeFile(inflight, '0');
  await writeFile(peak, '0');
  const engine = new WorkflowEngine({
    root,
    userDataDir: root,
    workspace,
    session: parent,
    config: {model: 'fixture'},
    permissionMode: 'safe',
  });
  return {
    root,
    parent,
    engine,
    gateFile: path.join(root, 'gate.txt'),
    peakFile: peak,
    readLog: async () =>
      (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    scenario: (value: Data) => writeFile(script, JSON.stringify(value)),
    readJournal: async (runId: string) =>
      JSON.parse(
        await readFile(
          path.join(root, 'workflow-runs', runId, 'run.json'),
          'utf8',
        ),
      ) as Data,
  };
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 20000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() >= until) {
      throw new Error('waitFor timeout');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const seqOf = (session: EventSession, type: string, stepId: string) =>
  session.events.find(
    event => event.type === type && event.data.stepId === stepId,
  )!.seq;

test('executes steps in dependency order and journals every settle', async () => {
  const harness = await createHarness();
  const plan = {
    title: 'Chain run',
    steps: [
      {id: 'a', title: 'First', instructions: 'Run step a.', depends_on: []},
      {
        id: 'b',
        title: 'Second',
        instructions: 'Run step b.',
        depends_on: ['a'],
      },
      {id: 'c', title: 'Third', instructions: 'Run step c.', depends_on: ['b']},
    ],
  };
  const result = (await harness.engine.run(plan, {
    runId: 'order-run',
  })) as Data;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(
    (await harness.readLog()).filter(id => id === 'a').length >= 1,
    true,
  );
  assert.deepEqual(await harness.readLog(), ['a', 'b', 'c']);
  await harness.parent.refresh();
  assert.ok(
    seqOf(harness.parent, 'workflow/step_settled', 'a') <
      seqOf(harness.parent, 'workflow/step_started', 'b'),
  );
  assert.ok(
    seqOf(harness.parent, 'workflow/step_settled', 'b') <
      seqOf(harness.parent, 'workflow/step_started', 'c'),
  );
  assert.equal(
    harness.parent.events.at(-1)!.type,
    'workflow/run_settled',
  );
  assert.equal(harness.parent.events.at(-1)!.data.status, 'succeeded');
  const journal = await harness.readJournal('order-run');
  assert.equal(journal.status, 'succeeded');
  assert.equal(journal.steps.a.status, 'succeeded');
  assert.equal(journal.steps.a.attempts[0].childStatus, 'completed');
  assert.equal(journal.steps.a.attempts[0].childSessionId, 'wf-order-ru-a-a1');
});

test('rejects cyclic, duplicate and unknown-dependency plans with specifics', async () => {
  const harness = await createHarness();
  await assert.rejects(
    harness.engine.run({
      title: 'Cycle',
      steps: [
        {id: 'a', title: 'A', instructions: 'x', depends_on: ['b']},
        {id: 'b', title: 'B', instructions: 'y', depends_on: ['c']},
        {id: 'c', title: 'C', instructions: 'z', depends_on: ['a']},
      ],
    }),
    /workflow_cycle: a -> b -> c -> a/,
  );
  await assert.rejects(
    harness.engine.run({
      title: 'Missing dep',
      steps: [
        {id: 'a', title: 'A', instructions: 'x', depends_on: []},
        {id: 'b', title: 'B', instructions: 'y', depends_on: ['zzz']},
      ],
    }),
    /workflow_unknown_dependency: step b depends on missing zzz/,
  );
  await assert.rejects(
    harness.engine.run({
      title: 'Duplicate',
      steps: [
        {id: 'a', title: 'A', instructions: 'x', depends_on: []},
        {id: 'a', title: 'A again', instructions: 'y', depends_on: []},
      ],
    }),
    /workflow_duplicate_step: a/,
  );
  await assert.rejects(
    harness.engine.run({
      title: 'Bad concurrency',
      max_concurrency: 5,
      steps: [{id: 'a', title: 'A', instructions: 'x', depends_on: []}],
    }),
    /workflow_bad_concurrency: got 5, allowed 1\.\.4/,
  );
  await assert.rejects(
    harness.engine.run({
      title: 'Bad attempts',
      steps: [
        {
          id: 'a',
          title: 'A',
          instructions: 'x',
          depends_on: [],
          max_attempts: 4,
        },
      ],
    }),
    /workflow_bad_max_attempts: step a got 4, allowed 1\.\.3/,
  );
});

test('retries a failed step within max_attempts and carries the failure summary', async () => {
  const harness = await createHarness();
  await harness.scenario({a: ['fail', 'ok']});
  const result = (await harness.engine.run(
    {
      title: 'Retry run',
      steps: [
        {
          id: 'a',
          title: 'Flaky',
          instructions: 'Run the flaky step.',
          depends_on: [],
          max_attempts: 2,
        },
      ],
    },
    {runId: 'retry-run'},
  )) as Data;
  assert.equal(result.ok, true);
  const journal = await harness.readJournal('retry-run');
  assert.equal(journal.steps.a.attempts.length, 2);
  assert.equal(journal.steps.a.attempts[0].childStatus, 'provider_unavailable');
  assert.equal(journal.steps.a.attempts[1].childStatus, 'completed');
  await harness.parent.refresh();
  const settled = harness.parent.events.filter(
    event => event.type === 'workflow/step_settled',
  );
  assert.deepEqual(
    settled.map(event => [event.data.attempt, event.data.status]),
    [[1, 'failed'], [2, 'succeeded']],
  );
  const secondChild = await EventSession.open(
    harness.root,
    'wf-retry-ru-a-a2',
    false,
  );
  const retryInstruction = secondChild.events
    .filter(event => event.type === 'user/message')
    .map(event => String((event.data.message as Data).content))
    .join('\n');
  assert.match(retryInstruction, /Previous attempt 1 did not succeed/);
  assert.match(retryInstruction, /fixture step failure a/);
});

test('replays succeeded steps from the journal on rerun without re-executing', async () => {
  const harness = await createHarness();
  const plan = {
    title: 'Replay run',
    steps: [
      {id: 'a', title: 'First', instructions: 'Run step a.', depends_on: []},
      {
        id: 'b',
        title: 'Second',
        instructions: 'Run step b.',
        depends_on: ['a'],
      },
    ],
  };
  const first = (await harness.engine.run(plan, {
    runId: 'replay-run',
  })) as Data;
  assert.equal(first.ok, true);
  assert.deepEqual(await harness.readLog(), ['a', 'b']);
  const second = (await harness.engine.run(plan, {
    runId: 'replay-run',
  })) as Data;
  assert.equal(second.ok, true);
  assert.equal(second.resumed, true);
  assert.deepEqual(second.replayedSteps, ['a', 'b']);
  assert.deepEqual(await harness.readLog(), ['a', 'b']);
  const journal = await harness.readJournal('replay-run');
  assert.equal(journal.steps.a.attempts.length, 1);
  assert.equal(journal.steps.b.attempts.length, 1);
  assert.deepEqual(
    second.steps.map((step: Data) => step.replayed === true),
    [true, true],
  );
});

test('rejects plans beyond sixty-four steps', async () => {
  const harness = await createHarness();
  const steps = Array.from({length: 65}, (_, index) => ({
    id: `s${index + 1}`,
    title: `Step ${index + 1}`,
    instructions: 'Do the work.',
    depends_on: [],
  }));
  await assert.rejects(
    harness.engine.run({title: 'Too big', steps}),
    /workflow_too_many_steps: 65 > 64/,
  );
});

test('aborts mid-step and resumes the remaining graph on rerun', async () => {
  const harness = await createHarness();
  await harness.scenario({b: [`gate:${harness.gateFile}`]});
  const plan = {
    title: 'Resume flow',
    steps: [
      {id: 'a', title: 'First', instructions: 'Run step a.', depends_on: []},
      {
        id: 'b',
        title: 'Second',
        instructions: 'Run step b.',
        depends_on: ['a'],
      },
      {id: 'c', title: 'Third', instructions: 'Run step c.', depends_on: ['b']},
    ],
  };
  const controller = new AbortController();
  const running = harness.engine.run(plan, {
    runId: 'resume-run',
    signal: controller.signal,
  });
  await waitFor(async () => {
    await harness.parent.refresh();
    return harness.parent.events.some(
      event =>
        event.type === 'workflow/step_started' &&
        event.data.stepId === 'b',
    );
  });
  controller.abort();
  await assert.rejects(
    running,
    (error: Error) => error.name === 'AbortError',
  );
  const aborted = await harness.readJournal('resume-run');
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.steps.a.status, 'succeeded');
  assert.equal(aborted.steps.b.status, 'pending');
  assert.equal(aborted.steps.b.attempts.length, 1);
  assert.equal(aborted.steps.c.status, 'pending');
  assert.equal(aborted.steps.c.attempts.length, 0);
  // The aborted attempt may or may not have reached the model before the
  // stop, so the gate outcome can still be queued for the resumed attempt;
  // release it either way.
  await writeFile(harness.gateFile, 'release');
  const resumed = (await harness.engine.run(plan, {
    runId: 'resume-run',
  })) as Data;
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.replayedSteps, ['a']);
  const log = await harness.readLog();
  assert.equal(log.filter(id => id === 'a').length, 1);
  assert.ok(
    [1, 2].includes(log.filter(id => id === 'b').length),
    `step b ran ${log.filter(id => id === 'b').length} times`,
  );
  assert.equal(log.filter(id => id === 'c').length, 1);
  const journal = await harness.readJournal('resume-run');
  assert.equal(journal.status, 'succeeded');
  assert.equal(journal.steps.b.attempts.length, 2);
});

test('caps same-layer concurrency at max_concurrency', async () => {
  const harness = await createHarness();
  await harness.scenario({
    a: [`gate:${harness.gateFile}`],
    b: [`gate:${harness.gateFile}`],
    c: [`gate:${harness.gateFile}`],
    d: [`gate:${harness.gateFile}`],
  });
  const running = harness.engine.run(
    {
      title: 'Parallel cap',
      max_concurrency: 2,
      steps: ['a', 'b', 'c', 'd'].map(id => ({
        id,
        title: `Step ${id}`,
        instructions: `Run step ${id}.`,
        depends_on: [],
      })),
    },
    {runId: 'cap-run'},
  );
  await waitFor(async () => {
    await harness.parent.refresh();
    return (
      harness.parent.events.filter(
        event => event.type === 'workflow/step_started',
      ).length >= 2
    );
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await readFile(harness.peakFile, 'utf8'), '2');
  await writeFile(harness.gateFile, 'release');
  const result = (await running) as Data;
  assert.equal(result.ok, true);
  assert.equal(await readFile(harness.peakFile, 'utf8'), '2');
});

test('registers Workflow.run as a deferred tool beside the subagent tools', async () => {
  const harness = await createHarness();
  const tools = new ToolRegistry();
  registerSubagentTools(tools, {
    root: harness.root,
    userDataDir: harness.root,
    workspace: harness.root,
    session: harness.parent,
  });
  registerWorkflowRunTool(tools, {
    root: harness.root,
    userDataDir: harness.root,
    workspace: path.join(harness.root, 'workspace'),
    session: harness.parent,
    config: {model: 'fixture'},
    permissionMode: 'safe',
  });
  assert.ok(!tools.schemas().some(schema => schema.name === WORKFLOW_RUN_TOOL));
  assert.equal(tools.discover({names: [WORKFLOW_RUN_TOOL]}).length, 1);
  assert.ok(
    tools.search('workflow').some(spec => spec.name === WORKFLOW_RUN_TOOL),
  );
  const run = await tools.execute({
    id: 'wf-call',
    name: WORKFLOW_RUN_TOOL,
    arguments: {
      title: 'Solo run',
      steps: [
        {
          id: 'solo',
          title: 'Solo',
          instructions: 'Run the only step.',
          depends_on: [],
        },
      ],
    },
  });
  assert.equal(run.is_error, false, run.error_message);
  assert.equal((run.value as Data).ok, true);
  const bad = await tools.execute({
    id: 'wf-bad',
    name: WORKFLOW_RUN_TOOL,
    arguments: {
      title: 'Cycle',
      steps: [
        {id: 'a', title: 'A', instructions: 'x', depends_on: ['b']},
        {id: 'b', title: 'B', instructions: 'y', depends_on: ['a']},
      ],
    },
  });
  assert.equal(bad.is_error, true);
  assert.match(String(bad.error_message), /workflow_cycle: a -> b -> a/);
});

test('stopping a child whose status is not yet persisted still leaves the stop flag', async () => {
  const harness = await createHarness();
  const childSessionId = 'wf-abortrace-a-a1';
  await harness.parent.append('subagent/created', {
    childSessionId,
    task: 'registered before the status file is written',
    readonly: true,
  });
  const stopFile = path.join(
    harness.root,
    'agent-sessions',
    `${childSessionId}.agent.stop`,
  );
  const stopped = await stopAgent(harness.root, harness.parent.id, childSessionId);
  assert.equal(stopped.ok, true);
  assert.equal(await readFile(stopFile, 'utf8'), 'stop');
});
