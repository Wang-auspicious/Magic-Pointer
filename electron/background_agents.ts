import fs from 'node:fs/promises';
import path from 'node:path';

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Workers publish atomically. Reading their snapshots does not start Python. */
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
      return { ...task, status: 'stopped', phase: 'stopped', pendingInput: undefined,
        summary: 'Worker exited before finishing. Resume this Agent to continue from its journal.' };
    }
    return task;
  }));
  return tasks.filter(task => task !== null);
}
