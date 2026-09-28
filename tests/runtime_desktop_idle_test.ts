import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRequest, closeDesktop, desktopBusyResult, waitForDesktop } from '../electron/runtime/desktop';
import { EventSession } from '../electron/runtime/session';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runAgent } from '../electron/runtime/agent';
import { ToolRegistry } from '../electron/runtime/tools';

test('a desktop busy action resumes without an unknown-outcome recovery barrier', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-desktop-resume-'));
  const session = await EventSession.open(root, 'busy-resume');
  let executions = 0;
  const registry = () => {
    const tools = new ToolRegistry();
    tools.register({ name: 'activate_window', description: 'Activate the requested window', effect: 'local_irreversible',
      input_schema: { type: 'object', properties: {}, required: [] }, execute: () => ++executions === 1
        ? desktopBusyResult(new Error('computer_use_busy')) : { ok: true, verification: { matched: true } } });
    return tools;
  };
  const options = { root, userDataDir: root, session, permissionMode: 'bypass' as const };
  const first = await runAgent({ ...options, registry: registry(), model: async () => ({ text: '', tool_calls: [{ id: 'first', name: 'activate_window', arguments: {} }] }) });
  assert.equal(first.reason, 'awaiting_user');
  assert.deepEqual(session.pendingRecovery(), [], 'not_started is known not to have changed the desktop');
  const reopened = await EventSession.open(root, 'busy-resume', false);
  assert.deepEqual(reopened.pendingRecovery(), [], 'old logs must also project not_started correctly');
  await reopened.answer('first', { answer: '继续任务' });
  const resumed = await runAgent({ ...options, session: reopened, registry: registry(), model: async () => {
    assert.equal(executions, 2, 'continue resumes the saved action before spending another model request');
    return { text: 'Opened', tool_calls: [] };
  } });
  assert.equal(resumed.reason, 'completed');
  assert.equal(executions, 2);
  assert.deepEqual(reopened.pendingRecovery(), []);
});

test('temporary desktop contention waits locally and cancellation does not retry an action', async () => {
  let attempts = 0;
  const result = await waitForDesktop(async () => {
    if (++attempts === 1) throw new Error('computer_use_busy');
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  const controller = new AbortController();
  await assert.rejects(waitForDesktop(async () => {
    controller.abort(new Error('stopped'));
    throw new Error('computer_use_busy');
  }, controller.signal), /stopped/);
});

test('choosing to take over the desktop stops without another model request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-desktop-takeover-'));
  const session = await EventSession.open(root, 'desktop-takeover');
  const registry = new ToolRegistry();
  registry.register({ name: 'activate_window', description: 'Focus window', effect: 'reversible_write',
    input_schema: { type: 'object', properties: {}, required: [] }, execute: () => desktopBusyResult(new Error('computer_use_busy')) });
  const options = { root, userDataDir: root, session, registry, permissionMode: 'accept_reversible' as const };
  await runAgent({ ...options, model: async () => ({ text: '', tool_calls: [{ id: 'busy', name: 'activate_window', arguments: {} }] }) });
  await session.answer('busy', { answer: '由我接管' });
  let requests = 0;
  const stopped = await runAgent({ ...options, model: async () => { requests++; return { text: 'Done', tool_calls: [] }; } });
  assert.equal(stopped.reason, 'user_interrupt');
  assert.equal(requests, 0);
  assert.equal(session.pendingInput(), null);
});

test('native desktop host exposes a read-only user idle probe', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  try {
    const result = await nativeRequest<{ idleMs: number; usedBackend: string }>('input_idle');
    assert.ok(Number.isFinite(result.idleMs) && result.idleMs >= 0);
    assert.equal(result.usedBackend, 'win32_last_input');
  } finally { closeDesktop(); }
});

test('native activation obeys the shared input mutex before touching a window', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const script = `$m=[Threading.Mutex]::new($false,'Local\\MagicPointer.RealInput');try{$m.WaitOne()|Out-Null;[Console]::WriteLine('ready');Start-Sleep -Seconds 5}finally{$m.ReleaseMutex();$m.Dispose()}`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      holder.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready')) resolve(); });
      holder.once('error', reject);
      holder.once('exit', code => { if (!output.includes('ready')) reject(new Error(`mutex holder exited: ${code}`)); });
    });
    await assert.rejects(nativeRequest('input', { action: 'activate_window', window: { hwnd: 0, pid: 0 } }), /computer_use_busy/);
    await assert.rejects(nativeRequest('launch', { app: 'mp-missing-app-for-input-lock-test.exe' }), /computer_use_busy/);
  } finally { holder.kill(); closeDesktop(); }
});

test('desktop busy waits for user input without marking an action executed or approved', async () => {
  const result = desktopBusyResult(new Error('computer_use_busy'));
  assert.equal(result?.notExecuted, true);
  assert.equal(result?.waitingForDesktop, true);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-desktop-busy-'));
  const session = await EventSession.open(root, 'busy');
  await session.startTurn();
  await session.appendMessage({ role: 'assistant', content: '', origin: 'data', tool_calls: [{ id: 'click', name: 'click', arguments: { x: 5, y: 5 } }] });
  await session.appendMessage({ role: 'tool', name: 'click', tool_call_id: 'click', content: JSON.stringify(result), origin: 'data' });
  await session.endTurn('awaiting_user');
  assert.equal(session.pendingInput()?.kind, 'desktop_wait');
  assert.equal(session.approvedCalls().length, 0);
  await session.answer('click', { answer: '继续任务' });
  assert.equal(session.pendingInput(), null);
  assert.deepEqual(session.approvedCalls().map(call => [call.name, call.arguments]), [['click', { x: 5, y: 5 }]]);
  assert.equal(session.deriveMessages().find(message => message.tool_call_id === 'click' && message.role === 'tool')?.name, 'click');
});
