import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repository = path.resolve(__dirname, '..');
const runtime = (name: string) => require(path.join(repository, 'build', 'electron', 'runtime', `${name}.js`));
const { EventSession } = runtime('session');
const { ToolRegistry } = runtime('tools');
const { registerSubagentTools, readAgentStatus, steerAgent, respondToAgent } = runtime('agent_background');
const { resolveModelConfig } = runtime('model');

async function launch(evaluationRoot: string, resumeId?: string, correction = false): Promise<void> {
  const userDataDir = path.join(evaluationRoot, 'user'), workspace = path.join(evaluationRoot, 'workspace');
  const parent = await EventSession.open(userDataDir, 'parent');
  if (!resumeId) { await parent.startTurn(); await parent.endTurn('completed'); }
  const config = resolveModelConfig(null, repository, path.join(repository, 'data', 'runtime'));
  if (!config.credential && config.apiMode !== 'local') throw new Error('model_credential_unavailable');
  const registry = new ToolRegistry();
  registerSubagentTools(registry, { root: repository, userDataDir, workspace, session: parent, config,
    permissionMode: 'default', deniedTools: correction ? ['Write', 'Patch', 'Rewind', 'Bash'] : ['Write', 'Edit', 'Patch', 'Rewind', ...(resumeId ? ['Bash'] : [])] });
  const task = correction
    ? 'Continue this exact task from its journal. request-b.txt currently has bytes MARK_B followed by one unwanted ASCII space and CRLF. Use Read, then Edit to remove only that one space, preserving the CRLF; expected final bytes are 4D 41 52 4B 5F 42 0D 0A (MARK_B\\r\\n). Read request-b.txt again and report its actual contents. request-a.txt must remain absent. Do not use Bash, Write, Patch, or Rewind; do not change any other file.'
    : resumeId
    ? 'Continue the original task from its journal. request-b.txt already contains MARK_B and request-a.txt must remain absent. Verify request-b.txt with Read, then report the actual result. Do not run Bash or modify files.'
    : 'Use only the Bash tool to create request-a.txt in the workspace with the text MARK_A. If Bash is not available, first call Tools(names=["Bash"]). Do not use Write, Edit, Patch, or Rewind. Read the file back before reporting completion.';
  const started = await registry.execute({ id: 'start-agent', name: 'Agent', arguments: { task, ...(resumeId ? { resume_id: resumeId } : {}), run_in_background: true, readonly: false } });
  if (started.is_error) throw new Error(started.error_message);
  await registry.close();
  process.stdout.write(JSON.stringify({ childId: started.value.id }) + '\n');
}

async function waitFor(evaluationRoot: string, childId: string, condition: (status: Record<string, any>) => boolean, timeoutMs: number) {
  const userDataDir = path.join(evaluationRoot, 'user'), until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await readAgentStatus(userDataDir, childId);
    if (status && condition(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('background_agent_wait_timeout');
}

async function main(): Promise<void> {
  if (process.argv[2] === 'launch') { await launch(process.argv[3]!); return; }
  if (process.argv[2] === 'resume-worker') { await launch(process.argv[3]!, process.argv[4]!); return; }
  if (process.argv[2] === 'correct-worker') { await launch(process.argv[3]!, process.argv[4]!, true); return; }
  if (process.argv[2] === 'correct') {
    const evaluationRoot = path.resolve(process.argv[3]!);
    const reportPath = path.join(evaluationRoot, 'report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const childId = String(report.childId), userDataDir = path.join(evaluationRoot, 'user');
    const targetA = path.join(evaluationRoot, 'workspace', 'request-a.txt');
    const targetB = path.join(evaluationRoot, 'workspace', 'request-b.txt');
    const before = await readFile(targetB);
    const correction: Record<string, any> = { createdAt: new Date().toISOString(), beforeUtf8Hex: before.toString('hex'),
      expectedUtf8Hex: '4d41524b5f420d0a', afterUtf8Hex: null, exactBytes: false, targetAAbsent: false,
      launcherExited: false, status: null, receiptStatus: null, usedBackend: null, elapsedMs: null, tools: [], approvalRequested: false, error: null };
    try {
      const launcher = spawn(process.execPath, ['--require', 'tsx/cjs', __filename, 'correct-worker', evaluationRoot, childId],
        { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      launcher.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      launcher.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { launcher.once('error', reject); launcher.once('exit', resolve); });
      if (code !== 0 || JSON.parse(stdout.trim()).childId !== childId) throw new Error(`correction_launcher_failed:${stderr.slice(-1000)}`);
      correction.launcherExited = true;
      const terminal = await waitFor(evaluationRoot, childId, status => !['starting', 'running'].includes(status.status), 240000);
      correction.status = terminal.status; correction.elapsedMs = terminal.elapsedMs;
      correction.approvalRequested = terminal.status === 'awaiting_user';
      const child = await EventSession.open(userDataDir, childId, false);
      const lastTurn = [...child.events].reverse().find((event: any) => event.type === 'turn/start');
      const turnEvents = child.events.filter((event: any) => event.seq >= (lastTurn?.seq ?? 0));
      correction.tools = turnEvents.filter((event: any) => event.type === 'operation/prepared').map((event: any) => event.data.name);
      const receipt = [...turnEvents].reverse().find((event: any) => event.type === 'receipt/issued');
      correction.receiptStatus = receipt?.data.status ?? null; correction.usedBackend = receipt?.data.usedBackend ?? null;
      const after = await readFile(targetB);
      correction.afterUtf8Hex = after.toString('hex');
      correction.exactBytes = correction.afterUtf8Hex === correction.expectedUtf8Hex;
      correction.targetAAbsent = !(await stat(targetA).then(() => true, () => false));
      if (correction.status !== 'completed' || !correction.exactBytes || !correction.targetAAbsent ||
        correction.tools.some((name: string) => !['Read', 'Edit'].includes(name))) throw new Error('correction_result_not_verified');
    } catch (error) { correction.error = error instanceof Error ? error.message : String(error); }
    report.correction = correction;
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ reportPath, correction }) + '\n');
    if (correction.error) process.exitCode = 1;
    return;
  }
  if (process.argv[2] === 'finalize') {
    const evaluationRoot = path.resolve(process.argv[3]!);
    const reportPath = path.join(evaluationRoot, 'report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const childId = String(report.childId);
    const status = await readAgentStatus(path.join(evaluationRoot, 'user'), childId);
    const child = await EventSession.open(path.join(evaluationRoot, 'user'), childId, false);
    const receipt = [...child.events].reverse().find((event: any) => event.type === 'receipt/issued');
    const targetBContent = await readFile(path.join(evaluationRoot, 'workspace', 'request-b.txt'), 'utf8').catch(() => null);
    Object.assign(report, { stoppedDuringVerification: report.finalStatus === 'stopped', resumedFromJournal: true,
      finalStatus: status?.status ?? null, receiptStatus: receipt?.data.status ?? null,
      usedBackend: receipt?.data.usedBackend ?? null, resumeElapsedMs: status?.elapsedMs ?? null,
      targetAExists: await stat(path.join(evaluationRoot, 'workspace', 'request-a.txt')).then(() => true, () => false),
      targetBContent, targetBExactMarker: targetBContent === 'MARK_B', error: status?.status === 'completed' ? null : `resume_status:${status?.status}` });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ reportPath, finalStatus: report.finalStatus, receiptStatus: report.receiptStatus,
      usedBackend: report.usedBackend, targetAExists: report.targetAExists, targetBContent: report.targetBContent,
      targetBExactMarker: report.targetBExactMarker, error: report.error }) + '\n');
    if (report.error) process.exitCode = 1;
    return;
  }
  const continuing = process.argv[2] === 'resume';
  const evaluationRoot = continuing ? path.resolve(process.argv[3]!) : path.join(repository, 'data', 'runtime', 'background-evals', randomUUID());
  const workspace = path.join(evaluationRoot, 'workspace'), reportPath = path.join(evaluationRoot, 'report.json');
  await mkdir(workspace, { recursive: true });
  const config = resolveModelConfig(null, repository, path.join(repository, 'data', 'runtime'));
  const report: Record<string, any> = { schemaVersion: 1, createdAt: new Date().toISOString(),
    model: config.model, apiMode: config.apiMode, providerHost: config.baseUrl ? new URL(config.baseUrl).host : null,
    launcherExited: false, firstApproval: null, steerAccepted: false, secondApproval: null, nonTargetApprovalsDenied: 0,
    finalStatus: null, receiptStatus: null, usedBackend: null, elapsedMs: null, targetAExists: false, targetBContent: null, error: null };
  try {
    let childId: string;
    if (continuing) {
      const prior = JSON.parse(await readFile(reportPath, 'utf8'));
      childId = String(prior.childId);
      report.launcherExited = prior.launcherExited === true;
    } else {
      const launcher = spawn(process.execPath, ['--require', 'tsx/cjs', __filename, 'launch', evaluationRoot],
        { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      launcher.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      launcher.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { launcher.once('error', reject); launcher.once('exit', resolve); });
      if (code !== 0) throw new Error(`launcher_failed:${stderr.slice(-1500)}`);
      report.launcherExited = true;
      childId = JSON.parse(stdout.trim()).childId as string;
    }
    report.childId = childId;
    const first = await waitFor(evaluationRoot, childId, status => status.status === 'awaiting_user' || !['starting', 'running'].includes(status.status), 180000);
    if (first.status !== 'awaiting_user') throw new Error(`first_approval_missing:${first.status}:${String(first.summary).slice(0, 250)}`);
    report.firstApproval = { tool: first.pendingInput?.tool, requestId: first.pendingInput?.requestId,
      targetsA: JSON.stringify(first.pendingInput?.action?.arguments || {}).includes('request-a.txt') };
    if (first.pendingInput?.tool !== 'Bash') throw new Error('first_approval_not_bash');
    await steerAgent(path.join(evaluationRoot, 'user'), 'parent', childId,
      'Correction: do not create request-a.txt. Use Bash to create request-b.txt with the text MARK_B instead. Verify request-b.txt by reading it. Do not perform the old pending command.');
    report.steerAccepted = true;
    let previousRequestId = first.pendingInput?.requestId;
    let second: Record<string, any> | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      const pending = await waitFor(evaluationRoot, childId, status => status.status === 'awaiting_user' &&
        status.pendingInput?.requestId !== previousRequestId || !['starting', 'running', 'awaiting_user'].includes(status.status), 180000);
      if (pending.status !== 'awaiting_user') throw new Error(`second_approval_missing:${pending.status}:${String(pending.summary).slice(0, 250)}`);
      const targetB = pending.pendingInput?.tool === 'Bash' && JSON.stringify(pending.pendingInput?.action?.arguments || {}).includes('request-b.txt');
      if (targetB) { second = pending; break; }
      await respondToAgent(path.join(evaluationRoot, 'user'), 'parent', childId, String(pending.pendingInput.requestId), { decision: 'deny' });
      report.nonTargetApprovalsDenied++;
      previousRequestId = pending.pendingInput.requestId;
    }
    if (!second) throw new Error('second_approval_not_target_b_bash');
    report.secondApproval = { tool: second.pendingInput?.tool, requestId: second.pendingInput?.requestId,
      targetsB: JSON.stringify(second.pendingInput?.action?.arguments || {}).includes('request-b.txt') };
    await respondToAgent(path.join(evaluationRoot, 'user'), 'parent', childId, String(second.pendingInput.requestId), { decision: 'once' });
    const terminal = await waitFor(evaluationRoot, childId, status => !['starting', 'running', 'awaiting_user'].includes(status.status), 240000);
    report.finalStatus = terminal.status; report.elapsedMs = terminal.elapsedMs;
    const child = await EventSession.open(path.join(evaluationRoot, 'user'), childId, false);
    const receipt = [...child.events].reverse().find((event: any) => event.type === 'receipt/issued');
    report.receiptStatus = receipt?.data.status ?? null; report.usedBackend = receipt?.data.usedBackend ?? null;
    report.targetAExists = await stat(path.join(workspace, 'request-a.txt')).then(() => true, () => false);
    report.targetBContent = await readFile(path.join(workspace, 'request-b.txt'), 'utf8').catch(() => null);
    if (report.targetAExists || !String(report.targetBContent).includes('MARK_B')) throw new Error('final_files_do_not_match_steer');
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); }
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ reportPath, ...report, targetBContent: report.targetBContent ? '[verified locally]' : null }) + '\n');
  if (report.error) process.exitCode = 1;
}

void main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
