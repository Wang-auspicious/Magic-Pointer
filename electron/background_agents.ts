import fs from 'node:fs/promises';
import path from 'node:path';
import { EventSession } from './runtime/session';

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function readBackgroundAgents(root: string, parentId: string,
  alive: (pid: number) => boolean = processAlive): Promise<Record<string, any>[]> {
  let names: string[];
  try { names = await fs.readdir(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const tasks = await Promise.all(names.filter(name => name.endsWith('.agent.json')).map(async name => {
    const task = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
    if (task.parentSessionId !== parentId) return null;
    if (['starting', 'running', 'awaiting_user'].includes(task.status) && task.pid && !alive(task.pid)) {
      const child = await EventSession.open(path.dirname(root), String(task.id), false);
      const pendingInput = child.pendingInput();
      const lastTurn = [...child.events].reverse().find(event => event.type === 'turn/start');
      const lastAnswer = [...child.events].reverse().find(event => event.type === 'user_input/answered');
      const answerSaved = !pendingInput && !!lastAnswer && (!lastTurn || lastAnswer.seq > lastTurn.seq);
      return { ...task, status: 'stopped', phase: 'stopped', pendingInput, resumeRequired: true, answerSaved,
        summary: 'Worker exited before finishing. Resume this Agent to continue from its journal.' };
    }
    return task;
  }));
  return tasks.filter(task => task !== null);
}
