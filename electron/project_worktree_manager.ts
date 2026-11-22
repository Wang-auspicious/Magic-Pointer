import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {parseGitEnvironment} from './project_environment';
import type {
  ProjectThreadRecord,
  UncommittedChangesReport,
  UncommittedFileChange,
  UncommittedFolderReport,
} from './project_multiagent_types';
import {deriveThreadStatus} from './project_thread_state';

const execute = promisify(execFile);

export interface ThreadWorkspaceResult {
  isGit: boolean;
  worktreePath: string;
  branch: string;
  created: boolean;
}

export interface ManagedWorktreeEntry {
  path: string;
  branch: string;
  threadId: string;
}

export interface WorktreeDiffResult {
  isGit: boolean;
  diff: string;
  stat: string;
  addedLines: number;
  deletedLines: number;
  changedFiles: number;
}

export interface WorktreeMergeResult {
  ok: boolean;
  mergedCommit?: string;
  conflict?: boolean;
  error?: string;
}

export interface WorktreeDiscardResult {
  ok: boolean;
  code?: 'DIRTY_WORKTREE' | 'NOT_FOUND';
  report?: UncommittedChangesReport;
  error?: string;
}

export interface FamilyArchiveCascadePlan {
  archiveThreadIds: string[];
  detachThreadIds: string[];
}

function sanitizeId(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-');
  return cleaned || 'thread';
}

function slugify(raw: string): string {
  const slug = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'task';
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execute(
    process.platform === 'win32' ? 'git.exe' : 'git',
    args,
    {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return result.stdout;
}

async function isGitRepo(root: string): Promise<boolean> {
  if (!root || !fs.existsSync(root)) {
    return false;
  }
  try {
    const out = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

function ensureExcludeRule(projectRoot: string): void {
  try {
    const gitDir = path.join(projectRoot, '.git');
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
      return;
    }
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(excludeFile), {recursive: true});
    const existing = fs.existsSync(excludeFile)
      ? fs.readFileSync(excludeFile, 'utf8')
      : '';
    const lines = existing.split(/\r?\n/);
    if (!lines.some(line => line.trim() === '.mp-worktrees/')) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(excludeFile, `${existing}${prefix}.mp-worktrees/\n`, 'utf8');
    }
  } catch {
    // Non-fatal if .git/info/exclude cannot be updated.
  }
}

export class ProjectWorktreeManager {
  async createThreadWorkspace(input: {
    projectRoot?: string;
    projectDataDir: string;
    threadId: string;
    title?: string;
    baseBranch?: string;
  }): Promise<ThreadWorkspaceResult> {
    const safeThreadId = sanitizeId(input.threadId);
    const projectRoot = input.projectRoot ? path.resolve(input.projectRoot) : '';

    if (projectRoot && (await isGitRepo(projectRoot))) {
      ensureExcludeRule(projectRoot);
      const worktreePath = path.join(projectRoot, '.mp-worktrees', safeThreadId);
      const existing = await this.listWorktrees(projectRoot);
      const matched = existing.find(entry => samePath(entry.path, worktreePath));
      if (matched) {
        return {
          isGit: true,
          worktreePath: matched.path,
          branch: matched.branch,
          created: false,
        };
      }
      const shortId = safeThreadId.slice(-8);
      const branch = `mp/${slugify(input.title || safeThreadId)}-${shortId}`;
      const startPoint = input.baseBranch?.trim() || 'HEAD';
      fs.mkdirSync(path.dirname(worktreePath), {recursive: true});
      const branchExists = await runGit(projectRoot, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]).then(
        () => true,
        () => false,
      );
      if (branchExists) {
        await runGit(projectRoot, ['worktree', 'add', worktreePath, branch]);
      } else {
        await runGit(projectRoot, [
          'worktree',
          'add',
          '-b',
          branch,
          worktreePath,
          startPoint,
        ]);
      }
      return {
        isGit: true,
        worktreePath,
        branch,
        created: true,
      };
    }

    const sandboxDir = path.join(
      path.resolve(input.projectDataDir),
      'threads',
      safeThreadId,
      'workspace',
    );
    const existed = fs.existsSync(sandboxDir);
    fs.mkdirSync(sandboxDir, {recursive: true});
    return {
      isGit: false,
      worktreePath: sandboxDir,
      branch: '',
      created: !existed,
    };
  }

  async listWorktrees(projectRoot: string): Promise<ManagedWorktreeEntry[]> {
    if (!(await isGitRepo(projectRoot))) {
      return [];
    }
    const output = await runGit(projectRoot, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ]);
    const managedRoot = path.resolve(projectRoot, '.mp-worktrees');
    const rawEntries: Array<{path: string; branch: string}> = [];
    for (const field of output.split('\0')) {
      if (field.startsWith('worktree ')) {
        rawEntries.push({path: path.resolve(field.slice(9)), branch: ''});
      } else if (field.startsWith('branch refs/heads/') && rawEntries.length) {
        rawEntries[rawEntries.length - 1].branch = field.slice(18);
      }
    }
    return rawEntries
      .filter(entry => {
        const rel = path.relative(managedRoot, entry.path);
        return Boolean(
          rel &&
            rel !== '..' &&
            !rel.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(rel),
        );
      })
      .map(entry => ({
        path: entry.path,
        branch: entry.branch,
        threadId: path.basename(entry.path),
      }));
  }

  async inspectUncommittedChanges(input: {
    projectRoot?: string;
    worktreePath?: string;
  }): Promise<UncommittedChangesReport> {
    const targets: Array<{folder: string; worktreePath: string; primary: boolean}> = [];
    if (input.worktreePath) {
      targets.push({
        folder: path.basename(input.worktreePath),
        worktreePath: path.resolve(input.worktreePath),
        primary: false,
      });
    } else if (input.projectRoot) {
      const root = path.resolve(input.projectRoot);
      targets.push({folder: path.basename(root), worktreePath: root, primary: true});
      for (const wt of await this.listWorktrees(root)) {
        targets.push({
          folder: wt.threadId,
          worktreePath: wt.path,
          primary: false,
        });
      }
    }

    const folders: UncommittedFolderReport[] = [];
    const allChanges: UncommittedFileChange[] = [];
    const committedOn = new Set<string>();
    let anyUnreadable = false;

    for (const target of targets) {
      if (!(await isGitRepo(target.worktreePath))) {
        anyUnreadable = true;
        folders.push({
          folder: target.folder,
          worktreePath: target.worktreePath,
          primary: target.primary,
          unreadable: true,
          changes: [],
        });
        continue;
      }
      try {
        const [branchOutput, numstatOutput] = await Promise.all([
          runGit(target.worktreePath, ['status', '--porcelain=v1', '-z', '-b']),
          runGit(target.worktreePath, ['diff', '--numstat']),
        ]);
        const env = parseGitEnvironment({
          root: target.worktreePath,
          branchOutput,
          numstatOutput,
        });
        const changes = env.fileChanges.map(change => ({
          path: change.path,
          status: change.status,
          staged: change.staged,
        }));
        folders.push({
          folder: target.folder,
          worktreePath: target.worktreePath,
          primary: target.primary,
          unreadable: false,
          changes,
        });
        for (const change of changes) {
          allChanges.push({...change, folder: target.folder});
        }
        try {
          const containing = await runGit(target.worktreePath, [
            'branch',
            '--contains',
            'HEAD',
          ]);
          for (const line of containing.split(/\r?\n/)) {
            const cleaned = line.replace(/^\*?\s+/, '').trim();
            if (cleaned && cleaned !== env.branch) {
              committedOn.add(cleaned);
            }
          }
        } catch {
          // HEAD may have no commits yet.
        }
      } catch {
        anyUnreadable = true;
        folders.push({
          folder: target.folder,
          worktreePath: target.worktreePath,
          primary: target.primary,
          unreadable: true,
          changes: [],
        });
      }
    }

    const status: UncommittedChangesReport['status'] =
      allChanges.length > 0
        ? 'dirty'
        : anyUnreadable || folders.length === 0
          ? 'unknown'
          : 'clean';

    return {
      status,
      changes: allChanges,
      folders,
      committedOn: [...committedOn],
    };
  }

  async getWorktreeDiff(input: {
    worktreePath: string;
    baseBranch?: string;
  }): Promise<WorktreeDiffResult> {
    if (!(await isGitRepo(input.worktreePath))) {
      return {
        isGit: false,
        diff: '',
        stat: '',
        addedLines: 0,
        deletedLines: 0,
        changedFiles: 0,
      };
    }
    const baseRef = input.baseBranch?.trim() || 'HEAD';
    const [diff, stat, statusOut, numstatOut] = await Promise.all([
      runGit(input.worktreePath, ['diff', baseRef]).catch(() => ''),
      runGit(input.worktreePath, ['diff', '--stat', baseRef]).catch(() => ''),
      runGit(input.worktreePath, ['status', '--porcelain=v1', '-z', '-b']),
      runGit(input.worktreePath, ['diff', '--numstat', baseRef]).catch(() => ''),
    ]);
    const env = parseGitEnvironment({
      root: input.worktreePath,
      branchOutput: statusOut,
      numstatOutput: numstatOut,
    });
    return {
      isGit: true,
      diff: diff.trimEnd(),
      stat: stat.trimEnd(),
      addedLines: env.addedLines,
      deletedLines: env.deletedLines,
      changedFiles: env.changedFiles,
    };
  }

  async mergeWorktree(input: {
    projectRoot: string;
    worktreePath: string;
    branch: string;
    targetBranch?: string;
    commitMessage?: string;
  }): Promise<WorktreeMergeResult> {
    if (!(await isGitRepo(input.projectRoot)) || !(await isGitRepo(input.worktreePath))) {
      return {ok: false, error: 'Worktree is not backed by Git.'};
    }
    try {
      const report = await this.inspectUncommittedChanges({
        worktreePath: input.worktreePath,
      });
      if (report.status === 'dirty') {
        if (!input.commitMessage?.trim()) {
          return {
            ok: false,
            error: 'Worktree has uncommitted changes; provide commitMessage to commit before merge.',
          };
        }
        await runGit(input.worktreePath, ['add', '-A']);
        await runGit(input.worktreePath, [
          'commit',
          '--quiet',
          '-m',
          input.commitMessage.trim(),
        ]);
      }
      if (input.targetBranch?.trim()) {
        await runGit(input.projectRoot, [
          'switch',
          '--',
          input.targetBranch.trim(),
        ]);
      }
      await runGit(input.projectRoot, [
        'merge',
        '--no-ff',
        '--no-edit',
        input.branch,
      ]);
      const mergedCommit = (
        await runGit(input.projectRoot, ['rev-parse', 'HEAD'])
      ).trim();
      return {ok: true, mergedCommit};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const conflict = /conflict/i.test(message);
      if (conflict) {
        await runGit(input.projectRoot, ['merge', '--abort']).catch(() => {});
      }
      return {ok: false, conflict, error: message};
    }
  }

  async discardWorktree(input: {
    projectRoot?: string;
    worktreePath: string;
    branch?: string;
    force?: boolean;
  }): Promise<WorktreeDiscardResult> {
    const resolvedWorktree = path.resolve(input.worktreePath);
    if (!fs.existsSync(resolvedWorktree)) {
      return {ok: false, code: 'NOT_FOUND', error: 'Worktree path does not exist.'};
    }

    if (input.projectRoot && (await isGitRepo(resolvedWorktree))) {
      const report = await this.inspectUncommittedChanges({
        worktreePath: resolvedWorktree,
      });
      if (report.status === 'dirty' && !input.force) {
        return {
          ok: false,
          code: 'DIRTY_WORKTREE',
          report,
          error: 'Worktree has uncommitted changes.',
        };
      }
      await runGit(path.resolve(input.projectRoot), [
        'worktree',
        'remove',
        '--force',
        resolvedWorktree,
      ]);
      if (input.branch && input.branch.startsWith('mp/')) {
        await runGit(path.resolve(input.projectRoot), [
          'branch',
          '-D',
          input.branch,
        ]).catch(() => {});
      }
      return {ok: true};
    }

    fs.rmSync(resolvedWorktree, {recursive: true, force: true});
    return {ok: true};
  }

  async cleanupOrphanedWorktrees(
    projectRoot: string,
    activeThreadIds: ReadonlySet<string>,
  ): Promise<string[]> {
    const entries = await this.listWorktrees(projectRoot);
    const removed: string[] = [];
    for (const entry of entries) {
      if (activeThreadIds.has(entry.threadId)) {
        continue;
      }
      const res = await this.discardWorktree({
        projectRoot,
        worktreePath: entry.path,
        branch: entry.branch,
        force: false,
      });
      if (res.ok) {
        removed.push(entry.threadId);
      }
    }
    return removed;
  }

  async planFamilyArchiveCascade(
    threads: readonly ProjectThreadRecord[],
    rootThreadId: string,
    inspectDirty?: (thread: ProjectThreadRecord) => Promise<boolean> | boolean,
  ): Promise<FamilyArchiveCascadePlan> {
    const byId = new Map(threads.map(thread => [thread.id, thread]));
    const childrenByParent = new Map<string, ProjectThreadRecord[]>();
    for (const thread of threads) {
      if (!thread.parentThreadId) {
        continue;
      }
      const list = childrenByParent.get(thread.parentThreadId) ?? [];
      list.push(thread);
      childrenByParent.set(thread.parentThreadId, list);
    }

    const archiveThreadIds: string[] = [];
    const detachThreadIds: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [rootThreadId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) {
        continue;
      }
      visited.add(currentId);
      const current = byId.get(currentId);
      if (!current) {
        continue;
      }

      if (currentId === rootThreadId) {
        archiveThreadIds.push(currentId);
      } else {
        const derived = deriveThreadStatus(current);
        const isActive =
          derived.status === 'running' ||
          derived.status === 'in_progress' ||
          derived.status === 'needs_input';
        const hasOpenPr = Boolean(current.openPrUrl);
        let isDirty = false;
        if (inspectDirty) {
          isDirty = await inspectDirty(current);
        } else if (current.worktreePath && (await isGitRepo(current.worktreePath))) {
          const report = await this.inspectUncommittedChanges({
            worktreePath: current.worktreePath,
          });
          isDirty = report.status === 'dirty';
        }
        if (isActive || hasOpenPr || isDirty) {
          detachThreadIds.push(currentId);
          continue;
        }
        archiveThreadIds.push(currentId);
      }

      for (const child of childrenByParent.get(currentId) ?? []) {
        queue.push(child.id);
      }
    }

    return {archiveThreadIds, detachThreadIds};
  }
}
