import type {ProjectRecord} from '../project_store';
import type {ProjectChannelStore} from '../project_channel_store';
import type {
  ProjectDecisionOption,
  ProjectPublishedArtifact,
  ProjectRosterWorker,
  ProjectThreadRecord,
} from '../project_multiagent_types';
import {deriveThreadStatus} from '../project_thread_state';
import type {ProjectWorktreeManager} from '../project_worktree_manager';
import type {ToolRegistry, ToolSpec} from './tools';

export const MAX_AUTO_MODE_RULES = 50;
export const WORKER_DISPATCH_STAGGER_MS = 750;
export const MAX_PROJECT_RATE_LIMIT_RETRIES = 2;
export const PROJECT_RATE_LIMIT_RETRY_DELAYS_MS = [2500, 6000] as const;

export function projectRunKey(projectId: string, threadId?: string): string {
  return `${projectId}:${threadId || 'coordinator'}`;
}

export function enqueuePendingProjectRun<T extends {question: string}>(
  queue: T[],
  next: T,
): {queued: boolean; queuedCount: number} {
  const tail = queue.at(-1);
  if (tail && tail.question.trim() === next.question.trim()) {
    return {queued: false, queuedCount: queue.length};
  }
  queue.push(next);
  return {queued: true, queuedCount: queue.length};
}

export function computeWorkerStaggerDelayMs(
  lastDispatchAt: number | undefined,
  nowMs: number,
  staggerMs = WORKER_DISPATCH_STAGGER_MS,
): {delayMs: number; scheduledAt: number} {
  if (!lastDispatchAt || nowMs - lastDispatchAt >= staggerMs) {
    return {delayMs: 0, scheduledAt: nowMs};
  }
  const scheduledAt = lastDispatchAt + staggerMs;
  return {delayMs: Math.max(0, scheduledAt - nowMs), scheduledAt};
}

export function isRetryableRateLimitError(errorText: unknown): boolean {
  return /\b429\b|http_429|rate_limit|ratelimit|too many requests/i.test(
    String(errorText || ''),
  );
}

export function formatRateLimitExceededError(
  modelName: string,
  rawError?: string,
): string {
  const modelLabel = String(modelName || '').trim() || 'current model';
  const base = `Rate limit exceeded (HTTP 429) on ${modelLabel}. Switch models in the composer or retry shortly.`;
  const cleaned = String(rawError || '')
    .replace(/\{[\s\S]*\}/g, '')
    .replace(/\s+at\s+\S+.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || /^backend_error:http_429$/i.test(cleaned)) {
    return base;
  }
  const detail = cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
  return `${base} (${detail})`;
}

export interface ProjectCoordinatorToolDeps {
  project: ProjectRecord;
  channelStore: ProjectChannelStore;
  worktreeManager?: ProjectWorktreeManager;
  onStartThread?: (
    thread: ProjectThreadRecord,
    prompt: string,
  ) => Promise<void> | void;
  onMessageThread?: (
    thread: ProjectThreadRecord,
    message: string,
  ) => Promise<void> | void;
}

export interface AutoModeRuleValidation {
  ok: boolean;
  error?: 'invalid_auto_mode_rule' | 'too_many_auto_mode_rules';
  max: number;
}

export interface AutoModeEvaluation {
  allowed: boolean;
  matchedRule?: string;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function validateAutoModeRules(
  rules: readonly string[],
): AutoModeRuleValidation {
  if (!Array.isArray(rules)) {
    return {ok: false, error: 'invalid_auto_mode_rule', max: MAX_AUTO_MODE_RULES};
  }
  if (rules.length > MAX_AUTO_MODE_RULES) {
    return {
      ok: false,
      error: 'too_many_auto_mode_rules',
      max: MAX_AUTO_MODE_RULES,
    };
  }
  for (const rule of rules) {
    if (typeof rule !== 'string' || !rule.trim() || rule.trim().length > 240) {
      return {
        ok: false,
        error: 'invalid_auto_mode_rule',
        max: MAX_AUTO_MODE_RULES,
      };
    }
  }
  return {ok: true, max: MAX_AUTO_MODE_RULES};
}

export function evaluateAutoModeRule(
  rules: readonly string[],
  action: {
    toolName: string;
    command?: string;
    path?: string;
    url?: string;
  },
): AutoModeEvaluation {
  const limited = rules.slice(0, MAX_AUTO_MODE_RULES);
  for (const rawRule of limited) {
    const rule = rawRule.trim();
    if (!rule) {
      continue;
    }
    const colon = rule.indexOf(':');
    const prefix = colon > 0 ? rule.slice(0, colon).toLowerCase() : 'tool';
    const pattern = colon > 0 ? rule.slice(colon + 1).trim() : rule;
    if (!pattern) {
      continue;
    }

    if (prefix === 'tool' && globToRegExp(pattern).test(action.toolName)) {
      return {allowed: true, matchedRule: rule};
    }
    if (prefix === 'bash' && action.command) {
      const cmdRegex = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
        'i',
      );
      if (cmdRegex.test(action.command.trim())) {
        return {allowed: true, matchedRule: rule};
      }
    }
    if (prefix === 'path' && action.path) {
      const normalizedPath = action.path.replace(/\\/g, '/');
      if (globToRegExp(pattern).test(normalizedPath)) {
        return {allowed: true, matchedRule: rule};
      }
    }
    if (prefix === 'domain' && action.url) {
      try {
        const hostname = new URL(action.url).hostname.toLowerCase();
        if (globToRegExp(pattern).test(hostname)) {
          return {allowed: true, matchedRule: rule};
        }
      } catch {
        // Ignore malformed URLs.
      }
    }
  }
  return {allowed: false};
}

export function buildProjectCoordinatorPrompt(input: {
  project: ProjectRecord;
  threads: readonly ProjectThreadRecord[];
  memoryPreview?: string;
  viewing?: {tab?: string; threadId?: string; page?: string};
  activeWorkers?: readonly ProjectRosterWorker[];
}): string {
  const {project, threads} = input;
  const config = project.multiAgentConfig;
  const lines: string[] = [
    '# Project Coordinator',
    `Project: ${project.name} (${project.id})`,
  ];
  if (project.goal) {
    lines.push(`Goal: ${project.goal}`);
  }
  if (project.description) {
    lines.push(`Description: ${project.description}`);
  }
  if (project.instructions) {
    lines.push('', '## Project Instructions', project.instructions);
  }
  if (config?.agentTeam) {
    lines.push(`Team Preset: ${config.agentTeam}`);
  }
  if (input.viewing?.tab) {
    lines.push(
      `User Currently Viewing: ${input.viewing.tab}${input.viewing.threadId ? ` (thread ${input.viewing.threadId})` : ''}`,
    );
  }
  if (threads.length > 0) {
    lines.push('', '## Active & Recent Threads');
    for (const thread of threads.slice(0, 12)) {
      const status = deriveThreadStatus(thread).status;
      lines.push(`- [${status}] ${thread.id}: ${thread.title}`);
    }
  }
  if (input.activeWorkers && input.activeWorkers.length > 0) {
    lines.push(
      '',
      '## Active Workers',
      ...input.activeWorkers.map(
        worker => `- Step ${worker.step}: ${worker.names.join(', ')}`,
      ),
    );
  }
  if (input.memoryPreview?.trim()) {
    lines.push('', '## Shared /MEMORY.md Preview', input.memoryPreview.trim());
  }
  lines.push(
    '',
    '## Coordinator Tool Protocol',
    '- Spawn focused worker threads with `Project.start_thread` and route follow-ups with `Project.message_thread`.',
    '- Workers spawned by `Project.start_thread` execute asynchronously in background worker runs; NEVER call `Project.message_thread` immediately on a newly started thread just to poll for progress in the same turn.',
    '- Keep Coordinator summary updates concise, scannable Markdown, referencing worker threads by their exact title so users can click straight into them.',
    '- Check status via `Project.list_threads` and `Project.read_thread`; inspect diffs with `Project.inspect_worktree_diff`.',
    '- Escalate ambiguous tradeoffs to the user with `Project.ask_decision` (2-4 concrete options with consequences).',
    '- Keep `/MEMORY.md` accurate via `Project.update_memory`, share files via `Project.write_file`, publish outputs with `Project.publish_artifact`, and update Overview with `Project.refresh_status_page`.',
  );
  return lines.join('\n');
}

export function createProjectCoordinatorTools(
  deps: ProjectCoordinatorToolDeps,
): ToolSpec[] {
  const {project, channelStore, worktreeManager} = deps;

  return [
    {
      name: 'Project.start_thread',
      description:
        'Start a new worker thread in this project, optionally provisioning an isolated git worktree or sandbox.',
      effect: 'reversible_write',
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          title: {type: 'string'},
          prompt: {type: 'string'},
          useWorktree: {type: 'boolean'},
          baseBranch: {type: 'string'},
          parentThreadId: {type: 'string'},
        },
        required: ['prompt'],
      },
      async execute(args) {
        const prompt = String(args.prompt || '').trim();
        const title = args.title ? String(args.title).trim() : undefined;
        let worktreePath: string | undefined;
        let worktreeBranch: string | undefined;
        const threadId = `thr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

        if (worktreeManager && args.useWorktree !== false) {
          const ws = await worktreeManager.createThreadWorkspace({
            projectRoot: project.root,
            projectDataDir: channelStore.projectDataDir,
            threadId,
            title: title || prompt.slice(0, 48),
            baseBranch: args.baseBranch ? String(args.baseBranch) : undefined,
          });
          worktreePath = ws.worktreePath;
          worktreeBranch = ws.branch || undefined;
        }

        const thread = channelStore.createThread({
          id: threadId,
          title,
          body: prompt,
          parentThreadId: args.parentThreadId
            ? String(args.parentThreadId)
            : undefined,
          boundSessionIds: [`sess_${threadId}`],
          taskStatus: 'in_progress',
          worktreePath,
          worktreeBranch,
          lastPromptText: prompt,
        });
        await deps.onStartThread?.(thread, prompt);
        return {thread};
      },
    },
    {
      name: 'Project.message_thread',
      description: 'Route a message or instruction into an existing worker thread.',
      effect: 'reversible_write',
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          threadId: {type: 'string'},
          message: {type: 'string'},
          sender: {type: 'string', enum: ['coordinator', 'user', 'worker']},
        },
        required: ['threadId', 'message'],
      },
      async execute(args) {
        const threadId = String(args.threadId || '').trim();
        const message = String(args.message || '').trim();
        const sender =
          (args.sender as 'coordinator' | 'user' | 'worker' | undefined) ??
          'coordinator';
        const thread = channelStore.appendThreadMessage(threadId, {
          author: sender,
          text: message,
          routeFromOverview: true,
        });
        await deps.onMessageThread?.(thread, message);
        return {thread};
      },
    },
    {
      name: 'Project.list_threads',
      description: 'List project threads with their derived 14-state status.',
      effect: 'read',
      is_concurrency_safe: true,
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          includeResolved: {type: 'boolean'},
          limit: {type: 'integer'},
        },
        required: [],
      },
      execute(args) {
        const includeResolved = args.includeResolved !== false;
        const limit = typeof args.limit === 'number' ? args.limit : 100;
        const rows = channelStore
          .listThreads()
          .map(thread => ({
            ...thread,
            derived: deriveThreadStatus(thread),
          }))
          .filter(
            item =>
              includeResolved ||
              (item.derived.status !== 'resolved' &&
                item.derived.status !== 'archived'),
          )
          .slice(0, limit);
        return {threads: rows};
      },
    },
    {
      name: 'Project.read_thread',
      description: 'Read a single project thread including its messages and derived status.',
      effect: 'read',
      is_concurrency_safe: true,
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          threadId: {type: 'string'},
        },
        required: ['threadId'],
      },
      execute(args) {
        const thread = channelStore.getThread(String(args.threadId || ''));
        if (!thread) {
          throw new Error(`Thread not found: ${String(args.threadId || '')}`);
        }
        return {thread, derived: deriveThreadStatus(thread)};
      },
    },
    {
      name: 'Project.ask_decision',
      description:
        'Present a structured 2-4 option Decision Card to the user with explicit consequences and an optional recommended index.',
      effect: 'reversible_write',
      suspends_for_user_input: true,
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          question: {type: 'string'},
          context: {type: 'string'},
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: {type: 'string'},
                consequence: {type: 'string'},
              },
              required: ['label', 'consequence'],
            },
          },
          recommended: {type: 'integer'},
          reason: {type: 'string'},
          threadId: {type: 'string'},
          taskId: {type: 'string'},
        },
        required: ['question', 'options'],
      },
      execute(args) {
        const card = channelStore.askDecision({
          question: String(args.question || ''),
          context: args.context ? String(args.context) : undefined,
          options: args.options as ProjectDecisionOption[],
          recommended:
            typeof args.recommended === 'number' ? args.recommended : undefined,
          reason: args.reason ? String(args.reason) : undefined,
          threadId: args.threadId ? String(args.threadId) : undefined,
          taskId: args.taskId ? String(args.taskId) : undefined,
        });
        return {decision: card};
      },
    },
    {
      name: 'Project.set_thread_resolved',
      description: 'Resolve or reopen a project worker thread.',
      effect: 'reversible_write',
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          threadId: {type: 'string'},
          resolved: {type: 'boolean'},
        },
        required: ['threadId', 'resolved'],
      },
      execute(args) {
        const thread = channelStore.resolveThread(
          String(args.threadId || ''),
          Boolean(args.resolved),
        );
        return {thread, derived: deriveThreadStatus(thread)};
      },
    },
    {
      name: 'Project.update_memory',
      description:
        'Create or update shared project memory (/MEMORY.md or topic notes) using SHA-256 optimistic CAS preconditions.',
      effect: 'reversible_write',
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          path: {type: 'string'},
          content: {type: 'string'},
          expectedSha256: {type: 'string'},
          mode: {type: 'string', enum: ['create', 'update', 'append']},
        },
        required: ['content'],
      },
      execute(args) {
        const memPath = args.path ? String(args.path) : '/MEMORY.md';
        const content = String(args.content ?? '');
        const mode = (args.mode as 'create' | 'update' | 'append' | undefined) ?? 'update';
        const current = channelStore.readMemory(memPath);

        if (mode === 'create' || (!current.exists && !args.expectedSha256)) {
          const result = channelStore.createMemory(memPath, content);
          if (!result.ok) {
            throw new Error(result.error || result.code || 'Memory create failed.');
          }
          return result;
        }
        const nextContent =
          mode === 'append' ? `${current.content}\n${content}` : content;
        const expected =
          args.expectedSha256 !== undefined
            ? String(args.expectedSha256)
            : current.sha256;
        const result = channelStore.updateMemory(memPath, nextContent, expected);
        if (!result.ok) {
          throw new Error(result.error || result.code || 'Memory update failed.');
        }
        return result;
      },
    },
    {
      name: 'Project.write_file',
      description:
        'Write a shared project file under files/, respecting overwrite=false and keepBoth(1..21) collision handling.',
      effect: 'reversible_write',
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          path: {type: 'string'},
          content: {type: 'string'},
          overwrite: {type: 'boolean'},
          keepBoth: {type: 'boolean'},
        },
        required: ['path', 'content'],
      },
      execute(args) {
        const result = channelStore.writeFile({
          path: String(args.path || ''),
          content: String(args.content ?? ''),
          overwrite: Boolean(args.overwrite),
          keepBoth: Boolean(args.keepBoth),
        });
        if (!result.ok) {
          throw new Error(result.error || result.code || 'File write failed.');
        }
        return result;
      },
    },
    {
      name: 'Project.read_file',
      description: 'Read a shared project file under files/ with optional byte range.',
      effect: 'read',
      is_concurrency_safe: true,
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          path: {type: 'string'},
          offset: {type: 'integer'},
          length: {type: 'integer'},
        },
        required: ['path'],
      },
      execute(args) {
        return channelStore.readFile(String(args.path || ''), {
          offset: typeof args.offset === 'number' ? args.offset : undefined,
          length: typeof args.length === 'number' ? args.length : undefined,
        });
      },
    },
    {
      name: 'Project.publish_artifact',
      description: 'Publish an artifact, file, or link to the project Artifacts shelf.',
      effect: 'reversible_write',
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          title: {type: 'string'},
          kind: {type: 'string', enum: ['artifact', 'file', 'link']},
          pathOrUrl: {type: 'string'},
          summary: {type: 'string'},
          threadId: {type: 'string'},
          pinned: {type: 'boolean'},
        },
        required: ['title', 'kind', 'pathOrUrl'],
      },
      execute(args) {
        const artifact = channelStore.publishArtifact({
          title: String(args.title || ''),
          kind: args.kind as ProjectPublishedArtifact['kind'],
          pathOrUrl: String(args.pathOrUrl || ''),
          summary: args.summary ? String(args.summary) : undefined,
          threadId: args.threadId ? String(args.threadId) : undefined,
          pinned: Boolean(args.pinned),
        });
        return {artifact};
      },
    },
    {
      name: 'Project.refresh_status_page',
      description:
        'Update the sandboxed Overview HTML status page and optional dismissible Recap summary.',
      effect: 'reversible_write',
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          html: {type: 'string'},
          recapText: {type: 'string'},
        },
        required: ['html'],
      },
      execute(args) {
        const html = String(args.html ?? '');
        channelStore.setStatusPage(html);
        const recap =
          args.recapText !== undefined
            ? channelStore.setRecap(String(args.recapText))
            : channelStore.getRecap();
        return {ok: true, recap};
      },
    },
    {
      name: 'Project.inspect_worktree_diff',
      description:
        'Inspect uncommitted changes and diff stats for a worker thread worktree.',
      effect: 'read',
      is_concurrency_safe: true,
      used_backend: 'project-coordinator',
      input_schema: {
        type: 'object',
        properties: {
          threadId: {type: 'string'},
          baseBranch: {type: 'string'},
        },
        required: ['threadId'],
      },
      async execute(args) {
        const threadId = String(args.threadId || '');
        const thread = channelStore.getThread(threadId);
        if (!thread) {
          throw new Error(`Thread not found: ${threadId}`);
        }
        const targetPath = thread.worktreePath || project.root;
        if (!worktreeManager || !targetPath) {
          return {
            threadId,
            uncommitted: {status: 'unknown', changes: [], folders: [], committedOn: []},
            diff: {isGit: false, diff: '', stat: '', addedLines: 0, deletedLines: 0, changedFiles: 0},
          };
        }
        const [uncommitted, diff] = await Promise.all([
          worktreeManager.inspectUncommittedChanges({
            projectRoot: project.root,
            worktreePath: targetPath,
          }),
          worktreeManager.getWorktreeDiff({
            worktreePath: targetPath,
            baseBranch: args.baseBranch ? String(args.baseBranch) : undefined,
          }),
        ]);
        return {threadId, uncommitted, diff};
      },
    },
  ];
}

export function registerProjectCoordinatorTools(
  registry: ToolRegistry,
  deps: ProjectCoordinatorToolDeps,
): string[] {
  const specs = createProjectCoordinatorTools(deps);
  for (const spec of specs) {
    registry.register(spec);
  }
  return specs.map(spec => spec.name);
}
