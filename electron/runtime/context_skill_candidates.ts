import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, appendFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { array, record, insidePath } from './context';
import { contentHash } from './artifacts';
import { withFileLock } from './session';
import { ExternalTasks } from './external';
type Json = Record<string, any>;
const now = () => new Date().toISOString();
const token = (value: unknown) =>
  String(value ?? '')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .slice(0, 120)
    .replace(/^-|-$/g, '');
const equalToken = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function atomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}
export class SkillCandidateStore {
  readonly path: string;
  constructor(
    readonly root: string,
    readonly threshold = 3,
  ) {
    this.path = join(root, 'skill-candidates.json');
    if (threshold < 3) throw new Error('Candidate threshold must be at least three');
  }
  private async read(): Promise<Json> {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      if (state.schemaVersion !== 1 || !state.observations || !state.candidates)
        throw new Error('Invalid Skill candidate state');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schemaVersion: 1, observations: {}, candidates: {} };
      throw error;
    }
  }
  private public(candidate: Json): Json {
    const {
      reviewTokenDigest: _reviewTokenDigest,
      reviewedDraftSha256: _reviewedDraftSha256,
      reviewIssuedAt: _reviewIssuedAt,
      installConfirmationDigest: _installConfirmationDigest,
      confirmationIssuedAt: _confirmationIssuedAt,
      ...value
    } = candidate;
    return { ...value, enabled: false };
  }
  private draftPath(id: string): string {
    if (!/^skill-[0-9a-f]{16}$/.test(id)) throw new Error('Invalid Skill candidate id');
    return join(this.root, 'skill-candidates', id, 'SKILL.md');
  }
  private async audit(type: string, data: Json): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(
      join(this.root, 'fabric-audit.jsonl'),
      `${JSON.stringify({ type, data, timestamp: now() })}\n`,
    );
  }
  private semantic(plan: Json): Json | null {
    const recipe = plan.recipe_id ?? plan.recipeId;
    if (!['agent.handoff', 'agent.background_task'].includes(recipe)) return null;
    const p = record(plan.parameters),
      runtime = record(record(p.contextPacket).runtime),
      nested = (key: string) => record(p[key] ?? runtime[key]),
      workspace = record(p.runtimeWorkspace ?? record(p.contextPacket).workspace),
      objectKinds = [
        ...new Set(array<Json>(p.objects).map((item) => token(item.kind || 'grounded_object'))),
      ]
        .sort()
        .slice(0, 12),
      terminalMethod = token(nested('terminalEvidence').method),
      browserMethod = token(nested('browserContext').method),
      componentMethod = token(nested('componentLink').method),
      workspaceRelation = token(workspace.bindingRelation ?? workspace.bindingState),
      steps = [
        'freeze_grounded_objects',
        ...(workspaceRelation ? ['bind_runtime_workspace'] : []),
        ...(terminalMethod ? ['collect_terminal_evidence'] : []),
        ...(browserMethod ? ['collect_browser_evidence'] : []),
        ...(componentMethod ? ['resolve_component_source'] : []),
        'dispatch_context_packet',
        'verify_agent_terminal_status',
      ];
    return {
      recipeId: recipe,
      risk: plan.risk,
      objectKinds: objectKinds.length ? objectKinds : ['grounded_object'],
      terminalMethod,
      browserMethod,
      componentMethod,
      workspaceRelation,
      steps,
    };
  }
  private draftContent(candidate: Json): string {
    const steps: Json = {
      freeze_grounded_objects: 'Freeze the pointed objects and retain their stable identifiers.',
      bind_runtime_workspace: 'Bind the workspace using verified runtime process evidence.',
      collect_terminal_evidence: 'Read the bounded terminal error and observed exit state.',
      collect_browser_evidence: 'Read the pointed DOM reference and bounded browser evidence.',
      resolve_component_source: 'Inspect component source candidates before editing.',
      dispatch_context_packet: 'Deliver one Context Packet through the chosen channel.',
      verify_agent_terminal_status: 'Read durable terminal task status and verify outputs.',
    };
    return `---\nname: ${candidate.name}\ndescription: Replay a reviewed Magic Pointer workflow over ${candidate.objectKinds.join(', ')}. Human review required; installation does not enable it.\nmetadata:\n  magic_pointer_state: candidate_disabled\n  source_execution_count: ${candidate.occurrenceCount}\n---\n\n# ${candidate.name}\n\n## Inputs\n\nA current grounded Context Packet and verified runtime evidence. Read current context through normal permissions; do not reconstruct private screen content from the learning record.\n\n## Workflow\n\n${candidate.steps.map((step: string, index: number) => `${index + 1}. ${steps[step] ?? step}`).join('\n')}\n\n## Safety and verification\n\nKeep target lease, capture, permission and confirmation gates active. Treat candidate paths as hints until verified. Accepted or queued is not completed. Require durable terminal status and output provenance. Preserve failures honestly. Never install or enable another Skill.\n\n## Source executions\n\n${candidate.sourceReceiptIds.map((id: string) => `- receipt ${id}`).join('\n')}\n`;
  }
  private async reconcile(state: Json): Promise<void> {
    const tasks = new ExternalTasks(this.root);
    for (const observation of Object.values(state.observations) as Json[])
      if (observation.outcome === 'pending_agent') {
        try {
          const task = await tasks.status(observation.taskId);
          if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
            observation.outcome = task.status === 'succeeded' ? 'succeeded' : 'failed';
            observation.completedAt = task.updatedAt ?? now();
          }
        } catch {}
      }
    const groups = new Map<string, Json[]>();
    for (const observation of Object.values(state.observations) as Json[])
      if (observation.outcome === 'succeeded')
        groups.set(observation.signature, [
          ...(groups.get(observation.signature) ?? []),
          observation,
        ]);
    for (const [signature, observations] of groups) {
      const id = `skill-${signature.slice(0, 16)}`;
      if (observations.length < this.threshold || state.candidates[id]) continue;
      const sources = observations
          .sort((a, b) =>
            String(a.completedAt ?? a.observedAt).localeCompare(
              String(b.completedAt ?? b.observedAt),
            ),
          )
          .slice(0, this.threshold),
        semantic = sources[0].semantic,
        candidate: Json = {
          candidateId: id,
          name: `mp-${token(semantic.recipeId.replace(/\./g, '-')).toLowerCase()}-${signature.slice(0, 8)}`,
          recipeId: semantic.recipeId,
          state: 'candidate_disabled',
          enabled: false,
          occurrenceCount: sources.length,
          threshold: this.threshold,
          objectKinds: semantic.objectKinds,
          steps: semantic.steps,
          providers: [...new Set(sources.map((value) => value.provider).filter(Boolean))],
          sourcePlanIds: sources.map((value) => value.planId),
          sourceReceiptIds: sources.map((value) => value.receiptId),
          sourceTaskIds: sources.map((value) => value.taskId).filter(Boolean),
          createdAt: now(),
          installedAt: null,
          installedPath: null,
        };
      const content = this.draftContent(candidate);
      candidate.draftSha256 = contentHash(content);
      await atomic(this.draftPath(id), content);
      state.candidates[id] = candidate;
      await this.audit('skill.candidate_created', {
        candidateId: id,
        recipeId: candidate.recipeId,
        occurrenceCount: sources.length,
        state: candidate.state,
      });
    }
  }
  async observeExecution(plan: Json, receipt: Json): Promise<Json> {
    const semantic = this.semantic(plan);
    if (!semantic) return { eligible: false, progress: 0, candidate: null };
    if (!receipt.id) throw new Error('Execution receipt id required');
    return withFileLock(`${this.path}.lock`, async () => {
      const state = await this.read(),
        taskId = String(record(receipt.output).taskId ?? ''),
        signature = contentHash(JSON.stringify(semantic)),
        previous = state.observations[receipt.id];
      if (
        previous &&
        (previous.planId !== plan.id ||
          !isDeepStrictEqual(previous.semantic, semantic) ||
          previous.taskId !== taskId)
      )
        throw new Error('Skill observation receipt id collision');
      if (!previous)
        state.observations[receipt.id] = {
          observationId: randomUUID(),
          signature,
          semantic,
          planId: plan.id,
          receiptId: receipt.id,
          taskId,
          recipeId: semantic.recipeId,
          provider: token(plan.provider),
          outcome:
            receipt.status === 'succeeded' && receipt.verified === true
              ? 'succeeded'
              : receipt.status === 'accepted' && taskId
                ? 'pending_agent'
                : 'failed',
          observedAt: now(),
        };
      await this.reconcile(state);
      await atomic(this.path, JSON.stringify(state));
      const candidate = state.candidates[`skill-${signature.slice(0, 16)}`];
      return {
        eligible: true,
        progress: Math.min(
          this.threshold,
          (Object.values(state.observations) as Json[]).filter(
            (item) => item.signature === signature && item.outcome === 'succeeded',
          ).length,
        ),
        threshold: this.threshold,
        candidate: candidate ? this.public(candidate) : null,
      };
    });
  }
  async list(limit = 100): Promise<Json[]> {
    return withFileLock(`${this.path}.lock`, async () => {
      const state = await this.read();
      await this.reconcile(state);
      await atomic(this.path, JSON.stringify(state));
      return (Object.values(state.candidates) as Json[])
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.min(500, Math.max(0, limit)))
        .map((candidate) => this.public(candidate));
    });
  }
  async draft(id: string): Promise<Json> {
    return withFileLock(`${this.path}.lock`, async () => {
      const state = await this.read(),
        candidate = state.candidates[id];
      if (!candidate) throw new Error('Unknown Skill candidate id');
      const path = this.draftPath(id),
        content = await readFile(path, 'utf8');
      if (contentHash(content) !== candidate.draftSha256)
        throw new Error('Skill candidate draft digest mismatch');
      const reviewToken = randomBytes(32).toString('base64url');
      Object.assign(candidate, {
        reviewTokenDigest: contentHash(reviewToken),
        reviewedDraftSha256: candidate.draftSha256,
        reviewIssuedAt: now(),
      });
      delete candidate.installConfirmationDigest;
      delete candidate.confirmationIssuedAt;
      await atomic(this.path, JSON.stringify(state));
      return {
        candidate: this.public(candidate),
        content,
        draftPath: path,
        sha256: candidate.draftSha256,
        reviewToken,
      };
    });
  }
  async install(id: string, confirmed: boolean, reviewToken: string): Promise<Json> {
    return withFileLock(`${this.path}.lock`, async () => {
      const state = await this.read(),
        candidate = state.candidates[id];
      if (!candidate) throw new Error('Unknown Skill candidate id');
      const content = await readFile(this.draftPath(id), 'utf8'),
        digest = contentHash(reviewToken);
      if (contentHash(content) !== candidate.draftSha256)
        throw new Error('Skill candidate draft digest mismatch');
      if (
        !candidate.reviewTokenDigest ||
        !equalToken(candidate.reviewTokenDigest, digest) ||
        candidate.reviewedDraftSha256 !== candidate.draftSha256
      )
        throw new Error('Skill draft review is required');
      if (!confirmed) {
        candidate.installConfirmationDigest = digest;
        candidate.confirmationIssuedAt = now();
        await atomic(this.path, JSON.stringify(state));
        return {
          status: 'confirmation_required',
          candidate: this.public(candidate),
          draftSha256: candidate.draftSha256,
        };
      }
      if (!equalToken(String(candidate.installConfirmationDigest ?? ''), digest))
        throw new Error('Skill installation confirmation is required');
      const managed = join(this.root, 'managed-skills'),
        target = resolve(managed, candidate.name, 'SKILL.md');
      if (!insidePath(target, managed)) throw new Error('Invalid managed Skill path');
      let reused = false;
      try {
        if ((await readFile(target, 'utf8')) !== content)
          throw new Error('Managed Skill collision');
        reused = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await atomic(target, content);
      }
      Object.assign(candidate, {
        state: 'installed_disabled',
        enabled: false,
        installedAt: candidate.installedAt ?? now(),
        installedPath: target,
      });
      for (const key of [
        'reviewTokenDigest',
        'reviewedDraftSha256',
        'reviewIssuedAt',
        'installConfirmationDigest',
        'confirmationIssuedAt',
      ])
        delete candidate[key];
      await atomic(this.path, JSON.stringify(state));
      await this.audit('skill.candidate_installed', {
        candidateId: id,
        recipeId: candidate.recipeId,
        state: candidate.state,
        enabled: false,
        reused,
      });
      return {
        status: 'installed_disabled',
        candidate: this.public(candidate),
        installedPath: target,
        reused,
      };
    });
  }
}
export async function handleSkillCandidates(payload: Json, userDataDir: string): Promise<Json> {
  const store = new SkillCandidateStore(userDataDir);
  if (payload.operation === 'skills.candidates.list')
    return {
      ok: true,
      state: 'completed',
      candidates: await store.list(Number(payload.limit ?? 100)),
    };
  if (payload.operation === 'skills.candidates.draft')
    return { ok: true, state: 'completed', draft: await store.draft(String(payload.candidateId)) };
  if (payload.operation === 'skills.candidates.install') {
    const install = await store.install(
      String(payload.candidateId),
      payload.confirmed === true,
      String(payload.reviewToken ?? ''),
    );
    return { ok: true, state: install.status, install };
  }
  throw new Error('Unknown Skill candidate operation');
}
