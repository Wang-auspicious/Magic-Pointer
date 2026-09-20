'use strict';

const assert = require('node:assert');
const path = require('node:path');

const {
  isManagedWorktreePath,
  worktreeAddArgs,
  worktreePathFor,
  worktreeRemoveArgs,
  worktreeReuseArgs,
  worktreeSlug,
} = require('../electron/session_worktree');

const DATA = path.resolve('C:/Users/example/.magic-pointer');

/* ---- slug：只含 [a-z0-9-]，因为它是目录名也是分支名 ---- */
assert.strictEqual(worktreeSlug('01a0a92c-e545-741f-851b-9f3d88efa0e9'), 'mp-01a0a92c-e545-741f-851b-');
assert.strictEqual(worktreeSlug('', 1000), worktreeSlug('   ', 1000), 'blank ids at the same time fall back the same way');
assert.match(worktreeSlug(''), /^mp-[a-z0-9]+$/, 'the timestamp fallback is still a valid ref name');
assert.strictEqual(worktreeSlug('../../etc/passwd'), 'mp-etcpasswd',
  'a hostile conversation id cannot climb out of the managed directory');
assert.strictEqual(worktreeSlug('a'.repeat(200)).length, 'mp-'.length + 24,
  'the slug is capped so the branch name stays within git limits');

/* ---- 选址：托管在用户数据目录下，不在被打开的项目里 ---- */
const repoRoot = path.resolve('D:/Desktop/Magic Pointer');
const target = worktreePathFor(DATA, repoRoot, 'mp-abc');
assert.strictEqual(target, path.join(DATA, 'worktrees', 'mp-abc', 'Magic Pointer'));
assert(!target.startsWith(repoRoot),
  'a worktree must never be created inside the opened project: it would show up in the user\'s git status');
assert(path.basename(worktreePathFor(DATA, 'D:/work/api/', 'mp-x')) === 'api',
  'a trailing separator does not produce an empty repo name');
assert(path.basename(worktreePathFor(DATA, '', 'mp-x')) === 'project',
  'a root with no basename still yields a real directory name');

/* ---- 移除的白名单：这是唯一会删东西的路径 ---- */
assert.strictEqual(isManagedWorktreePath(DATA, target), true);
assert.strictEqual(isManagedWorktreePath(DATA, path.join(DATA, 'worktrees')), false,
  'the managed root itself is not a worktree');
assert.strictEqual(isManagedWorktreePath(DATA, path.join(DATA, 'worktrees-evil', 'x')), false,
  'containment is a path check, not a string prefix check');
assert.strictEqual(isManagedWorktreePath(DATA, path.join(target, '..', '..', '..', 'Windows')), false,
  'a path that traverses out of the managed root is rejected');
assert.strictEqual(isManagedWorktreePath(DATA, repoRoot), false,
  'the project itself is never removable through this channel');
assert.strictEqual(isManagedWorktreePath(DATA, ''), false);
assert.strictEqual(isManagedWorktreePath(DATA, null), false);

/* ---- git 参数 ---- */
assert.deepStrictEqual(worktreeAddArgs('C:/wt', 'mp-x'), ['worktree', 'add', '-b', 'mp-x', 'C:/wt', 'HEAD']);
assert.deepStrictEqual(worktreeReuseArgs('C:/wt', 'mp-x'), ['worktree', 'add', 'C:/wt', 'mp-x']);
assert.deepStrictEqual(worktreeRemoveArgs('C:/wt'), ['worktree', 'remove', 'C:/wt']);
assert(!JSON.stringify(worktreeRemoveArgs('C:/wt')).includes('--force'),
  'removal must never force past a dirty worktree: that is how uncommitted work gets deleted');

console.log('session worktree test ok');
