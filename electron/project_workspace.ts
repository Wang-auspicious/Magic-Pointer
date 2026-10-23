import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {
  isManagedWorktreePath,
  worktreeAddArgs,
  worktreePathFor,
  worktreeReuseArgs,
  worktreeSlug,
} from './session_worktree';

const execute = promisify(execFile);

export interface ProjectWorkspaceRequest {
  projectRoot: string;
  dataDir: string;
  conversationId: string;
  branch?: string;
  worktree: boolean;
  existingPath?: string;
  previousBranch?: string;
}

export type ProjectWorkspaceResult =
  {ok: true; path: string; branch: string} | {ok: false; error: string};

async function git(root: string, args: string[]): Promise<string> {
  const result = await execute(
    process.platform === 'win32' ? 'git.exe' : 'git',
    args,
    {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 512 * 1024,
    },
  );
  return result.stdout.trimEnd();
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export async function listProjectWorktrees(
  root: string,
): Promise<Array<{path: string; branch: string}>> {
  const output = await git(root, ['worktree', 'list', '--porcelain', '-z']);
  const entries: Array<{path: string; branch: string}> = [];
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      entries.push({path: field.slice(9), branch: ''});
    } else if (field.startsWith('branch refs/heads/') && entries.length) {
      entries[entries.length - 1].branch = field.slice(18);
    }
  }
  return entries;
}

export async function prepareProjectWorkspace(
  request: ProjectWorkspaceRequest,
): Promise<ProjectWorkspaceResult> {
  const {projectRoot, dataDir, conversationId, worktree} = request;
  const requestedBranch = request.branch?.trim() || '';
  try {
    if (!worktree && !requestedBranch) {
      return {ok: true, path: projectRoot, branch: ''};
    }
    if (
      (await git(projectRoot, ['rev-parse', '--is-inside-work-tree'])) !==
      'true'
    ) {
      throw new Error(
        'Select a Git repository for branch or worktree settings.',
      );
    }
    if (!worktree) {
      await git(projectRoot, [
        'rev-parse',
        '--verify',
        `refs/heads/${requestedBranch}`,
      ]);
      const current = await git(projectRoot, ['branch', '--show-current']);
      if (current !== requestedBranch) {
        await git(projectRoot, ['switch', '--', requestedBranch]);
      }
      return {ok: true, path: projectRoot, branch: requestedBranch};
    }
    if (!conversationId) {
      throw new Error('A task identity is required for an isolated worktree.');
    }
    const slug = worktreeSlug(conversationId);
    const target = worktreePathFor(dataDir, projectRoot, slug);
    const branch = `mp/${slug}`;
    const entries = await listProjectWorktrees(projectRoot);
    if (request.existingPath) {
      const existing = entries.find(item =>
        samePath(item.path, request.existingPath!),
      );
      if (!existing || !isManagedWorktreePath(dataDir, existing.path)) {
        throw new Error('The accepted task worktree is no longer available.');
      }
      if (
        requestedBranch &&
        request.previousBranch !== undefined &&
        requestedBranch !== request.previousBranch
      ) {
        await git(existing.path, [
          'rev-parse',
          '--verify',
          `refs/heads/${requestedBranch}`,
        ]);
        await git(existing.path, ['switch', '--', requestedBranch]);
        return {
          ok: true,
          path: path.resolve(existing.path),
          branch: requestedBranch,
        };
      }
      return {
        ok: true,
        path: path.resolve(existing.path),
        branch: existing.branch,
      };
    }
    if (fs.existsSync(target)) {
      const existing = entries.find(item => samePath(item.path, target));
      if (!existing || existing.branch !== branch) {
        throw new Error('The worktree path is occupied by other content.');
      }
      return {ok: true, path: target, branch};
    }
    const owner = entries.find(item => item.branch === branch);
    if (owner) {
      throw new Error(
        `The task branch is already checked out at ${owner.path}.`,
      );
    }
    const branchExists = await git(projectRoot, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]).then(
      () => true,
      () => false,
    );
    if (!branchExists && requestedBranch) {
      await git(projectRoot, [
        'rev-parse',
        '--verify',
        `refs/heads/${requestedBranch}`,
      ]);
    }
    fs.mkdirSync(path.dirname(target), {recursive: true});
    await git(
      projectRoot,
      branchExists
        ? worktreeReuseArgs(target, branch)
        : worktreeAddArgs(target, branch, requestedBranch || 'HEAD'),
    );
    return {ok: true, path: target, branch};
  } catch (error) {
    const failure = error as Error & {stderr?: string};
    return {ok: false, error: failure.stderr?.trim() || failure.message};
  }
}
