import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import {
  classifyNotification,
  computeProjectSidebarBadge,
  deriveThreadStatus,
  evaluateThreadLifecycle,
  sortThreadsByAttention,
} from '../electron/project_thread_state';
import {
  ProjectChannelStore,
  ProjectReadOnlyError,
} from '../electron/project_channel_store';
import {ProjectWorktreeManager} from '../electron/project_worktree_manager';
import {
  buildProjectCoordinatorPrompt,
  evaluateAutoModeRule,
  registerProjectCoordinatorTools,
  validateAutoModeRules,
} from '../electron/runtime/project_coordinator_tools';
import {ToolRegistry} from '../electron/runtime/tools';
import {createProjectStore} from '../electron/project_store';
import type {
  ProjectDecisionCard,
  ProjectPublishedArtifact,
  ProjectThreadRecord,
} from '../electron/project_multiagent_types';

function makeThread(
  overrides: Partial<ProjectThreadRecord> = {},
): ProjectThreadRecord {
  return {
    id: overrides.id ?? 'thr-1',
    projectId: overrides.projectId ?? 'proj-1',
    title: overrides.title ?? 'Thread 1',
    boundSessionIds: overrides.boundSessionIds ?? ['sess-1'],
    boundSessions: overrides.boundSessions ?? [
      {id: 'sess-1', status: 'active'},
    ],
    createdAt: overrides.createdAt ?? 1_000_000,
    lastReplyAt: overrides.lastReplyAt ?? 1_000_000,
    replyCount: overrides.replyCount ?? 1,
    hasUnread: overrides.hasUnread ?? false,
    ...overrides,
  };
}

function createGitFixture(): {
  dir: string;
  root: string;
  git: (args: string[], cwd?: string) => string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-amber-git-'));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root, {recursive: true});
  const git = (args: string[], cwd = root) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.name', 'MP Tester']);
  git(['config', 'user.email', 'tester@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), '# Amber Tributary\n', 'utf8');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'init']);
  return {
    dir,
    root,
    git,
    cleanup: () => fs.rmSync(dir, {recursive: true, force: true}),
  };
}

test('deriveThreadStatus follows the exact 14-state priority ladder and overrides', () => {
  const now = 10_000_000;

  // 1. resolved wins over everything
  assert.equal(
    deriveThreadStatus(
      makeThread({
        resolved: true,
        taskStatus: 'blocked',
        boundSessions: [{id: 's1', status: 'failed', working: true}],
        remindAt: now + 60_000,
      }),
      now,
    ).status,
    'resolved',
  );

  // 2. task.status === blocked -> needs_input
  assert.equal(
    deriveThreadStatus(
      makeThread({
        taskStatus: 'blocked',
        boundSessions: [{id: 's1', status: 'failed'}],
      }),
      now,
    ).status,
    'needs_input',
  );

  // 3. machine failed -> failed; start_failed -> needs_input
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'failed'}],
      }),
      now,
    ).status,
    'failed',
  );
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'active', startFailureCode: 'init_container_limit'}],
      }),
      now,
    ).status,
    'needs_input',
  );

  // 4. machine working -> running
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'active', working: true, boardStatus: 'blocked'}],
      }),
      now,
    ).status,
    'running',
  );

  // 5. boardStatus === blocked -> needs_input
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'active', boardStatus: 'blocked'}],
      }),
      now,
    ).status,
    'needs_input',
  );

  // 6. machine archived -> archived (unless reopenedOver)
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'archived'}],
      }),
      now,
    ).status,
    'archived',
  );
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'archived', reopenedOver: true}],
      }),
      now,
    ).status,
    'idle',
  );

  // 7. serverNeedsInput / failingPr / waitsOnLivePrompt / openDecision -> needs_input
  assert.equal(
    deriveThreadStatus(
      makeThread({waitsOnLivePrompt: true}),
      now,
    ).status,
    'needs_input',
  );
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'active', failingPr: true}],
      }),
      now,
    ).status,
    'needs_input',
  );

  // 8. task.status -> done / in_progress / todo
  assert.equal(
    deriveThreadStatus(makeThread({taskStatus: 'done'}), now).status,
    'done',
  );
  assert.equal(
    deriveThreadStatus(makeThread({taskStatus: 'cancelled'}), now).status,
    'done',
  );
  assert.equal(
    deriveThreadStatus(makeThread({taskStatus: 'in_progress'}), now).status,
    'in_progress',
  );
  assert.equal(
    deriveThreadStatus(makeThread({taskStatus: 'open'}), now).status,
    'todo',
  );

  // 9. review -> landing -> paused -> idle
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'active', boardStatus: 'review', landingPr: true}],
      }),
      now,
    ).status,
    'review',
  );
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'active', landingPr: true}],
      }),
      now,
    ).status,
    'landing',
  );
  assert.equal(
    deriveThreadStatus(
      makeThread({
        boundSessions: [{id: 's1', status: 'paused'}],
      }),
      now,
    ).status,
    'paused',
  );
  assert.equal(deriveThreadStatus(makeThread(), now).status, 'idle');

  // Override layer: remind_later & waiting_others
  assert.equal(
    deriveThreadStatus(
      makeThread({remindAt: now + 120_000, taskStatus: 'in_progress'}),
      now,
    ).status,
    'remind_later',
  );
  assert.equal(
    deriveThreadStatus(
      makeThread({waitsOnLivePrompt: true, waitsOnOthers: true}),
      now,
    ).status,
    'waiting_others',
  );
});

test('attention sorter, lifecycle evaluator, notifications, and sidebar badges follow amber_tributary rules', () => {
  const now = 100 * 86_400_000;
  const threads: ProjectThreadRecord[] = [
    makeThread({id: 't-resolved', resolved: true, lastReplyAt: now - 1000}),
    makeThread({id: 't-idle', lastReplyAt: now - 4 * 86_400_000}),
    makeThread({
      id: 't-needs',
      waitsOnLivePrompt: true,
      hasUnread: true,
      lastReplyAt: now - 8 * 86_400_000,
    }),
    makeThread({
      id: 't-running',
      boundSessions: [{id: 's-r', status: 'active', working: true}],
      lastReplyAt: now - 2000,
    }),
    makeThread({
      id: 't-unread',
      hasUnread: true,
      lastReplyAt: now - 5000,
    }),
  ];

  const sorted = sortThreadsByAttention(threads, now);
  assert.equal(sorted[0].id, 't-needs');
  assert.equal(sorted[1].id, 't-unread');
  assert.equal(sorted.at(-1)!.id, 't-resolved');

  // Invalid lifecycle config: autoResolveDays !== 0 && autoResolveDays <= quietAfterDays
  const invalid = evaluateThreadLifecycle(threads, now, {
    quietAfterDays: 7,
    autoResolveDays: 7,
  });
  assert.equal(invalid.valid, false);

  // Preview capped at 6
  const manyIdle = Array.from({length: 10}, (_, index) =>
    makeThread({
      id: `idle-${index}`,
      hasUnread: false,
      lastReplyAt: now - 10 * 86_400_000,
    }),
  );
  const lifecycle = evaluateThreadLifecycle(manyIdle, now, {
    quietAfterDays: 3,
    autoResolveDays: 7,
  });
  assert.equal(lifecycle.valid, true);
  assert.equal(lifecycle.actions.length, 10);
  assert.equal(lifecycle.preview.length, 6);
  assert.ok(lifecycle.actions.every(action => action.action === 'resolve'));

  // Quiet action when >= quietAfterDays and < autoResolveDays
  const quietEval = evaluateThreadLifecycle(
    [makeThread({id: 'q1', lastReplyAt: now - 4 * 86_400_000})],
    now,
    {quietAfterDays: 3, autoResolveDays: 7},
  );
  assert.equal(quietEval.actions[0]?.action, 'quiet');

  // Notifications: coordinator level mutes thread_replies and member_messages
  assert.deepEqual(
    classifyNotification({author: 'worker'}, 'coordinator'),
    {kind: 'thread_replies', shouldNotify: false},
  );
  assert.deepEqual(
    classifyNotification({author: 'human'}, 'coordinator'),
    {kind: 'member_messages', shouldNotify: false},
  );
  assert.deepEqual(
    classifyNotification({author: 'coordinator'}, 'coordinator'),
    {kind: 'coordinator_posts', shouldNotify: true},
  );
  assert.deepEqual(
    classifyNotification({author: 'worker', viewerMentioned: true}, 'mentions'),
    {kind: 'mentions', shouldNotify: true},
  );
  assert.deepEqual(
    classifyNotification({author: 'worker', needsInput: true}, 'coordinator'),
    {kind: 'needs_input', shouldNotify: true},
  );
  assert.deepEqual(
    classifyNotification({isDigest: true}, 'coordinator'),
    {kind: 'digest', shouldNotify: true},
  );
  assert.deepEqual(
    classifyNotification({author: 'coordinator'}, 'none'),
    {kind: 'coordinator_posts', shouldNotify: false},
  );

  // Sidebar badge: waitingCount 'answered' vs 'read'
  const readBlocked = makeThread({
    id: 'b-read',
    waitsOnLivePrompt: true,
    hasUnread: false,
    readAt: now,
    lastReplyAt: now - 1000,
  });
  assert.deepEqual(
    computeProjectSidebarBadge([readBlocked], {waitingCount: 'answered', now}),
    {kind: 'count', count: 1, blocked: true},
  );
  assert.deepEqual(
    computeProjectSidebarBadge([readBlocked], {waitingCount: 'read', now}),
    {kind: 'none'},
  );
  assert.deepEqual(
    computeProjectSidebarBadge([], {coordinatorWorking: true, now}),
    {kind: 'working'},
  );
  assert.deepEqual(
    computeProjectSidebarBadge([makeThread({hasUnread: true})], {now}),
    {kind: 'dot', count: 1},
  );
});

test('ProjectChannelStore persists timeline, threads, decisions, artifacts, files CAS, memory CAS, overview, and read-only lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-amber-store-'));
  try {
    const store = new ProjectChannelStore({
      projectId: 'proj-alpha',
      projectDataDir: dir,
      now: () => 5_000_000,
    });

    // Goal & timeline
    store.appendTimeline({
      type: 'goal',
      author: 'user',
      text: 'Build local multi-agent projects',
    });
    const thread = store.createThread({
      title: '',
      body: '# Investigate architecture\nCheck all modules carefully',
      boundSessionIds: ['sess-w1'],
    });
    assert.equal(thread.title, 'Investigate architecture');
    assert.deepEqual(thread.boundSessionIds, ['sess-w1']);

    // Decision card 2..4 options
    assert.throws(() =>
      store.askDecision({
        question: 'Only one option?',
        options: [{label: 'One', consequence: 'Bad'}],
      }),
    );
    const card = store.askDecision({
      threadId: thread.id,
      question: 'Choose isolation strategy',
      context: 'Git repository detected.',
      options: [
        {label: 'Git worktree', consequence: 'Isolates branch cleanly'},
        {label: 'Shared root', consequence: 'Faster but shares index'},
      ],
      recommended: 0,
      reason: 'Prevents merge conflicts across workers.',
    });
    assert.equal(card.status, 'open');
    assert.equal(store.getThread(thread.id)?.openDecisionCount, 1);

    const decided = store.decide(card.id, {optionIndex: 0, chosenBy: 'user'});
    assert.equal(decided.status, 'answered');
    assert.equal(decided.chosenIndex, 0);
    assert.equal(store.getThread(thread.id)?.openDecisionCount, 0);

    // Artifacts
    const art = store.publishArtifact({
      threadId: thread.id,
      kind: 'artifact',
      title: 'Design Spec',
      pathOrUrl: 'specs/design.md',
    });
    store.setArtifactPinned(art.id, true);
    assert.equal(store.listArtifacts({filter: 'pinned'}).length, 1);

    // Shared files with overwrite:false & keepBoth(1..21)
    const firstWrite = store.writeFile({
      path: 'notes/plan.md',
      content: 'v1',
      overwrite: false,
    });
    assert.equal(firstWrite.ok, true);
    const conflict = store.writeFile({
      path: 'notes/plan.md',
      content: 'v2',
      overwrite: false,
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'EEXIST');

    const kept = store.writeFile({
      path: 'notes/plan.md',
      content: 'v2',
      overwrite: false,
      keepBoth: true,
    });
    assert.equal(kept.ok, true);
    assert.equal(kept.path, 'notes/plan (1).md');

    // Identical write succeeds cleanly
    const same = store.writeFile({
      path: 'notes/plan.md',
      content: 'v1',
      overwrite: false,
    });
    assert.equal(same.ok, true);
    assert.equal(same.status, 'unchanged');

    // Path traversal blocked
    assert.throws(() =>
      store.writeFile({path: '../escape.txt', content: 'nope'}),
    );

    // Memory SHA-256 CAS precondition
    const memCreated = store.createMemory('/MEMORY.md', '# Project Memory\n');
    assert.equal(memCreated.ok, true);
    const memDup = store.createMemory('/MEMORY.md', '# Duplicate');
    assert.equal(memDup.ok, false);
    assert.equal(memDup.code, 'PRECONDITION_FAILED');

    const memStale = store.updateMemory(
      '/MEMORY.md',
      '# Stale',
      '0000000000000000',
    );
    assert.equal(memStale.ok, false);
    assert.equal(memStale.code, 'PRECONDITION_FAILED');

    const memRead = store.readMemory('/MEMORY.md');
    assert.equal(memRead.content, '# Project Memory\n');
    const memUpdated = store.updateMemory(
      '/MEMORY.md',
      '# Project Memory\n- Added fact\n',
      memRead.sha256,
    );
    assert.equal(memUpdated.ok, true);

    // Overview status page, recap, sections optimistic version
    store.setStatusPage('<section id="progress"><h2>Progress</h2></section>');
    store.setRecap('Worker 1 finished schema review.');
    store.dismissRecap(true);
    assert.equal(store.getRecap()?.dismissed, true);
    const s0 = store.getSections();
    const s1 = store.updateSections({
      hiddenIds: ['old'],
      order: ['progress'],
      expectedVersion: s0.version,
    });
    assert.equal(s1.ok, true);
    const sConflict = store.updateSections({
      hiddenIds: [],
      expectedVersion: s0.version,
    });
    assert.equal(sConflict.ok, false);
    assert.equal(sConflict.code, 'PRECONDITION_FAILED');

    // Paused / archived read-only guard
    store.setReadOnlyState({paused: true, archived: false});
    assert.throws(
      () => store.writeFile({path: 'blocked.txt', content: 'x'}),
      ProjectReadOnlyError,
    );
    assert.throws(
      () => store.createThread({title: 'Blocked'}),
      ProjectReadOnlyError,
    );
    assert.throws(
      () => store.updateMemory('/MEMORY.md', 'x', memUpdated.sha256!),
      ProjectReadOnlyError,
    );
    store.setReadOnlyState({paused: false, archived: true});
    assert.throws(
      () => store.appendTimeline({type: 'coordinator_post', text: 'hi'}),
      ProjectReadOnlyError,
    );
    store.setReadOnlyState({paused: false, archived: false});

    // Reopen persistence check
    const reopened = new ProjectChannelStore({
      projectId: 'proj-alpha',
      projectDataDir: dir,
    });
    assert.ok(reopened.readTimeline().length >= 4);
    assert.equal(reopened.listThreads().length, 1);
    assert.equal(reopened.readMemory('/MEMORY.md').content, '# Project Memory\n- Added fact\n');
    assert.equal(reopened.getStatusPage(), '<section id="progress"><h2>Progress</h2></section>');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ProjectWorktreeManager creates git worktrees, checks dirty state, refuses silent dirty discard, merges, and runs BFS family cascade', async () => {
  const fix = createGitFixture();
  const dataDir = path.join(fix.dir, 'project-data');
  const mgr = new ProjectWorktreeManager();
  try {
    const ws = await mgr.createThreadWorkspace({
      projectRoot: fix.root,
      projectDataDir: dataDir,
      threadId: 'thread-abc123',
      title: 'Fix parser',
    });
    assert.equal(ws.isGit, true);
    assert.ok(ws.worktreePath.includes('.mp-worktrees'));
    assert.ok(ws.branch.startsWith('mp/'));

    // Clean initially
    const clean = await mgr.inspectUncommittedChanges({
      projectRoot: fix.root,
      worktreePath: ws.worktreePath,
    });
    assert.equal(clean.status, 'clean');

    // Make uncommitted edit -> dirty
    fs.writeFileSync(path.join(ws.worktreePath, 'work.txt'), 'uncommitted\n', 'utf8');
    const dirty = await mgr.inspectUncommittedChanges({
      projectRoot: fix.root,
      worktreePath: ws.worktreePath,
    });
    assert.equal(dirty.status, 'dirty');
    assert.ok(dirty.changes.length >= 1);

    // Silent discard refused
    const refused = await mgr.discardWorktree({
      projectRoot: fix.root,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'DIRTY_WORKTREE');

    // Commit and merge
    const merged = await mgr.mergeWorktree({
      projectRoot: fix.root,
      worktreePath: ws.worktreePath,
      branch: ws.branch,
      commitMessage: 'Add work.txt from worker',
    });
    assert.equal(merged.ok, true);
    assert.equal(
      fs.readFileSync(path.join(fix.root, 'work.txt'), 'utf8'),
      'uncommitted\n',
    );

    // Non-git fallback
    const nonGitDir = path.join(fix.dir, 'non-git-proj');
    fs.mkdirSync(nonGitDir, {recursive: true});
    const fallback = await mgr.createThreadWorkspace({
      projectRoot: nonGitDir,
      projectDataDir: dataDir,
      threadId: 'thread-nongit',
    });
    assert.equal(fallback.isGit, false);
    assert.ok(fs.existsSync(fallback.worktreePath));

    // BFS family archive cascade
    const family: ProjectThreadRecord[] = [
      makeThread({id: 'parent'}),
      makeThread({id: 'child-idle', parentThreadId: 'parent'}),
      makeThread({
        id: 'child-running',
        parentThreadId: 'parent',
        boundSessions: [{id: 'sr', status: 'active', working: true}],
      }),
      makeThread({
        id: 'grandchild-pr',
        parentThreadId: 'child-idle',
        openPrUrl: 'https://github.com/org/repo/pull/1',
      }),
      makeThread({
        id: 'grandchild-idle',
        parentThreadId: 'child-idle',
      }),
    ];
    const cascade = await mgr.planFamilyArchiveCascade(family, 'parent');
    assert.deepEqual(
      new Set(cascade.archiveThreadIds),
      new Set(['parent', 'child-idle', 'grandchild-idle']),
    );
    assert.deepEqual(
      new Set(cascade.detachThreadIds),
      new Set(['child-running', 'grandchild-pr']),
    );
  } finally {
    fix.cleanup();
  }
});

test('Project.* Coordinator tools, prompt builder, auto-mode rules, and ProjectStore backward compatibility work end-to-end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-amber-tools-'));
  try {
    const projectStore = createProjectStore({baseDir: path.join(dir, 'projects-meta')});
    const created = projectStore.create({name: 'Apollo'});
    assert.ok(created.ok);
    const updated = projectStore.update(created.project.id, {
      goal: 'Ship v2',
      color: '#D97757',
      projectIcon: 'Projects',
      paused: false,
      coordinatorSessionId: 'coord-1',
      multiAgentConfig: {
        agentTeam: 'squad',
        coordinatorModel: 'claude-opus-4-7',
        workerModel: 'claude-sonnet-4-6',
        autoModeRules: ['tool:Project.*', 'bash:npm test*'],
        limitAutoContinue: true,
        quietAfterDays: 3,
        autoResolveDays: 7,
        notifyLevel: 'coordinator',
        waitingCount: 'answered',
      },
    });
    assert.ok(updated.ok);
    assert.equal(updated.project.goal, 'Ship v2');
    assert.equal(updated.project.multiAgentConfig?.notifyLevel, 'coordinator');

    // Invalid lifecycle in ProjectStore rejected
    const badLifecycle = projectStore.update(created.project.id, {
      multiAgentConfig: {quietAfterDays: 10, autoResolveDays: 5},
    });
    assert.equal(badLifecycle.ok, false);

    // Auto-mode rules max 50 & evaluator
    const tooMany = validateAutoModeRules(
      Array.from({length: 51}, (_, i) => `tool:Read_${i}`),
    );
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error, 'too_many_auto_mode_rules');

    assert.equal(
      evaluateAutoModeRule(['tool:Project.*', 'bash:npm test*'], {
        toolName: 'Project.start_thread',
      }).allowed,
      true,
    );
    assert.equal(
      evaluateAutoModeRule(['bash:npm test*'], {
        toolName: 'Bash',
        command: 'npm test -- --watch=false',
      }).allowed,
      true,
    );
    assert.equal(
      evaluateAutoModeRule(['bash:npm test*'], {
        toolName: 'Bash',
        command: 'rm -rf /',
      }).allowed,
      false,
    );

    const channelStore = new ProjectChannelStore({
      projectId: created.project.id,
      projectDataDir: path.join(dir, 'channel-data'),
    });
    const worktreeMgr = new ProjectWorktreeManager();
    const registry = new ToolRegistry();
    const startedPrompts: string[] = [];
    const registered = registerProjectCoordinatorTools(registry, {
      project: updated.project,
      channelStore,
      worktreeManager: worktreeMgr,
      onStartThread: async (thread, prompt) => {
        startedPrompts.push(`${thread.id}:${prompt}`);
      },
    });
    assert.equal(registered.length, 12);

    const startRes = await registry.execute({
      id: 'c1',
      name: 'Project.start_thread',
      arguments: {title: 'API audit', prompt: 'Audit all IPC endpoints'},
    });
    assert.equal(startRes.is_error, false);
    const threadId = (startRes.value as {thread: ProjectThreadRecord}).thread.id;
    assert.equal(startedPrompts.length, 1);

    const msgRes = await registry.execute({
      id: 'c2',
      name: 'Project.message_thread',
      arguments: {threadId, message: 'Also check preload exposure'},
    });
    assert.equal(msgRes.is_error, false);

    const listRes = await registry.execute({
      id: 'c3',
      name: 'Project.list_threads',
      arguments: {},
    });
    assert.equal((listRes.value as {threads: unknown[]}).threads.length, 1);

    const readRes = await registry.execute({
      id: 'c4',
      name: 'Project.read_thread',
      arguments: {threadId},
    });
    assert.equal(readRes.is_error, false);

    const memRes = await registry.execute({
      id: 'c5',
      name: 'Project.update_memory',
      arguments: {
        path: '/MEMORY.md',
        content: '# Apollo Memory\n- IPC checked',
        mode: 'create',
      },
    });
    assert.equal(memRes.is_error, false);

    const fileRes = await registry.execute({
      id: 'c6',
      name: 'Project.write_file',
      arguments: {path: 'notes/audit.md', content: 'Audit ok'},
    });
    assert.equal(fileRes.is_error, false);

    const readFileRes = await registry.execute({
      id: 'c7',
      name: 'Project.read_file',
      arguments: {path: 'notes/audit.md'},
    });
    assert.equal((readFileRes.value as {content: string}).content, 'Audit ok');

    const decRes = await registry.execute({
      id: 'c8',
      name: 'Project.ask_decision',
      arguments: {
        threadId,
        question: 'Proceed with migration?',
        options: [
          {label: 'Yes', consequence: 'Migrates schema'},
          {label: 'No', consequence: 'Keeps legacy'},
        ],
        recommended: 0,
      },
    });
    assert.equal(decRes.is_error, false);

    const artRes = await registry.execute({
      id: 'c9',
      name: 'Project.publish_artifact',
      arguments: {
        threadId,
        kind: 'file',
        title: 'Audit Report',
        pathOrUrl: 'notes/audit.md',
      },
    });
    assert.equal(artRes.is_error, false);

    const pageRes = await registry.execute({
      id: 'c10',
      name: 'Project.refresh_status_page',
      arguments: {
        html: '<section id="audit"><h2>Audit</h2></section>',
        recapText: 'Audit thread started.',
      },
    });
    assert.equal(pageRes.is_error, false);

    const diffRes = await registry.execute({
      id: 'c11',
      name: 'Project.inspect_worktree_diff',
      arguments: {threadId},
    });
    assert.equal(diffRes.is_error, false);

    const resolveRes = await registry.execute({
      id: 'c12',
      name: 'Project.set_thread_resolved',
      arguments: {threadId, resolved: true},
    });
    assert.equal(resolveRes.is_error, false);

    const prompt = buildProjectCoordinatorPrompt({
      project: updated.project,
      threads: channelStore.listThreads(),
      memoryPreview: '# Apollo Memory',
      viewing: {tab: 'overview'},
    });
    assert.ok(prompt.includes('Ship v2'));
    assert.ok(prompt.includes('Apollo Memory'));
    assert.ok(prompt.includes('Project.start_thread'));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('ProjectOverview browser-global module loads cleanly without import/export and renders all multi-agent surfaces', () => {
  const tsSource = fs.readFileSync('electron/renderer/project_overview.ts', 'utf8');
  assert.equal(/^\s*(?:import|export)\s/m.test(tsSource), false);

  const compiled = ts.transpileModule(tsSource, {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText;

  class MockElement {
    tagName: string;
    className = '';
    id = '';
    innerHTML = '';
    textContent = '';
    value = '';
    disabled = false;
    hidden = false;
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    children: MockElement[] = [];
    listeners = new Map<string, Array<(e: any) => void>>();
    constructor(tagName = 'div') {
      this.tagName = tagName.toLowerCase();
    }
    setAttribute(k: string, v: string) {
      this.attributes[k] = v;
    }
    getAttribute(k: string) {
      return this.attributes[k] ?? null;
    }
    addEventListener(type: string, fn: (e: any) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    replaceChildren(...nodes: MockElement[]) {
      this.children = nodes;
    }
    append(...nodes: MockElement[]) {
      this.children.push(...nodes);
    }
    querySelector(): MockElement | null {
      return null;
    }
    querySelectorAll(): MockElement[] {
      return [];
    }
  }

  const sandbox: Record<string, any> = {
    window: {},
    document: {
      createElement: (tag: string) => new MockElement(tag),
      addEventListener: () => {},
    },
    globalThis: {},
    CdsIcons: require('../electron/renderer/cds_icons.ts'),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(compiled, sandbox);

  assert.equal(typeof sandbox.ProjectOverview?.mount, 'function');
  const host = new MockElement('div');
  const thread = makeThread({id: 'thr-ui', title: 'UI Audit', waitsOnLivePrompt: true});
  const decision: ProjectDecisionCard = {
    id: 'dec-1',
    projectId: 'proj-1',
    threadId: 'thr-ui',
    question: 'Ship layout?',
    options: [
      {label: 'Ship', consequence: 'Live now'},
      {label: 'Hold', consequence: 'Wait for QA'},
    ],
    recommended: 0,
    status: 'open',
    createdAt: 1000,
  };
  const artifact: ProjectPublishedArtifact = {
    id: 'art-1',
    projectId: 'proj-1',
    kind: 'artifact',
    title: 'Overview Report',
    pathOrUrl: 'report.md',
    pinned: true,
    createdAt: 1000,
    updatedAt: 1000,
  };
  const baseUiState = {
    project: {
      id: 'proj-1',
      root: 'D:/repo',
      name: 'Amber Project',
      goal: 'Coordinate workers',
      paused: false,
      multiAgentConfig: {
        agentTeam: 'squad',
        notifyLevel: 'coordinator',
        autoModeRules: ['tool:Project.*'],
        quietAfterDays: 3,
        autoResolveDays: 7,
      },
    },
    threads: [thread],
    timeline: [
      {
        seq: 1,
        id: 'ev-1',
        type: 'coordinator_post',
        timestamp: 1000,
        author: 'coordinator',
        text: 'Started worker pool.',
      },
    ],
    decisions: [decision],
    artifacts: [artifact],
    recap: {text: '1 thread waiting for decision', updatedAt: 1000},
    statusPageHtml: '<section id="summary"><h2>Summary</h2></section>',
    sections: {version: 1, hiddenIds: [], order: ['summary']},
    files: [{path: 'notes.md', size: 120, updatedAt: 1000}],
    memory: {path: '/MEMORY.md', content: '# Shared Memory', sha256: 'abc'},
    workers: [{step: 1, names: ['API Audit'], threadId: 'thr-ui', status: 'needs_input'}],
    actions: {
      onBack: () => {},
      onSendGoal: async () => {},
      onAnswerDecision: async () => {},
      onSelectThread: async () => {},
      onResolveThread: async () => {},
      onRemindThread: async () => {},
      onInspectDiff: async () => {},
      onDiscardThread: async () => {},
      onSaveMemory: async () => ({ok: true}),
      onSaveFile: async () => ({ok: true}),
      onSaveSettings: async () => ({ok: true}),
      onTogglePinArtifact: async () => {},
      onDismissRecap: async () => {},
      onUpdateSections: async () => {},
    },
  };

  sandbox.ProjectOverview.mount(host, {...baseUiState, activeTab: 'overview'});
  const overviewHtml = host.children[0]?.innerHTML || '';
  assert.ok(overviewHtml.includes('Amber Project'));
  assert.ok(overviewHtml.includes('Ship layout?'));
  assert.ok(overviewHtml.includes('sandbox="allow-scripts"'));

  sandbox.ProjectOverview.mount(host, {...baseUiState, activeTab: 'threads'});
  const rootEl = host.children[0]!;
  const threadsHtml = rootEl.innerHTML || '';
  assert.ok(threadsHtml.includes('Welcome back,'));
  assert.ok(threadsHtml.includes('Waiting on you'));
  assert.ok(threadsHtml.includes('UI Audit'));
  const clickHandlers = rootEl.listeners.get('click') || [];
  assert.ok(clickHandlers.length > 0);
  clickHandlers[0]({
    target: {
      matches: () => false,
      closest: (sel: string) =>
        sel === '[data-po-action]'
          ? {dataset: {poAction: 'toggle-board-view'}}
          : null,
    },
  });
  const boardHtml = rootEl.innerHTML || '';
  assert.ok(boardHtml.includes('Needs input'));
  assert.ok(boardHtml.includes('Ready for review'));
  assert.ok(boardHtml.includes('Working'));
  assert.ok(boardHtml.includes('Completed'));

  sandbox.ProjectOverview.mount(host, {...baseUiState, activeTab: 'artifacts'});
  const artifactsHtml = host.children[0]?.innerHTML || '';
  assert.ok(artifactsHtml.includes('Overview Report'));

  sandbox.ProjectOverview.mount(host, {...baseUiState, activeTab: 'files'});
  const filesHtml = host.children[0]?.innerHTML || '';
  assert.ok(filesHtml.includes('/MEMORY.md'));

  sandbox.ProjectOverview.mount(host, {...baseUiState, activeTab: 'settings'});
  const settingsHtml = host.children[0]?.innerHTML || '';
  assert.ok(settingsHtml.includes('Auto-Mode Rules'));
  assert.ok(settingsHtml.includes('Danger Zone'));
});
