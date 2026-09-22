import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBackgroundAgent, type BackgroundPayload } from './agent_background';
import { EventSession } from './session';

async function main(): Promise<void> {
  if (process.argv[2] === 'agent') {
    let input = ''; for await (const chunk of process.stdin) input += chunk.toString();
    await runBackgroundAgent(JSON.parse(input) as BackgroundPayload); return;
  }
  if (process.argv[2] !== 'shell') throw new Error('Unknown worker mode');
  const file = process.argv[3], meta = JSON.parse(await readFile(file, 'utf8'));
  const log = await open(meta.log, 'a');
  try {
    const child = spawn(meta.command, { cwd: meta.cwd, shell: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    Object.assign(meta, { status: 'running', pid: child.pid, workerPid: process.pid }); await writeFile(file, JSON.stringify(meta));
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    Object.assign(meta, { status: exit === 0 ? 'completed' : 'failed', exit, completedAt: Date.now() });
    await writeFile(file, JSON.stringify(meta));
    if (meta.sessionId) {
      const userDataDir = path.dirname(path.dirname(meta.sessionFile)), session = await EventSession.open(userDataDir, meta.sessionId, false);
      await session.enqueue(`[Background command ${meta.id} ${meta.status}] exit=${exit}. Use BashRead for output.`, 'next-step', undefined, `shell-${meta.id}`);
    }
  } catch (error) { await writeFile(file, JSON.stringify({ ...meta, status: 'failed', error: (error as Error).message })); }
  finally { await log.close(); }
}
void main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
