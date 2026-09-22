import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { contentHash } from './artifacts';
import { canonicalJson, withFileLock } from './session';
import { ExternalTasks, dispatchExternal, discoverExternalSessions } from './external';
import { settingsStore } from './model_admin';
type Json = Record<string, any>;
const digest = (value: unknown) => contentHash(canonicalJson(value));
const providers = new Set(['codex', 'pi', 'claude', 'gemini', 'cursor', 'opencode', 'aider']);
export class AgentContextHandoffStore {
  constructor(readonly root: string) {}
  private path(id: string): string {
    if (!/^[0-9a-f-]+$/i.test(id)) throw new Error('Invalid agent context id');
    return join(this.root, id.toLowerCase(), 'context.json');
  }
  private async read(id: string): Promise<Json> {
    const value = JSON.parse(await readFile(this.path(id), 'utf8'));
    if (
      value.schemaVersion !== 1 ||
      value.contextId !== id.toLowerCase() ||
      value.contextPacket?.schemaVersion !== 2 ||
      !value.contextPacket.packetId ||
      !value.dispatch ||
      !Array.isArray(value.deliveries)
    )
      throw new Error('Invalid agent context state');
    if (
      value.contextPacketDigest !== digest(value.contextPacket) ||
      value.dispatchDigest !== digest(value.dispatch)
    )
      throw new Error('Agent context contract changed');
    return value;
  }
  private async write(value: Json): Promise<void> {
    const path = this.path(value.contextId),
      temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  }
  private public(value: Json, reused = false): Json {
    return {
      contextId: value.contextId,
      contextPacketId: value.contextPacket.packetId,
      contextPacketDigest: value.contextPacketDigest,
      recipeId: value.contextPacket.intent?.recipeId ?? '',
      objectCount: (value.contextPacket.objects ?? []).length,
      providers: [...new Set(value.deliveries.map((item: Json) => item.provider))],
      deliveryCount: value.deliveries.length,
      deliveries: value.deliveries.map((item: Json) => ({
        deliveryId: item.deliveryId,
        provider: item.provider,
        status: item.status,
        taskId: item.taskId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      reused,
    };
  }
  private async records(): Promise<Json[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: Json[] = [];
    for (const name of names.filter((value) => /^[0-9a-f-]+$/i.test(value)))
      records.push(await this.read(name));
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async seal(
    packet: Json,
    options: { prompt: string; attachments: string[]; permission: string; privacy: Json },
  ): Promise<Json> {
    if (packet.schemaVersion !== 2 || !packet.packetId)
      throw new Error('Context Packet v2 is required');
    if (!['read', 'write'].includes(options.permission) || !options.prompt.trim())
      throw new Error('Invalid context dispatch contract');
    const dispatch = {
      prompt: options.prompt.trim(),
      attachments: [...new Set(options.attachments.filter(Boolean))],
      permission: options.permission,
      privacy: options.privacy,
    };
    return withFileLock(join(this.root, '.agent-contexts.lock'), async () => {
      const existing = (await this.records()).find(
        (value) => value.contextPacket.packetId === packet.packetId,
      );
      if (existing) {
        if (
          !isDeepStrictEqual(existing.contextPacket, packet) ||
          !isDeepStrictEqual(existing.dispatch, dispatch)
        )
          throw new Error('Agent context packet or dispatch contract collision');
        return this.public(existing, true);
      }
      const stamp = new Date().toISOString(),
        value = {
          schemaVersion: 1,
          contextId: randomUUID(),
          contextPacket: packet,
          contextPacketDigest: digest(packet),
          dispatch,
          dispatchDigest: digest(dispatch),
          deliveries: [],
          createdAt: stamp,
          updatedAt: stamp,
        };
      await this.write(value);
      return this.public(value);
    });
  }
  async get(id: string): Promise<Json> {
    return this.public(await this.read(id));
  }
  async list(limit = 100): Promise<Json[]> {
    return (await this.records())
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map((value) => this.public(value));
  }
  async reconcile(status: (id: string) => Promise<Json>, limit = 100): Promise<Json[]> {
    return withFileLock(join(this.root, '.agent-contexts.lock'), async () => {
      const records = (await this.records()).slice(0, Math.max(1, Math.min(500, limit)));
      for (const value of records) {
        let changed = false;
        for (const delivery of value.deliveries)
          if (delivery.taskId) {
            try {
              const task = await status(delivery.taskId);
              if (task.status && task.status !== delivery.status) {
                delivery.status = task.status;
                delivery.updatedAt = task.updatedAt ?? new Date().toISOString();
                changed = true;
              }
            } catch {}
          }
        if (changed) {
          value.updatedAt = new Date().toISOString();
          await this.write(value);
        }
      }
      return records.map((value) => this.public(value));
    });
  }
  async dispatch(
    id: string,
    options: { provider: string; starter: (payload: Json) => Promise<Json>; sessionId?: string },
  ): Promise<Json> {
    const provider = options.provider.trim().toLowerCase();
    if (!providers.has(provider)) throw new Error('Unsupported agent context provider');
    const prepared = await withFileLock(join(this.root, '.agent-contexts.lock'), async () => {
      const value = await this.read(id),
        existing = value.deliveries.find(
          (item: Json) =>
            item.provider === provider &&
            ['queued', 'running', 'dispatching'].includes(item.status),
        );
      if (existing) return { reused: true, value, delivery: existing };
      const stamp = new Date().toISOString(),
        delivery = {
          deliveryId: randomUUID(),
          provider,
          status: 'dispatching',
          taskId: null,
          createdAt: stamp,
          updatedAt: stamp,
        };
      value.deliveries.push(delivery);
      value.updatedAt = stamp;
      await this.write(value);
      return { reused: false, value, delivery };
    });
    if (prepared.reused)
      return {
        accepted: !!prepared.delivery.taskId,
        reused: true,
        taskId: prepared.delivery.taskId,
        provider,
        status: prepared.delivery.status,
        task: { taskId: prepared.delivery.taskId, status: prepared.delivery.status, provider },
        context: this.public(prepared.value, true),
      };
    const packet = prepared.value.contextPacket,
      contract = prepared.value.dispatch;
    let task: Json = {},
      failure: unknown;
    try {
      task = await options.starter({
        provider,
        prompt: contract.prompt,
        cwd: packet.workspace?.cwd ?? '',
        attachments: contract.attachments,
        permission: contract.permission,
        submit: false,
        sessionId: options.sessionId ?? '',
        contextPacket: packet,
        contextPacketId: packet.packetId,
        contextPacketDigest: prepared.value.contextPacketDigest,
        privacy: contract.privacy,
      });
    } catch (error) {
      failure = error;
    }
    const context = await withFileLock(join(this.root, '.agent-contexts.lock'), async () => {
      const value = await this.read(id),
        delivery = value.deliveries.find(
          (item: Json) => item.deliveryId === prepared.delivery.deliveryId,
        );
      if (!delivery) throw new Error('Agent context delivery state disappeared');
      delivery.status = task.status ?? (failure ? 'failed' : 'verification_failed');
      delivery.taskId = task.taskId ?? null;
      value.updatedAt = delivery.updatedAt = new Date().toISOString();
      await this.write(value);
      return this.public(value);
    });
    if (failure) throw new Error(`Agent dispatch failed: ${String(failure)}`);
    return {
      accepted: !!task.taskId && ['queued', 'running'].includes(task.status),
      reused: false,
      taskId: task.taskId ?? null,
      provider,
      status: task.status ?? 'verification_failed',
      contextPacketId: packet.packetId,
      contextPacketDigest: prepared.value.contextPacketDigest,
      context,
      task,
    };
  }
}
export async function handleAgentContexts(
  payload: Json,
  userDataDir: string,
  options: { starter?: (payload: Json) => Promise<Json>; sessionId?: string } = {},
): Promise<Json> {
  const store = new AgentContextHandoffStore(join(userDataDir, 'agent-contexts'));
  if (payload.operation === 'agent.contexts.list') {
    const tasks = new ExternalTasks(userDataDir);
    return {
      ok: true,
      state: 'completed',
      contexts: await store.reconcile((id) => tasks.status(id), Number(payload.limit ?? 100)),
    };
  }
  if (payload.operation === 'agent.context.dispatch') {
    const id = String(payload.contextId),
      provider = String(payload.provider);
    if (payload.confirmed !== true)
      return { ok: true, state: 'confirmation_required', context: await store.get(id), provider };
    const dispatch = await store.dispatch(id, {
      provider,
      starter: options.starter ?? ((request) => dispatchExternal(request, userDataDir)),
      sessionId: options.sessionId,
    });
    return {
      ok: dispatch.accepted === true,
      state: dispatch.accepted ? 'accepted' : 'verification_failed',
      dispatch,
    };
  }
  throw new Error('Unknown context handoff operation');
}
export async function dispatchAgentPrompt(payload: Json, userDataDir: string): Promise<Json> {
  const prompt = String(payload.prompt ?? '').trim(),
    provider = String(payload.provider ?? '')
      .trim()
      .toLowerCase(),
    sessionId = String(payload.sessionId ?? '').trim(),
    packet = payload.contextPacket ?? payload.packet;
  if (!prompt) throw new Error('agent_prompt_missing');
  if (prompt.length > 60000) throw new Error('agent_prompt_too_large');
  if (!['codex', 'claude', 'gemini', 'pi'].includes(provider))
    throw new Error('agent_provider_invalid');
  if (!sessionId) throw new Error('agent_session_missing');
  if (!packet || packet.schemaVersion !== 2) throw new Error('context_packet_invalid');
  const settings = settingsStore(userDataDir).load(),
    sessions = await discoverExternalSessions({
      provider,
      cwd: packet.workspace?.cwd || userDataDir,
      cwdMatch: 'strict',
      includeMismatch: false,
      limit: 100,
      activeOnly: true,
    });
  if (
    !sessions.some(
      (item) => item.provider === provider && item.sessionId === sessionId && item.live === true,
    )
  )
    throw new Error('agent_session_not_live');
  const store = new AgentContextHandoffStore(join(userDataDir, 'agent-contexts')),
    sealed = await store.seal(packet, {
      prompt,
      attachments: (packet.artifacts ?? []).filter(
        (item: unknown): item is string => typeof item === 'string' && !!item.trim(),
      ),
      permission: 'write',
      privacy: packet.privacy ?? {},
    }),
    dispatch = await store.dispatch(sealed.contextId, {
      provider,
      sessionId,
      starter: (request) =>
        dispatchExternal(
          {
            ...request,
            deliveryMode: 'active_session',
            cwdMatch: settings.agents.cwdMatch ?? settings.agents.cwd_match,
            autoAttach: false,
            sessionId,
            submit: false,
          },
          userDataDir,
        ),
    });
  return {
    ok: dispatch.accepted === true,
    state: dispatch.accepted ? 'accepted' : 'verification_failed',
    contextId: sealed.contextId,
    dispatch,
    task: dispatch.task ?? {},
    error: dispatch.accepted ? null : 'agent_task_receipt_invalid',
    intentKind: 'agent_prompt_dispatched',
  };
}
