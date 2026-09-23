import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRequest, closeDesktop, desktopBusyResult } from '../electron/runtime/desktop';
import { EventSession } from '../electron/runtime/session';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
  assert.equal(session.approvedCalls().length, 0);
  assert.equal(session.deriveMessages().find(message => message.tool_call_id === 'click' && message.role === 'tool')?.name, 'click');
});
