import { spawn } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExternalTasks, executableCommand, terminateProcess } from './external';
import { delay, listWindows } from './desktop';
import { validateTargetLease } from './context_policy';
import { readJson } from './learning';

type Data = Record<string, any>;

export async function runExternalWorker(file: string): Promise<void> {
  const initial = await readJson(file), id = initial.taskId, store = new ExternalTasks(path.dirname(path.dirname(path.dirname(file))));
  const invocation = initial.invocation, request = initial.request, rpc = invocation.protocol === 'jsonl-rpc';
  if (invocation.shell) throw new Error('shell_invocation_refused');
  const promptFile = path.join(path.dirname(file), 'prompt.md');
  if (invocation.argv.includes('{PROMPT_FILE}')) await writeFile(promptFile, request.prompt, 'utf8');
  const command = await executableCommand(invocation.argv[0], invocation.argv.slice(1).map((arg: string) => arg === '{PROMPT_FILE}' ? promptFile : arg));
  const child = spawn(command.file, command.args, { cwd: invocation.cwd, env: { ...process.env, ...invocation.env, ...command.env }, stdio: 'pipe', windowsHide: true });
  let exited = false, exitCode: number | null = null, error = '', output = '', stderr = '', pending = '', eventCount = 0, terminal: Data | null = null, agentEnd: Data | null = null;
  let accepted = !rpc, settledAt = 0, outputText = '', sessionId = '', writing = Promise.resolve();
  const startedAt = Date.now(), delivered = new Set<string>();
  const persist = (name: string, text: string) => { writing = writing.then(() => appendFile(path.join(path.dirname(file), name), text, 'utf8')); };
  const send = (value: Data) => child.stdin.write(JSON.stringify(value) + '\n');
  const onRecord = (value: Data) => {
    eventCount++; terminal = value;
    sessionId = value.session_id || value.sessionId || value.thread_id || sessionId;
    if (typeof value.result === 'string') outputText = value.result;
    if (value.item?.type === 'agent_message') outputText = value.item.text || outputText;
    if (value.type === 'response' && value.id === 'initial') { accepted = value.success === true; if (value.success === false) error = `pi_rpc_prompt_rejected:${value.error}`; }
    if (value.type === 'response' && String(value.id).startsWith('steer:')) {
      writing = writing.then(async () => { await store.mutate(id, current => { const receipt = current.steeringReceipts.find((item: Data) => item.id === String(value.id).slice(6)); if (receipt) Object.assign(receipt, { state: value.success ? 'delivered' : 'rejected', deliveredAt: new Date().toISOString(), error: value.error || null }); }); });
    }
    if (value.type === 'agent_end') agentEnd = value;
    if (value.type === 'agent_settled') settledAt = Date.now();
    if (value.is_error === true || value.type === 'turn.failed' || value.type === 'error') error = String(value.error?.message || value.error || value.result || value.message || 'provider_failed');
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { persist('stdout.log', chunk); output = (output + chunk).slice(-120000); pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop() || ''; for (const line of lines) try { onRecord(JSON.parse(line)); } catch {} });
  child.stderr.on('data', (chunk: string) => { persist('stderr.log', chunk); stderr = (stderr + chunk).slice(-120000); });
  child.once('error', cause => { error = cause.message; exited = true; });
  child.once('close', code => { exitCode = code; exited = true; });
  child.stdin.on('error', cause => { if (!exited && !settledAt) error = cause.message; });
  await store.mutate(id, value => { if (value.cancelRequested) { terminateProcess(child.pid); return; } value.status = 'running'; value.agentPid = child.pid; });
  if (rpc) send({ id: 'initial', type: 'prompt', message: request.prompt }); else child.stdin.end(invocation.stdin ?? undefined);
  try {
    while (!exited) {
      const current = await store.get(id);
      if (current.cancelRequested || ['cancelled', 'paused_target_mismatch'].includes(current.status)) { terminateProcess(child.pid); break; }
      if (current.targetLease?.state === 'active' && current.targetLease.lease) {
        const check = await validateTargetLease(current.targetLease.lease, await listWindows().catch(() => null));
        if (!check.valid) { await store.mutate(id, value => { value.status = 'paused_target_mismatch'; value.targetLease = { ...value.targetLease, state: 'paused', reason: check.reason }; }); terminateProcess(child.pid); break; }
      }
      if (error) { terminateProcess(child.pid); break; }
      if (rpc && !accepted && Date.now() - startedAt > 10000) { error = 'pi_rpc_prompt_ack_timeout'; terminateProcess(child.pid); break; }
      if (rpc) for (const receipt of current.steeringReceipts || []) {
        if (receipt.state !== 'queued' || delivered.has(receipt.id)) continue;
        delivered.add(receipt.id); settledAt = 0; send({ id: `steer:${receipt.id}`, type: 'prompt', message: receipt.message, streamingBehavior: 'steer' });
      }
      if (rpc && settledAt && Date.now() - settledAt >= 750) { child.stdin.end(); break; }
      await delay(150);
    }
    for (let count = 0; !exited && count < 50; count++) await delay(100);
    if (!exited) terminateProcess(child.pid);
    if (pending.trim()) try { onRecord(JSON.parse(pending)); } catch {}
    if (invocation.protocol === 'json' && !eventCount) try { onRecord(JSON.parse(output)); } catch {}
    if (rpc) {
      const last = (agentEnd as Data | null)?.messages?.filter((item: Data) => item.role === 'assistant').at(-1);
      if (['error', 'aborted'].includes(last?.stopReason || last?.stop_reason)) error = String(last.errorMessage || last.error_message || last.stopReason);
      if (!settledAt && !error) error = `pi_rpc_exit_${exitCode}`;
    }
    await writing;
    await store.mutate(id, value => {
      if (['cancelled', 'paused_target_mismatch'].includes(value.status)) return;
      value.status = !error && (rpc ? !!settledAt : exitCode === 0) ? 'succeeded' : 'failed';
      value.exitCode = exitCode; value.error = error || (value.status === 'failed' ? `agent_exit_${exitCode}` : null);
      value.summary = (outputText || output || stderr).slice(-4000);
      value.result = { eventCount, outputText: outputText.slice(-8000), outputExcerpt: output.slice(-8000), sessionId, terminalEvent: terminal, protocol: invocation.protocol };
    });
  } finally { if (!exited) terminateProcess(child.pid); }
}

if (require.main === module) runExternalWorker(path.resolve(process.argv[2])).catch(async error => {
  try { const file = path.resolve(process.argv[2]), value = await readJson(file), store = new ExternalTasks(path.dirname(path.dirname(path.dirname(file)))); await store.mutate(value.taskId, task => { task.status = 'failed'; task.error = String(error); }); } finally { process.exitCode = 1; }
});
