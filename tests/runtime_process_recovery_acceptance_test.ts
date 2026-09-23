import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventSession } from '../electron/runtime/session';

const repository = path.resolve(__dirname, '..');
const sessionId = 'agent-studio-new-process-recovery';

async function processOutput(args: string[], input: object | null, environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, { cwd: repository, env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.end(input === null ? '' : JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, stdout, stderr };
}

async function bridge(kind: string, payload: object, root: string, userDataDir: string, extra: NodeJS.ProcessEnv = {}): Promise<Record<string, any>> {
  const result = await processOutput(['--require', 'tsx/cjs', 'electron/runtime/worker.ts', kind], { root, ...payload },
    { MAGIC_POINTER_USER_DATA_DIR: userDataDir, ...extra });
  assert.equal(result.code, 0, `${kind}: ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

test('an interrupted task survives independent worker processes with its plan, source, pending approval and unknown write', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-process-recovery-'));
  const userDataDir = path.join(root, 'user'), workspace = path.join(root, 'workspace');
  const capture = path.join(root, 'model-messages.json'), externalWrite = path.join(root, 'external-write.txt');
  await mkdir(workspace); await writeFile(path.join(workspace, 'fixture.txt'), 'before');
  try {
    const seed = `
      const {EventSession}=require('./electron/runtime/session.ts');
      const {fileSource,updateContext}=require('./electron/runtime/context.ts');
      (async()=>{
        const id=process.env.MP_RECOVERY_SESSION_ID, session=await EventSession.open(process.env.MP_RECOVERY_USER_DATA,id);
        const turn=await session.startTurn();
        await session.appendMessage({role:'user',content:'完成持久任务并核验外部写入',origin:'instruction'});
        await session.append('plan/updated',{taskId:id,plan:[{content:'核验写入状态',status:'in_progress'},{content:'交付结果',status:'pending'}]});
        const source=fileSource(id,process.env.MP_RECOVERY_FILE); source.sourceId='source-fixture';
        await updateContext(session,{sources:[source],referenceUpdates:[{operation:'add',binding:{referenceId:'ref-fixture',label:'@fixture',sourceId:source.sourceId,locator:{kind:'whole',value:{}},role:'source',frameLeaseId:null,capturedAtMs:Date.now(),ordinal:1,active:true}}],scopeGrants:[{grantId:'send-fixture',taskId:id,sourceIds:[],folderRoots:[],windowIds:[],recipients:['room-a','room-b'],actions:['send'],expiresAtMs:null}]});
        await session.append('permission/requested',{requestId:'approval-fixture',pendingInput:{kind:'permission',tool:'ExternalWrite',question:'允许外部写入？',options:['仅这一次允许','本会话总是允许 ExternalWrite','拒绝'],requestId:'approval-fixture',harnessPermission:true,action:{tool:'ExternalWrite',arguments:{target:'room-a',value:'after'}}}});
        await session.append('operation/prepared',{operationId:'unknown-write',turn,callId:'write-fixture',name:'ExternalWrite',arguments:{target:'room-a',value:'after'},effect:'external_send',dispatched:true});
      })().catch(error=>{console.error(error);process.exitCode=1});
    `;
    const seeded = await processOutput(['--require', 'tsx/cjs', '-e', seed], null, {
      MP_RECOVERY_USER_DATA: userDataDir, MP_RECOVERY_SESSION_ID: sessionId, MP_RECOVERY_FILE: path.join(workspace, 'fixture.txt'),
    });
    assert.equal(seeded.code, 0, seeded.stderr);

    const status = await bridge('agent_session', { action: 'status', sessionId }, root, userDataDir);
    assert.equal(status.hasPendingWork, true, 'an open turn from a dead worker remains unfinished');
    assert.equal(status.openTurn, 1);
    assert.equal(status.pendingInput?.requestId, 'approval-fixture');
    assert.deepEqual(status.pendingRecovery.map((item: Record<string, any>) => [item.operationId, item.recoveryPolicy]), [['unknown-write', 'never_replay']]);

    const answered = await bridge('agent_session', { action: 'answer', sessionId, requestId: 'approval-fixture', response: { decision: 'once' } }, root, userDataDir);
    assert.equal(answered.ok, true, answered.error);
    assert.equal(answered.answer.requestId, 'approval-fixture');

    const pluginDir = path.join(userDataDir, 'data', 'plugins', 'process-recovery');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({ main: 'entry.cjs' }));
    await writeFile(path.join(pluginDir, 'entry.cjs'), `module.exports={name:'process-recovery',async apply(ctx){
      const send=name=>ctx.get('tools').register({name,description:'Fixture external write',effect:'external_send',used_backend:'native_desktop',input_schema:{type:'object',properties:{target:{type:'string'},value:{type:'string'}},required:['target','value']},access_for:args=>({action:'send',recipients:[args.target]}),execute:args=>{require('node:fs').appendFileSync(process.env.MP_RECOVERY_EXTERNAL_WRITE,JSON.stringify(args)+'\\n');return {verification:{matched:true}}}});
      send('ExternalWrite');send('ExternalSubmit');
      ctx.get('tools').register({name:'InspectDelivery',description:'Fixture delivery readback',effect:'read',input_schema:{type:'object',properties:{target:{type:'string'}},required:['target']},execute:args=>({target:args.target,delivered:false})});
      let calls=0;await ctx.provideUp('llm',async request=>{require('node:fs').writeFileSync(process.env.MP_RECOVERY_CAPTURE,JSON.stringify(request.messages));const scenario=process.env.MP_RECOVERY_SCENARIO;
        if(++calls===1&&scenario==='variants')return {text:'',tool_calls:[{id:'same-target-variant',name:'ExternalWrite',arguments:{target:'room-a',value:' after '}},{id:'same-target-other-tool',name:'ExternalSubmit',arguments:{target:'room-a',value:'slightly changed'}},{id:'different-target',name:'ExternalWrite',arguments:{target:'room-b',value:'other'}}],usedBackend:'fixture.recovery'};
        if(calls===1&&scenario==='verify')return {text:'',tool_calls:[{id:'verify-room-a',name:'InspectDelivery',arguments:{target:'room-a'}}],usedBackend:'fixture.recovery'};
        if(calls===1&&scenario==='after-resolution')return {text:'',tool_calls:[{id:'after-resolution',name:'ExternalWrite',arguments:{target:'room-a',value:'after confirmed'}}],usedBackend:'fixture.recovery'};
        return {text:'验收完成',tool_calls:[],usedBackend:'fixture.recovery'}})}}`);
    await writeFile(path.join(userDataDir, 'data', 'harness.patch.json'), JSON.stringify({ schemaVersion: 1, patch: { 'llm-provider': { disabled: true } } }));
    const resumed = await bridge('conversation', { agentSessionId: sessionId, workspaceRoot: workspace, resume: true,
      modelRuntime: { model: 'fixture', credential: 'fixture', baseUrl: 'http://127.0.0.1:1' } }, root, userDataDir,
    { MP_RECOVERY_CAPTURE: capture, MP_RECOVERY_EXTERNAL_WRITE: externalWrite });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(resumed.usedBackend, 'fixture.recovery');
    assert.ok(resumed.timingMs > 0);
    assert.equal(resumed.hasPendingWork, true, 'an unresolved external effect keeps the task reviewable');
    assert.equal(resumed.receipts[0].status, 'unverified');
    assert.equal(resumed.plan.plan[0].content, '核验写入状态');
    assert.equal(resumed.taskContext.sources[0].sourceId, 'source-fixture');
    assert.equal(resumed.taskContext.references[0].referenceId, 'ref-fixture');
    assert.match(String(resumed.events[0]?.value), /RECOVERY_RETRY_BLOCKED/);
    assert.equal(await stat(externalWrite).then(() => true, () => false), false, 'an unknown external write must not replay');
    const messages = await readFile(capture, 'utf8');
    for (const marker of ['核验写入状态', 'source-fixture', 'ref-fixture', 'unknown-write']) assert.ok(messages.includes(marker), `resume omitted ${marker}`);
    const finalStatus = await bridge('agent_session', { action: 'status', sessionId }, root, userDataDir);
    assert.equal(finalStatus.pendingInput, null);
    assert.equal(finalStatus.pendingRecovery.length, 1, 'the unknown external effect still needs explicit recovery');
    assert.equal(finalStatus.hasPendingWork, true);

    const variants = await bridge('conversation', { agentSessionId: sessionId, workspaceRoot: workspace, question: 'Check delivery targets', permissionPreset: 'danger-full-access',
      modelRuntime: { model: 'fixture', credential: 'fixture', baseUrl: 'http://127.0.0.1:1' } }, root, userDataDir,
    { MP_RECOVERY_SCENARIO: 'variants', MP_RECOVERY_CAPTURE: capture, MP_RECOVERY_EXTERNAL_WRITE: externalWrite });
    assert.match(String(variants.events[0]?.value), /RECOVERY_RETRY_BLOCKED/, 'changed text must not bypass an unknown send to the same target');
    assert.match(String(variants.events[1]?.value), /RECOVERY_RETRY_BLOCKED/, 'a second desktop send tool cannot repeat the same target');
    assert.equal(variants.events[2]?.is_error, false, 'a different proven target remains available');
    assert.deepEqual((await readFile(externalWrite, 'utf8')).trim().split('\n').map(line => JSON.parse(line).target), ['room-b']);
    const journal = await EventSession.open(userDataDir, sessionId, false);
    const differentTarget = journal.events.find(event => event.type === 'operation/prepared' && event.data.callId === 'different-target');
    assert.deepEqual(differentTarget?.data.recoveryScope, { family: 'desktop', kind: 'recipient', targets: ['room-b'] });

    const inspected = await bridge('conversation', { agentSessionId: sessionId, workspaceRoot: workspace, question: 'Read back room-a delivery state', permissionPreset: 'danger-full-access',
      modelRuntime: { model: 'fixture', credential: 'fixture', baseUrl: 'http://127.0.0.1:1' } }, root, userDataDir,
    { MP_RECOVERY_SCENARIO: 'verify', MP_RECOVERY_CAPTURE: capture, MP_RECOVERY_EXTERNAL_WRITE: externalWrite });
    assert.equal(inspected.events[0]?.is_error, false);
    const resolved = await bridge('agent_session', { action: 'resolve_recovery', sessionId, operationId: 'unknown-write', verificationCallId: 'verify-room-a', confirmed: true }, root, userDataDir);
    assert.deepEqual(resolved.pendingRecovery, []);
    const afterResolution = await bridge('conversation', { agentSessionId: sessionId, workspaceRoot: workspace, question: 'Send after confirmation', permissionPreset: 'danger-full-access',
      modelRuntime: { model: 'fixture', credential: 'fixture', baseUrl: 'http://127.0.0.1:1' } }, root, userDataDir,
    { MP_RECOVERY_SCENARIO: 'after-resolution', MP_RECOVERY_CAPTURE: capture, MP_RECOVERY_EXTERNAL_WRITE: externalWrite });
    assert.equal(afterResolution.events[0]?.is_error, false, 'confirmed recovery permits the original target');
    assert.deepEqual((await readFile(externalWrite, 'utf8')).trim().split('\n').map(line => JSON.parse(line).target), ['room-b', 'room-a']);

    const active = await EventSession.open(userDataDir, `${sessionId}-active`);
    await active.startTurn();
    try {
      await active.append('permission/requested', { requestId: 'live-approval', pendingInput: { kind: 'permission', tool: 'ExternalWrite',
        question: '允许外部写入？', options: ['仅这一次允许', '本会话总是允许 ExternalWrite', '拒绝'], requestId: 'live-approval' } });
      const liveAnswer = await bridge('agent_session', { action: 'answer', sessionId: active.id, requestId: 'live-approval', response: { decision: 'once' } }, root, userDataDir);
      assert.equal(liveAnswer.error, 'session_busy', 'a live turn must not be repaired as an interruption');
      await active.refresh();
      assert.equal(active.openTurn, 1);
    } finally { await active.endTurn('awaiting_user'); }
    const normalAnswer = await bridge('agent_session', { action: 'answer', sessionId: active.id, requestId: 'live-approval', response: { decision: 'once' } }, root, userDataDir);
    assert.equal(normalAnswer.ok, true, normalAnswer.error);
    console.log(`recovery acceptance: usedBackend=${resumed.usedBackend} runtimeMs=${Math.round(resumed.timingMs)} unknownWrites=1 replayed=0 liveTurnProtected=true`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
