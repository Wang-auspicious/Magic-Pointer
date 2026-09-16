'use strict';

import path from 'node:path';

/* 会话级 git worktree 的纯决策层：命名、选址、以及「这个路径是不是我们建的」。
   真正 spawn git 的部分留在 main.ts。

   两件事在这里被钉死，因为它们是这套东西里唯一会造成损害的地方：

   1. worktree 建在用户数据目录下，**不**建在被打开的项目里。建在项目内需要
      那个项目刚好忽略了该目录，否则我们往用户的 `git status` 里塞东西——一个
      只读的开关不该改变用户的仓库状态。（本仓库自己有 `.worktrees/` 且已忽略，
      但那是本仓库的选择，不能替所有被打开的项目做主。）
   2. 移除只允许发生在托管目录内部。渲染层传来的路径会经过
      :func:`isManagedWorktreePath` 才交给 `git worktree remove`，否则一个改过的
      渲染层就能把「关掉这个开关」变成任意目录删除。 */

const SLUG_MAX = 24;

/** Branch and directory name for a session's worktree. */
function worktreeSlug(conversationId: unknown, nowMs = Date.now()): string {
  const cleaned = String(conversationId ?? '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, SLUG_MAX);
  if (cleaned) return `mp-${cleaned}`;
  // 没有会话 id（新会话还没落盘）时给一个时间戳，仍然只含 [a-z0-9-]。
  return `mp-${Math.floor(nowMs).toString(36)}`;
}

/** `<dataDir>/worktrees/<slug>/<repo name>` — the managed root for one session. */
function worktreePathFor(dataDir: string, repoRoot: string, slug: string): string {
  const repo = path.basename(String(repoRoot || '').trim()) || 'project';
  return path.join(String(dataDir), 'worktrees', slug, repo);
}

/**
 * True when ``candidate`` is a worktree strictly inside
 * ``<dataDir>/worktrees`` — not the managed root itself, and not a sibling
 * whose name merely starts with the same characters.
 *
 * Separators on both sides are what make this containment rather than a string
 * prefix check: without them `<dataDir>/worktrees-evil` and `<dataDir>/worktrees`
 * would both pass.
 */
function isManagedWorktreePath(dataDir: string, candidate: unknown): boolean {
  const root = path.resolve(path.join(String(dataDir), 'worktrees'));
  const value = String(candidate ?? '').trim();
  if (!value) return false;
  const resolved = path.resolve(value);
  return resolved !== root && (resolved + path.sep).startsWith(root + path.sep);
}

/** `git worktree add -b mp-x <target> HEAD` — the normal create. */
function worktreeAddArgs(target: string, branch: string, startPoint = 'HEAD'): string[] {
  return ['worktree', 'add', '-b', branch, target, startPoint];
}

/** Reuse an existing branch: `-b` fails when `mp-x` is already there. */
function worktreeReuseArgs(target: string, branch: string): string[] {
  return ['worktree', 'add', target, branch];
}

function worktreeRemoveArgs(target: string): string[] {
  return ['worktree', 'remove', target];
}

export {
  isManagedWorktreePath,
  worktreeAddArgs,
  worktreePathFor,
  worktreeRemoveArgs,
  worktreeReuseArgs,
  worktreeSlug,
};
