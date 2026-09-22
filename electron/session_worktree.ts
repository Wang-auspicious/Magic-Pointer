'use strict';

import path from 'node:path';


const SLUG_MAX = 24;

function worktreeSlug(conversationId: unknown, nowMs = Date.now()): string {
  const cleaned = String(conversationId ?? '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, SLUG_MAX);
  if (cleaned) return `mp-${cleaned}`;
  return `mp-${Math.floor(nowMs).toString(36)}`;
}

function worktreePathFor(dataDir: string, repoRoot: string, slug: string): string {
  const repo = path.basename(String(repoRoot || '').trim()) || 'project';
  return path.join(String(dataDir), 'worktrees', slug, repo);
}

function isManagedWorktreePath(dataDir: string, candidate: unknown): boolean {
  const root = path.resolve(path.join(String(dataDir), 'worktrees'));
  const value = String(candidate ?? '').trim();
  if (!value) return false;
  const resolved = path.resolve(value);
  return resolved !== root && (resolved + path.sep).startsWith(root + path.sep);
}

function worktreeAddArgs(target: string, branch: string, startPoint = 'HEAD'): string[] {
  return ['worktree', 'add', '-b', branch, target, startPoint];
}

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
