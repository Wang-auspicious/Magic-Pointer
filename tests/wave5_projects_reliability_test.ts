import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {ProjectChannelStore} from '../electron/project_channel_store';
import type {ProjectRecord} from '../electron/project_store';
import {
  buildProjectCoordinatorPrompt,
  computeWorkerStaggerDelayMs,
  enqueuePendingProjectRun,
  formatRateLimitExceededError,
  isRetryableRateLimitError,
  MAX_PROJECT_RATE_LIMIT_RETRIES,
  PROJECT_RATE_LIMIT_RETRY_DELAYS_MS,
  projectRunKey,
  WORKER_DISPATCH_STAGGER_MS,
} from '../electron/runtime/project_coordinator_tools';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }
});

describe('Wave 5 projects backend & IPC reliability', () => {
  it('syncs cross-process ProjectChannelStore mutations without stale RAM overwrite, persists routeFromOverview, and guards partial JSONL', () => {
    const dir = makeTempDir('mp-wave5-store-');
    let clock = 1_000_000;
    const now = () => {
      clock += 100;
      return clock;
    };

    const storeMain = new ProjectChannelStore({
      projectId: 'proj-sync',
      projectDataDir: dir,
      now,
    });
    const storeCoordinator = new ProjectChannelStore({
      projectId: 'proj-sync',
      projectDataDir: dir,
      now,
    });

    // Main populates seq=1..3 and warms its RAM caches (including empty threads/decisions/artifacts).
    storeMain.appendTimeline({type: 'goal', author: 'user', text: 'Audit repo'});
    storeMain.appendTimeline({
      type: 'coordinator_post',
      author: 'coordinator',
      text: 'Dispatching two auditors',
    });
    storeMain.appendTimeline({
      type: 'activity',
      author: 'system',
      text: 'Initialized run',
    });
    assert.equal(storeMain.listThreads().length, 0);
    assert.equal(storeMain.listDecisions().length, 0);
    assert.equal(storeMain.listArtifacts().length, 0);

    // Coordinator (separate process simulation) creates 审计A & 审计B + seq=4..6 + routed msg + decision + artifact.
    const threadA = storeCoordinator.createThread({
      id: 'thr-A',
      title: '审计A',
      body: 'Audit module A',
    });
    const threadB = storeCoordinator.createThread({
      id: 'thr-B',
      title: '审计B',
      body: 'Audit module B',
    });
    storeCoordinator.appendThreadMessage(threadA.id, {
      author: 'coordinator',
      text: 'Check auth edge cases',
      routeFromOverview: true,
    });
    storeCoordinator.appendTimeline({
      type: 'coordinator_post',
      author: 'coordinator',
      text: 'Started both threads',
    });
    const decA = storeCoordinator.askDecision({
      threadId: threadB.id,
      question: 'Pick validator',
      options: [
        {label: 'Strict', consequence: 'Fail fast'},
        {label: 'Lenient', consequence: 'Warn only'},
      ],
    });
    const artA = storeCoordinator.publishArtifact({
      threadId: threadA.id,
      kind: 'file',
      title: 'Audit A notes',
      pathOrUrl: 'notes/a.md',
    });

    // Main's read caches must invalidate on file stamp changes immediately.
    assert.equal(storeMain.listThreads().length, 2);
    assert.equal(storeMain.listDecisions().length, 1);
    assert.equal(storeMain.listArtifacts().length, 1);

    // Now main mutates threadA & appends timeline — must preserve 审计B and monotonic seq!
    storeMain.updateThread(threadA.id, {threadStatus: 'working'});
    storeMain.appendTimeline({
      type: 'activity',
      threadId: threadA.id,
      author: 'system',
      text: 'Worker A started',
    });

    // Coordinator adds a second decision & artifact; main updates first ones without clobbering.
    const decB = storeCoordinator.askDecision({
      question: 'Release target?',
      options: [
        {label: 'Canary', consequence: 'Gradual rollout'},
        {label: 'Stable', consequence: 'Direct release'},
      ],
    });
    const artB = storeCoordinator.publishArtifact({
      kind: 'link',
      title: 'Dashboard',
      pathOrUrl: 'https://example.local/dash',
    });
    storeMain.decide(decA.id, {optionIndex: 0, chosenBy: 'user'});
    storeMain.setArtifactPinned(artA.id, true);

    const storeVerify = new ProjectChannelStore({
      projectId: 'proj-sync',
      projectDataDir: dir,
    });
    const threads = storeVerify.listThreads();
    assert.equal(threads.length, 2);
    const verifiedA = threads.find(t => t.id === 'thr-A');
    const verifiedB = threads.find(t => t.id === 'thr-B');
    assert.ok(verifiedA, '审计A must exist');
    assert.ok(verifiedB, '审计B must exist');
    assert.equal(verifiedA.title, '审计A');
    assert.equal(verifiedB.title, '审计B');
    assert.equal(verifiedA.threadStatus, 'working');
    const routedMsg = verifiedA.messages?.[0] as
      | (NonNullable<typeof verifiedA.messages>[number] & {
          routeFromOverview?: boolean;
        })
      | undefined;
    assert.equal(routedMsg?.routeFromOverview, true);

    const timeline = storeVerify.readTimeline({includeHidden: true});
    const seqs = timeline.map(entry => entry.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'Timeline seq must have zero duplicates');
    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(seqs[i] > seqs[i - 1], 'Timeline seq must be strictly monotonic');
    }
    const routedTimelineEntry = timeline.find(e => e.type === 'message_routed');
    assert.equal(routedTimelineEntry?.payload?.routeFromOverview, true);

    const decisions = storeVerify.listDecisions();
    assert.equal(decisions.length, 2);
    assert.equal(decisions.find(d => d.id === decA.id)?.status, 'answered');
    assert.equal(decisions.find(d => d.id === decB.id)?.status, 'open');

    const artifacts = storeVerify.listArtifacts();
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts.find(a => a.id === artA.id)?.pinned, true);
    assert.ok(artifacts.find(a => a.id === artB.id));

    // Guard trailing partial JSON line in timeline.jsonl without swallowing valid-JSON schema errors.
    const timelinePath = path.join(dir, 'timeline.jsonl');
    const originalTimeline = fs.readFileSync(timelinePath, 'utf8');
    fs.writeFileSync(
      timelinePath,
      `${originalTimeline}{"seq":999,"id":"partial_line`,
      'utf8',
    );
    const partialSafe = storeVerify.readTimeline({includeHidden: true});
    assert.equal(partialSafe.length, timeline.length);

    // Valid JSON with wrong schema must still throw rather than silently returning [].
    const badSchemaDir = makeTempDir('mp-wave5-bad-schema-');
    fs.writeFileSync(path.join(badSchemaDir, 'threads.json'), '{"bad":true}', 'utf8');
    const badStore = new ProjectChannelStore({
      projectId: 'proj-bad',
      projectDataDir: badSchemaDir,
    });
    assert.throws(() => badStore.listThreads(), /Expected JSON array/i);
  });

  it('provides deterministic runKey queueing, stagger scheduling, HTTP 429 retry detection, and main.ts wiring', async () => {
    assert.equal(projectRunKey('p1'), 'p1:coordinator');
    assert.equal(projectRunKey('p1', 'thr-A'), 'p1:thr-A');
    assert.equal(projectRunKey('p1', 'thr-B'), 'p1:thr-B');
    assert.notEqual(
      projectRunKey('p1', 'thr-A'),
      projectRunKey('p1', 'thr-B'),
    );

    const queue: Array<{question: string}> = [];
    assert.deepEqual(enqueuePendingProjectRun(queue, {question: 'Follow up 1'}), {
      queued: true,
      queuedCount: 1,
    });
    assert.deepEqual(enqueuePendingProjectRun(queue, {question: '  Follow up 1  '}), {
      queued: false,
      queuedCount: 1,
    });
    assert.deepEqual(enqueuePendingProjectRun(queue, {question: 'Follow up 2'}), {
      queued: true,
      queuedCount: 2,
    });
    assert.equal(queue.length, 2);

    assert.equal(WORKER_DISPATCH_STAGGER_MS, 750);
    const d1 = computeWorkerStaggerDelayMs(undefined, 1000);
    assert.deepEqual(d1, {delayMs: 0, scheduledAt: 1000});
    const d2 = computeWorkerStaggerDelayMs(d1.scheduledAt, 1010);
    assert.deepEqual(d2, {delayMs: 740, scheduledAt: 1750});
    const d3 = computeWorkerStaggerDelayMs(d2.scheduledAt, 1020);
    assert.deepEqual(d3, {delayMs: 1480, scheduledAt: 2500});
    const d4 = computeWorkerStaggerDelayMs(d3.scheduledAt, 5000);
    assert.deepEqual(d4, {delayMs: 0, scheduledAt: 5000});

    assert.equal(MAX_PROJECT_RATE_LIMIT_RETRIES, 2);
    assert.deepEqual([...PROJECT_RATE_LIMIT_RETRY_DELAYS_MS], [2500, 6000]);
    assert.equal(isRetryableRateLimitError('backend_error:http_429'), true);
    assert.equal(isRetryableRateLimitError('rate_limit_error: slow down'), true);
    assert.equal(isRetryableRateLimitError('429 Too Many Requests'), true);
    assert.equal(isRetryableRateLimitError('ENOENT: missing file'), false);

    const formatted = formatRateLimitExceededError(
      'claude-sonnet-4',
      'rate_limit_error {"debug":{"stack":"noisy"}}',
    );
    assert.match(formatted, /Rate limit exceeded \(HTTP 429\) on claude-sonnet-4/);
    assert.match(formatted, /Switch models in the composer or retry shortly/);
    assert.doesNotMatch(formatted, /"debug"/);

    const mainSource = await readFile(
      path.join(process.cwd(), 'electron', 'main.ts'),
      'utf8',
    );
    assert.match(mainSource, /pendingProjectRuns\s*=\s*new Map/);
    assert.match(mainSource, /type:\s*'run_queued'/);
    assert.match(mainSource, /lastWorkerDispatchAtByProject\s*=\s*new Map/);
    assert.match(mainSource, /pendingWorkerTimersByRunKey\s*=\s*new Map/);
    assert.match(mainSource, /pendingRetryTimersByRunKey\s*=\s*new Map/);
    assert.match(mainSource, /retryNotice/);
    assert.match(mainSource, /activeRuns/);
    assert.match(mainSource, /modelContext/);
    assert.match(mainSource, /availableModels/);
    assert.match(mainSource, /userName/);
  });

  it('instructs coordinator not to poll newly started threads via Project.message_thread', () => {
    const project: ProjectRecord = {
      id: 'proj-prompt',
      name: 'Prompt Test',
      root: '/tmp/prompt',
      addedAt: 1,
      lastOpenedAt: 1,
      documents: [],
      resourceInbox: [],
    };
    const prompt = buildProjectCoordinatorPrompt({
      project,
      threads: [],
    });
    assert.match(prompt, /Project\.start_thread/);
    assert.match(prompt, /NEVER call `Project\.message_thread` immediately/);
    assert.match(prompt, /referencing worker threads by their exact title/);
  });
});
