import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readJson, writeAtomic } from './learning';
import { withFileLock } from './session';
import { Fabric } from './fabric';

type Data = Record<string, any>;
export class Workflows {
  constructor(readonly root: string) {}
  file(id: string): string { if (!/^[a-f0-9-]{16,64}$/i.test(id)) throw new Error('invalid_workflow_id'); return path.join(this.root, 'workflow-tasks', id, 'task.json'); }
  async get(id: string): Promise<Data> { const task = await readJson(this.file(id)); if (task.taskId !== id) throw new Error('invalid_workflow_state'); return task; }
  public(task: Data, reused = false): Data { return { taskId: task.taskId, recipeId: task.recipeId, title: task.plan.preview?.title || task.recipeId, status: task.executionState === 'terminal' ? task.receipt?.status || 'terminal' : task.executionState === 'running' ? 'running' : task.approvalState === 'pending' ? 'approval_required' : 'ready', approvalState: task.approvalState, executionState: task.executionState, receiptStatus: task.receipt?.status || null, createdAt: task.createdAt, updatedAt: task.updatedAt, lastSurface: task.lastSurface, surfaceHistory: task.surfaceHistory, reused }; }
  async list(limit = 100): Promise<Data[]> { const directory = path.join(this.root, 'workflow-tasks'), names = await readdir(directory).catch(() => []), tasks = await Promise.all(names.map(id => this.get(id).catch(() => null))); return tasks.filter((task): task is Data => !!task).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(task => this.public(task)); }
  async create(plan: Data, surface = 'gui'): Promise<Data> {
    return withFileLock(path.join(this.root, 'workflow-tasks', 'create'), async () => {
      for (const item of await this.list(1000)) { const previous = await this.get(item.taskId); if (previous.idempotencyKey === plan.idempotencyKey) return this.public(previous, true); }
      const id = randomUUID(), now = new Date().toISOString(), task = { schemaVersion: 1, taskId: id, recipeId: plan.recipeId, idempotencyKey: plan.idempotencyKey, plan, approvalState: plan.requiresConfirmation ? 'pending' : 'not_required', executionState: 'idle', surfaceHistory: [surface], lastSurface: surface, createdAt: now, updatedAt: now };
      await writeAtomic(this.file(id), task); return this.public(task);
    });
  }
  async approve(id: string, surface = 'gui'): Promise<Data> {
    return withFileLock(this.file(id) + '.mutation', async () => { const task = await this.get(id); if (task.executionState === 'idle') task.approvalState = 'approved'; task.lastSurface = surface; task.surfaceHistory = [...task.surfaceHistory, surface].slice(-20); task.updatedAt = new Date().toISOString(); await writeAtomic(this.file(id), task); return this.public(task); });
  }
  async execute(id: string, fabric: Fabric, surface = 'gui'): Promise<Data> {
    const claim = await withFileLock(this.file(id) + '.mutation', async () => {
      const task = await this.get(id);
      if (task.executionState === 'terminal') return { task, reused: true, claimed: false };
      if (task.approvalState === 'pending' || task.executionState === 'running') return { task, reused: false, claimed: false };
      task.executionState = 'running'; task.claimId = randomUUID(); task.claimPid = process.pid; task.lastSurface = surface; task.updatedAt = new Date().toISOString(); await writeAtomic(this.file(id), task); return { task, claimed: true, reused: false };
    });
    if (!claim.claimed) return claim.reused ? { ...mapReceipt(claim.task.plan, claim.task.receipt), workflowTask: this.public(claim.task, true), reused: true, workflowReused: true } : { ok: true, state: claim.task.approvalState === 'pending' ? 'confirmation_required' : 'accepted', workflowTask: this.public(claim.task), reason: claim.task.approvalState === 'pending' ? 'approval_required' : 'execution_running' };
    let receipt: Data;
    try { receipt = await fabric.execute(claim.task.plan, true); } catch (error) { receipt = { id: randomUUID(), planId: claim.task.plan.id, recipeId: claim.task.recipeId, status: 'failed', verified: false, output: {}, error: String(error) }; }
    const completed = await withFileLock(this.file(id) + '.mutation', async () => { const task = await this.get(id); if (task.claimId !== claim.task.claimId) throw new Error('workflow_claim_changed'); task.executionState = 'terminal'; task.receipt = receipt; task.updatedAt = new Date().toISOString(); await writeAtomic(this.file(id), task); return task; });
    return { ...mapReceipt(completed.plan, receipt), workflowTask: this.public(completed), reused: false, workflowReused: false };
  }
}

export function mapReceipt(plan: Data, receipt: Data): Data { return { ok: ['succeeded', 'accepted'].includes(receipt.status), state: receipt.status === 'succeeded' ? 'completed' : receipt.status, plan, receipt, ...(receipt.error ? { error: receipt.error } : {}), ...(receipt.status === 'accepted' ? { provider: receipt.output.provider, taskId: receipt.output.taskId, message: `已交给 ${receipt.output.provider}，任务正在运行，尚未完成。` } : {}) }; }
