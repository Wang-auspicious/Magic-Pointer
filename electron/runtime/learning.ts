import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withFileLock } from './session';
import { requestText, type ModelConfig } from './model';

type Data = Record<string, any>;
const roots: Record<string, string> = { memory: 'learning', skill: 'skills', plugin: 'plugins' };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function readJson(file: string, fallback: any = null): any {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
export function writeAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

export function redactSecrets(value: string): string {
  return value.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/(\bauthorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(\b[\w.-]*(?:api[_-]?key|token|secret|password|passwd|pwd|passphrase|credential)[\w.-]*\b\s*["']?\s*[:=]\s*["']?)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16})/g, '[REDACTED]');
}

export class LearningStore {
  readonly state: string;
  constructor(readonly userRoot: string) { this.state = join(userRoot, 'self-evolution'); }
  private file(id: string): string { if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid candidate ID'); return join(this.state, 'candidates', `${id}.json`); }
  private target(kind: string, target: string): string {
    const path = resolve(this.userRoot, target), rel = relative(this.userRoot, path).replace(/\\/g, '/');
    if (!roots[kind] || isAbsolute(target) || rel.startsWith('../') || !rel.startsWith(`${roots[kind]}/`)) throw new Error('Learning target is outside its user-owned directory');
    return path;
  }
  get(id: string): Data {
    const item = readJson(this.file(id));
    if (!item) throw new Error(`Unknown candidate ${id}`);
    if (item.id !== id || digest(item.original_content) !== item.old_hash || digest(item.proposed_content) !== item.new_hash) throw new Error('Candidate content changed');
    return item;
  }
  list(status?: string): Data[] {
    const directory = join(this.state, 'candidates');
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-f0-9]{24}\.json$/.test(name)).map(name => this.get(basename(name, '.json')))
      .filter(item => !status || item.status === status).sort((a, b) => a.created_at_ms - b.created_at_ms);
  }
  private save(item: Data, action: string): Data {
    writeAtomic(this.file(item.id), item);
    appendFileSync(join(this.state, 'audit.jsonl'), `${JSON.stringify({ time: Date.now(), candidateId: item.id, sessionId: item.session_id, target: item.target, action, approvedBy: item.approved_by || 'background_review', oldHash: item.old_hash, newHash: item.new_hash })}\n`);
    return item;
  }
  propose(input: { sessionId: string; kind: string; target: string; proposedContent: string; rationale: string }): Promise<Data> {
    return withFileLock(join(this.state, 'mutation'), async () => {
      const target = this.target(input.kind, input.target);
      if (!input.proposedContent || !input.rationale.trim()) throw new Error('Candidate requires content and rationale');
      const original = existsSync(target) ? readFileSync(target, 'utf8') : '';
      const prior = this.list('pending').find(item => item.kind === input.kind && item.target === input.target && item.original_content === original && item.proposed_content === input.proposedContent);
      if (prior) return prior;
      return this.save({ id: randomBytes(12).toString('hex'), session_id: input.sessionId, kind: input.kind, target: input.target,
        proposed_content: input.proposedContent, original_content: original, rationale: input.rationale, old_hash: digest(original), new_hash: digest(input.proposedContent),
        target_existed: existsSync(target), created_at_ms: Date.now(), status: 'pending', approved_by: '', decided_at_ms: 0, decision_reason: '', backup_path: '' }, 'proposed');
    });
  }
  mutate(id: string, action: string, reason = ''): Promise<Data> {
    return withFileLock(join(this.state, 'mutation'), async () => {
      const item = this.get(id), target = this.target(item.kind, item.target);
      if (item.status !== (action === 'rollback' ? 'applied' : 'pending')) throw new Error(`Candidate is ${item.status}`);
      const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
      if (action === 'apply') {
        if (current !== item.original_content) throw new Error('Target changed since review');
        item.backup_path = join(this.state, 'backups', `${id}.bak`);
        writeAtomic(item.backup_path, current);
        writeAtomic(target, item.proposed_content);
        item.status = 'applied';
      } else if (action === 'rollback') {
        if (current !== item.proposed_content) throw new Error('Target changed after application');
        const backup = join(this.state, 'backups', `${id}.bak`);
        if (resolve(item.backup_path) !== resolve(backup) || readFileSync(backup, 'utf8') !== item.original_content) throw new Error('Candidate backup changed');
        if (item.target_existed) writeAtomic(target, item.original_content); else if (existsSync(target)) unlinkSync(target);
        item.status = 'rolled_back';
      } else if (action === 'reject') { item.status = 'rejected'; item.decision_reason = reason; }
      else throw new Error(`Unknown candidate action ${action}`);
      item.approved_by = 'user'; item.decided_at_ms = Date.now();
      return this.save(item, item.status);
    });
  }
}

function summary(item: Data): Data {
  const { original_content, proposed_content, ...rest } = item;
  return { ...rest, originalChars: [...original_content].length, proposedChars: [...proposed_content].length };
}

export async function handleLearning(payload: Data, userRoot: string): Promise<Data> {
  const store = new LearningStore(userRoot), action = String(payload.action || 'list');
  if (action === 'list') return { ok: true, candidates: store.list(payload.status).map(summary) };
  const id = String(payload.candidateId || '');
  if (action === 'get') {
    const candidate = store.get(id);
    const diff = `--- a/${candidate.target}\n+++ b/${candidate.target}\n${candidate.original_content.split('\n').map((line: string) => `-${line}`).join('\n')}\n${candidate.proposed_content.split('\n').map((line: string) => `+${line}`).join('\n')}\n`;
    return { ok: true, candidate, diff };
  }
  if (payload.userApproved !== true) throw new Error('Explicit user approval is required');
  return { ok: true, candidate: summary(await store.mutate(id, action, payload.reason || '')) };
}

export async function reviewLearning(userRoot: string, sessionId: string, messages: Data[], terminalReason: string, config: ModelConfig, signal?: AbortSignal): Promise<Data> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new Error('Invalid session ID');
  const context = [redactSecrets(JSON.stringify({ sessionId, terminalReason, messages })).slice(0, 30000)];
  for (const directory of ['learning', 'skills', 'plugins']) {
    const base = join(userRoot, directory);
    if (!existsSync(base)) continue;
    const queue = [base];
    let count = 0;
    while (queue.length && count < 32) {
      const next = queue.shift()!;
      for (const entry of readdirSync(next, { withFileTypes: true })) {
        const path = join(next, entry.name);
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile() && /\.(md|txt|json|ts|js)$/.test(entry.name)) { context.push(`[USER FILE ${relative(userRoot, path)}]\n${redactSecrets(readFileSync(path, 'utf8')).slice(0, 1200)}`); count++; }
      }
    }
  }
  const reply = await requestText(config, { signal, timeoutMs: 30000, attempts: 1,
    prompt: 'Review this completed Agent session for durable user corrections or reusable techniques. Return JSON only: at most 3 objects {kind: memory|skill|plugin, target: learning/MEMORY.md or skills/<name>/SKILL.md or plugins/<name>/<file>, proposedContent: complete new UTF-8 file content, rationale}. Never learn one-off task narratives, temporary failures, secrets, or blanket negative claims. Output becomes pending and needs user approval. Return [] if nothing durable.',
    context: context.join('\n\n').slice(0, 60000) });
  const raw = JSON.parse(reply.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  const candidates = Array.isArray(raw) ? raw : raw.candidates;
  if (!Array.isArray(candidates)) throw new Error('Learning review must return an array');
  const store = new LearningStore(userRoot), candidateIds: string[] = [], warnings: string[] = [];
  for (const item of candidates.slice(0, 3)) {
    try {
      if (typeof item.proposedContent !== 'string' || item.proposedContent.length > 100000) throw new Error('Invalid candidate content');
      candidateIds.push((await store.propose({ ...item, sessionId })).id);
    } catch (error) { warnings.push(String(error)); }
  }
  const result = { ok: true, sessionId, candidateIds, warnings, completedAt: Date.now() };
  writeAtomic(join(userRoot, 'self-evolution', 'reviews', `${sessionId}.json`), result);
  return result;
}
