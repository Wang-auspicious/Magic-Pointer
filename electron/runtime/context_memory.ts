import { randomUUID } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { array, record, insidePath, fileSource, type Json, type SourceRef } from './context';
import { EventSession, withFileLock } from './session';
import { ArtifactRegistry, projectArtifacts } from './artifacts';

async function json(path: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
      return fallback;
    throw error;
  }
}
async function save(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
async function fileExists(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
export class ScreenMemory {
  constructor(
    readonly path: string,
    readonly enabled = false,
  ) {}
  async recall(
    query = '',
    options: { since?: number; until?: number; limit?: number; now?: number } = {},
  ): Promise<Json[]> {
    const now = options.now ?? Date.now() / 1000,
      needle = query.trim().toLowerCase();
    return array<Json>(record(await json(this.path, {})).entries)
      .filter(
        (entry) =>
          Number(entry.at) >= now - 86400 &&
          (options.since === undefined || Number(entry.at) >= options.since) &&
          (options.until === undefined || Number(entry.at) <= options.until) &&
          (!needle || `${entry.excerpt} ${entry.windowTitle}`.toLowerCase().includes(needle)),
      )
      .slice(0, Math.min(400, options.limit ?? 20))
      .map((entry) => ({
        ...entry,
        provenanceMissing: entry.provenanceMissing === true || !entry.sourceId || !entry.locator,
      }));
  }
  async record(value: Json): Promise<Json | null> {
    if (!this.enabled || value.sensitive) return null;
    const excerpt = String(value.excerpt ?? '')
        .trim()
        .slice(0, 400),
      windowTitle = String(value.windowTitle ?? '')
        .trim()
        .slice(0, 200);
    if (!excerpt && !windowTitle) return null;
    const entry = {
      id: randomUUID(),
      at: Date.now() / 1000,
      app: String(value.app ?? '').slice(0, 80),
      windowTitle,
      excerpt,
      sourceId: value.sourceId ?? null,
      locator: value.locator ?? null,
      provenanceMissing: !value.sourceId || !value.locator,
    };
    await withFileLock(`${this.path}.lock`, async () => {
      const entries = (await this.recall('', { limit: 400 })).filter(
        (item) =>
          !(
            item.excerpt === excerpt &&
            item.windowTitle === windowTitle &&
            item.sourceId === entry.sourceId &&
            isDeepStrictEqual(item.locator, entry.locator)
          ),
      );
      await save(this.path, { version: 2, entries: [entry, ...entries].slice(0, 400) });
    });
    return entry;
  }
  async clear(): Promise<number> {
    return withFileLock(`${this.path}.lock`, async () => {
      const entries = array(record(await json(this.path, {})).entries);
      await save(this.path, { version: 2, entries: [] });
      return entries.length;
    });
  }
}
export class ClipboardHistory {
  constructor(readonly path: string) {}
  async recent(limit = 20): Promise<Json[]> {
    return array<Json>(record(await json(this.path, {})).entries)
      .filter((entry) => entry.text && Number(entry.at) >= Date.now() / 1000 - 7 * 86400)
      .slice(0, Math.max(0, limit));
  }
  async record(
    text: string,
    options: { app?: string; formats?: string[]; secret?: boolean; now?: number } = {},
  ): Promise<Json | null> {
    if (!text.trim() || options.secret) return null;
    return withFileLock(`${this.path}.lock`, async () => {
      const entries = await this.recent(100),
        value = text.slice(0, 20000),
        prior = entries.find((entry) => entry.text === value),
        entry = {
          digest: prior?.digest ?? randomUUID(),
          text: value,
          at: options.now ?? Date.now() / 1000,
          app: options.app ?? '',
          formats: options.formats ?? [],
          truncated: text.length > 20000,
        };
      await save(this.path, {
        version: 1,
        entries: [entry, ...entries.filter((item) => item.text !== value)].slice(0, 100),
      });
      return entry;
    });
  }
  async search(query: string, limit = 20): Promise<Json[]> {
    return (await this.recent(100))
      .filter((entry) => String(entry.text).toLowerCase().includes(query.trim().toLowerCase()))
      .slice(0, Math.max(0, limit));
  }
  async get(id: string): Promise<Json | null> {
    return (await this.recent(100)).find((entry) => entry.digest === id) ?? null;
  }
  async clear(): Promise<number> {
    return withFileLock(`${this.path}.lock`, async () => {
      const count = (await this.recent(100)).length;
      await save(this.path, { version: 1, entries: [] });
      return count;
    });
  }
}
export class KnowledgeCatalog {
  constructor(readonly indexPath: string) {}
  async entries(): Promise<Json[]> {
    return array<Json>(await json(this.indexPath, []))
      .filter((entry) => entry.id)
      .map((entry) => ({
        entryId: entry.id,
        sourceId: entry.sourceId ?? `knowledge:${entry.id}`,
        locator: entry.locator ?? { kind: 'text', value: { knowledgeEntryId: entry.id } },
        title:
          (entry.desc ?? entry.elementName ?? basename(String(entry.originalArtifactPath ?? ''))) ||
          '收藏材料',
        summary: String(entry.summary ?? entry.text ?? '').slice(0, 4000),
        userCategory: entry.userCategory ?? entry.kind ?? '',
        originalArtifactPath: entry.originalArtifactPath ?? '',
        retainedArtifactPath: entry.relPath
          ? resolve(dirname(this.indexPath), String(entry.relPath))
          : '',
        sourceTimeMs: Number(entry.sourceTimeMs ?? entry.capturedAt ?? 0),
        addedAtMs: Number(entry.capturedAt ?? 0),
        media: entry.media ?? 'file',
      }))
      .sort((a, b) => b.addedAtMs - a.addedAtMs);
  }
  async search(query = '', category?: string, limit = 20): Promise<Json[]> {
    const needle = query.toLowerCase();
    return (await this.entries())
      .filter(
        (entry) =>
          (!category || String(entry.userCategory).toLowerCase() === category.toLowerCase()) &&
          (!needle ||
            [entry.title, entry.summary, entry.userCategory, entry.originalArtifactPath].some(
              (value) => String(value).toLowerCase().includes(needle),
            )),
      )
      .slice(0, Math.max(0, Math.min(limit, 100)));
  }
  async resolve(id: string, taskId: string): Promise<Json & { source: SourceRef }> {
    const entry = (await this.entries()).find((entry) => entry.entryId === id);
    if (!entry) throw new Error('Unknown knowledge entry');
    const original = String(entry.originalArtifactPath),
      retained = String(entry.retainedArtifactPath),
      originalExists = await fileExists(original),
      retainedExists = await fileExists(retained),
      path = originalExists ? original : retained || original,
      evidenceState = originalExists
        ? 'original'
        : retainedExists
          ? 'retained_evidence'
          : 'missing',
      source = fileSource(taskId, path);
    source.sourceId = String(entry.sourceId);
    source.title = String(entry.title);
    source.identity = {
      ...source.identity,
      knowledgeEntryId: id,
      originalArtifactPath: original,
      evidenceState,
    };
    source.revision = { sourceTimeMs: entry.sourceTimeMs, addedAtMs: entry.addedAtMs };
    source.capabilities = ['read', 'search'];
    return {
      entry,
      source,
      locator: entry.locator,
      available: evidenceState !== 'missing',
      unavailableReason: evidenceState === 'missing' ? 'artifact_missing' : null,
      evidenceState,
    };
  }
  async remove(id: string): Promise<boolean> {
    return withFileLock(`${this.indexPath}.lock`, async () => {
      const entries = array<Json>(await json(this.indexPath, [])),
        entry = entries.find((entry) => entry.id === id);
      if (!entry) return false;
      await save(
        this.indexPath,
        entries.filter((entry) => entry.id !== id),
      );
      const retained = entry.relPath ? resolve(dirname(this.indexPath), String(entry.relPath)) : '';
      if (
        retained &&
        insidePath(retained, dirname(this.indexPath)) &&
        retained !== resolve(String(entry.originalArtifactPath ?? ''))
      )
        await unlink(retained).catch(() => {});
      return true;
    });
  }
}
export class ConversationEventCatalog {
  constructor(readonly userDataDir: string) {}
  async summaries(
    fromMs: number,
    toMs: number,
    conversationIds: string[] = [],
    limit = 200,
  ): Promise<Json> {
    if (fromMs < 0 || toMs < fromMs) throw new Error('Invalid DailyWrap time range');
    const conversations = array<Json>(
        await json(join(this.userDataDir, 'history', 'conversations.json'), []),
      ),
      selected = new Set(conversationIds),
      included = new Set<string>(),
      events: Json[] = [];
    for (const conversation of conversations) {
      if (selected.size && !selected.has(String(conversation.id))) continue;
      let authoritative = new Map<string, unknown>();
      if (conversation.agentSessionId) {
        try {
          const session = await EventSession.open(
            this.userDataDir,
            String(conversation.agentSessionId),
            false,
          );
          authoritative = new Map(
            projectArtifacts(session.events).map((draft) => [
              draft.artifactId,
              { ...draft, authority: 'event_session' },
            ]),
          );
        } catch {}
      }
      for (const turn of array<Json>(conversation.turns)) {
        const startedAt = Number(turn.startedAt ?? turn.at ?? 0),
          completedAt = turn.completedAt === undefined ? null : Number(turn.completedAt),
          observed = completedAt ?? startedAt;
        if (observed < fromMs || observed > toMs) continue;
        included.add(String(conversation.id));
        events.push({
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          turnId: turn.id,
          startedAt,
          completedAt,
          question: String(turn.question ?? '').slice(0, 4000),
          answer: String(turn.answer ?? '').slice(0, 12000),
          outcome: turn.outcome,
          source: record(conversation.object),
          events: array(turn.events).slice(0, 48),
          receipts: array(turn.receipts).slice(0, 48),
          artifacts: array<Json>(turn.artifacts)
            .slice(0, 24)
            .map((artifact) => authoritative.get(String(artifact.artifactId)) ?? artifact),
          evidence: turn.evidence ?? null,
        });
      }
    }
    events.sort(
      (a, b) => Number(b.completedAt ?? b.startedAt) - Number(a.completedAt ?? a.startedAt),
    );
    const bounded = events.slice(0, Math.max(0, Math.min(limit, 500)));
    return {
      fromMs,
      toMs,
      conversationIds,
      materialAvailable: !!bounded.length,
      events: bounded,
      coverage: {
        includedConversations: included.size,
        includedTurns: bounded.length,
        complete: bounded.length === events.length,
        message: bounded.length
          ? `已纳入 ${bounded.length} 条真实任务记录。`
          : '所选时间和任务范围没有纳入本次材料；不要补造全天活动。',
      },
    };
  }
}
export class ObjectStore {
  constructor(readonly root: string) {}
  async append(object: Json): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(join(this.root, 'objects.jsonl'), `${JSON.stringify(object)}\n`);
  }
  async objects(): Promise<Json[]> {
    let raw = '';
    try {
      raw = await readFile(join(this.root, 'objects.jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [record(JSON.parse(line))];
        } catch {
          return [];
        }
      });
  }
  async recent(limit = 5): Promise<Json[]> {
    return limit > 0 ? (await this.objects()).reverse().slice(0, limit) : [];
  }
  async objectById(id: string): Promise<Json | null> {
    return (await this.objects()).reverse().find((object) => object.id === id) ?? null;
  }
}
export class TaskContextStore {
  readonly path: string;
  constructor(
    root: string,
    private idleTimeoutMinutes = 30,
  ) {
    this.path = join(root, 'task_state.json');
  }
  private newTask(): Json {
    const now = new Date().toISOString();
    return {
      id: `task_${randomUUID()}`,
      created_at: now,
      updated_at: now,
      object_ids: [],
      messages: [],
      destination_id: null,
    };
  }
  private async state(): Promise<Json> {
    const state = record(await json(this.path, {})),
      tasks = record(state.tasks);
    if (!tasks[String(state.active_task_id)]) {
      const task = this.newTask();
      tasks[String(task.id)] = task;
      state.active_task_id = task.id;
    }
    return { ...state, tasks };
  }
  async activeTask(autoRollover = true): Promise<Json> {
    return withFileLock(`${this.path}.lock`, async () => {
      const state = await this.state(),
        tasks = record(state.tasks);
      let task = record(tasks[String(state.active_task_id)]),
        rolledOver = false;
      if (
        autoRollover &&
        Date.now() - Date.parse(String(task.updated_at)) > this.idleTimeoutMinutes * 60000
      ) {
        state.previous_task_id = task.id;
        task = this.newTask();
        state.active_task_id = task.id;
        tasks[String(task.id)] = task;
        rolledOver = true;
      }
      await save(this.path, state);
      return { task, rolled_over: rolledOver };
    });
  }
  async startNewTask(): Promise<Json> {
    return withFileLock(`${this.path}.lock`, async () => {
      const state = await this.state(),
        task = this.newTask();
      state.previous_task_id = state.active_task_id;
      state.active_task_id = task.id;
      record(state.tasks)[String(task.id)] = task;
      await save(this.path, state);
      return task;
    });
  }
  async restorePreviousTask(): Promise<Json | null> {
    return withFileLock(`${this.path}.lock`, async () => {
      const state = await this.state(),
        tasks = record(state.tasks),
        previous = state.previous_task_id;
      if (!tasks[String(previous)]) return null;
      state.previous_task_id = state.active_task_id;
      state.active_task_id = previous;
      const task = record(tasks[String(previous)]);
      task.updated_at = new Date().toISOString();
      await save(this.path, state);
      return task;
    });
  }
  async updateTask(
    id: string,
    patch: { objectId?: string; prompt?: string; answer?: string; destinationId?: string | null },
  ): Promise<Json> {
    return withFileLock(`${this.path}.lock`, async () => {
      const state = await this.state(),
        tasks = record(state.tasks),
        task = record(tasks[id] ?? { ...this.newTask(), id }),
        objects = new Set(array<string>(task.object_ids));
      if (patch.objectId) objects.add(patch.objectId);
      if (patch.destinationId) objects.add(patch.destinationId);
      task.object_ids = [...objects];
      if (patch.destinationId !== undefined) task.destination_id = patch.destinationId;
      if (patch.prompt !== undefined)
        task.messages = [
          ...array(task.messages),
          {
            object_id: patch.objectId,
            prompt: patch.prompt,
            answer: patch.answer ?? '',
            created_at: new Date().toISOString(),
          },
        ];
      task.updated_at = new Date().toISOString();
      tasks[id] = task;
      state.active_task_id = id;
      await save(this.path, state);
      return task;
    });
  }
  async getTask(id: string): Promise<Json | null> {
    return (record((await this.state()).tasks)[id] as Json) ?? null;
  }
  async taskObjects(store: ObjectStore, id: string): Promise<Json[]> {
    const task = await this.getTask(id),
      objects = await Promise.all(
        array<string>(task?.object_ids).map((objectId) => store.objectById(objectId)),
      );
    return objects.filter((item): item is Json => !!item);
  }
}
export class ProvenanceIndex {
  readonly path: string;
  constructor(readonly root: string) {
    this.path = join(root, 'provenance-executions.jsonl');
  }
  async recordExecution(plan: Json, receipt: Json): Promise<Json> {
    if (!receipt.id && !receipt.receiptId) throw new Error('Execution receipt id required');
    const value = {
      schemaVersion: 1,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      planId: plan.id,
      receiptId: receipt.id ?? receipt.receiptId,
      taskId: record(receipt.output).taskId ?? plan.taskId ?? '',
      recipeId: plan.recipe_id ?? plan.recipeId,
      provider: plan.provider,
      status: receipt.status,
      objects: array<Json>(record(plan.parameters).objects).map((object) => ({
        objectId: object.id ?? object.objectId,
        referenceLabel: object.referenceLabel,
        kind: object.kind,
        label: object.label,
        bbox: object.bbox,
        source: object.source,
      })),
    };
    await mkdir(this.root, { recursive: true });
    await appendFile(this.path, `${JSON.stringify(value)}\n`);
    return value;
  }
  private async records(): Promise<Json[]> {
    let raw = '';
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [record(JSON.parse(line))];
        } catch {
          return [];
        }
      });
  }
  async objects(limit = 200): Promise<Json[]> {
    const objects = new Map<string, Json>();
    for (const event of await this.records())
      for (const item of array<Json>(event.objects))
        objects.set(String(item.objectId), {
          ...item,
          lastPlanId: event.planId,
          lastTaskId: event.taskId,
          lastStatus: event.status,
          updatedAt: event.timestamp,
        });
    return [...objects.values()].reverse().slice(0, limit);
  }
  async trace(id: string): Promise<Json> {
    const records = (await this.records()).filter((event) =>
        array<Json>(event.objects).some((object) => object.objectId === id),
      ),
      artifacts = (await new ArtifactRegistry(this.root).list(500)).filter(
        (artifact) =>
          array<string>(artifact.sourceObjectIds).includes(id) || artifact.sourceId === id,
      );
    if (!records.length && !artifacts.length) throw new Error('Object provenance not found');
    return {
      object: (await this.objects(10000)).find((object) => object.objectId === id) ?? {
        objectId: id,
      },
      plans: records.reverse(),
      artifacts,
    };
  }
}
