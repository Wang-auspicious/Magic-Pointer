const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { captureEligibility, classifyResult } = require('../electron/result_surface_policy');

for (const state of ['unsupported', 'error', 'empty']) {
  const result = captureEligibility({
    snapshot: { status: state, source_window: { title: 'Reshet论文 - Persistence - Obsidian 1.12.7' } },
    summary: { state, app: state === 'unsupported' ? null : 'application', hasContent: false },
  });
  assert.strictEqual(result.commandReady, false);
  assert.strictEqual(result.state, state);
  assert.strictEqual(result.autoDismissMs, 1800);
  assert.match(result.message, /Obsidian|选中内容|暂不支持/);
}

const ready = captureEligibility({
  snapshot: { status: 'ready', source_window: { title: 'paper.pdf - Microsoft Edge' } },
  summary: { state: 'ready', app: 'pdf', hasContent: true },
});
assert.strictEqual(ready.commandReady, true);
assert.strictEqual(ready.autoDismissMs, null);

const visualReady = captureEligibility({
  snapshot: {
    status: 'ready',
    source_kind: 'screen_region',
    capture_path: 'D:\\captures\\pointer.png',
    source_window: { title: 'Design review', hwnd: 44, pid: 55 },
    target_point: { x: 600, y: 500 },
  },
  summary: { state: 'ready', app: 'screen', hasContent: false, hasVisual: true },
});
assert.strictEqual(visualReady.commandReady, true);
assert.strictEqual(visualReady.state, 'visual-ready');
assert.strictEqual(visualReady.autoDismissMs, null);

const reviewTarget = captureEligibility({
  snapshot: {
    status: 'unsupported',
    source_window: { title: 'Agent conversation', hwnd: 88, pid: 99 },
    target_point: { x: 440, y: 820 },
  },
  summary: { state: 'unsupported', hasContent: false, hasActiveReview: true },
});
assert.strictEqual(reviewTarget.commandReady, true);
assert.strictEqual(reviewTarget.state, 'review-target');
assert.strictEqual(reviewTarget.autoDismissMs, null);

const contextTarget = captureEligibility({
  snapshot: {
    status: 'unsupported',
    source_window: { title: 'Codex', hwnd: 188, pid: 199 },
    target_point: { x: 540, y: 920 },
  },
  summary: { state: 'unsupported', hasContent: false, hasActiveContext: true },
});
assert.strictEqual(contextTarget.commandReady, true);
assert.strictEqual(contextTarget.state, 'context-target');

const missingRuntimeIssue = captureEligibility({
  snapshot: {
    status: 'ready',
    source_window: { title: 'Codex', hwnd: 188, pid: 199 },
    target_point: { x: 540, y: 920 },
  },
  summary: { state: 'ready', hasContent: true, hasActiveContext: false },
  reason: 'runtime-delivery',
});
assert.strictEqual(missingRuntimeIssue.commandReady, false);
assert.strictEqual(missingRuntimeIssue.state, 'no-runtime-issue');
assert.match(missingRuntimeIssue.message, /没有待交付的现场任务/);

const genericContextIsNotRuntimeIssue = captureEligibility({
  snapshot: {
    status: 'unsupported',
    source_window: { title: 'Codex', hwnd: 188, pid: 199 },
    target_point: { x: 540, y: 920 },
  },
  summary: {
    state: 'unsupported',
    hasActiveContext: true,
    activeContextWorkflowKind: 'context_pack',
  },
  reason: 'runtime-delivery',
});
assert.strictEqual(genericContextIsNotRuntimeIssue.commandReady, false);
assert.strictEqual(genericContextIsNotRuntimeIssue.state, 'no-runtime-issue');

const runtimeIssueTarget = captureEligibility({
  snapshot: {
    status: 'unsupported',
    source_window: { title: 'Codex', hwnd: 188, pid: 199 },
    target_point: { x: 540, y: 920 },
  },
  summary: {
    state: 'unsupported',
    hasActiveContext: true,
    activeContextWorkflowKind: 'runtime_issue',
  },
  reason: 'runtime-delivery',
});
assert.strictEqual(runtimeIssueTarget.commandReady, true);
assert.strictEqual(runtimeIssueTarget.state, 'runtime-issue-target');

const missingPidTarget = captureEligibility({
  snapshot: {
    status: 'unsupported',
    source_window: { title: 'Unknown agent', hwnd: 288 },
    target_point: { x: 540, y: 920 },
  },
  summary: { state: 'unsupported', hasContent: false, hasActiveContext: true },
});
assert.strictEqual(missingPidTarget.commandReady, false);

// classifyResult: PointerStage surface modes ('inline' | 'card' | 'error').

// Failure with no action proposals renders the stage error surface.
assert.strictEqual(classifyResult({ ok: false, error: 'x' }), 'error');
assert.strictEqual(classifyResult({ ok: false, error: 'x', actionProposals: [] }), 'error');
assert.strictEqual(classifyResult(null), 'error');

// Failure WITH action proposals still surfaces the proposals, not an error.
const failedWithProposal = classifyResult({
  ok: false,
  error: 'partial failure',
  actionProposals: [{ action_type: 'copy_text_to_clipboard' }],
});
assert.notStrictEqual(failedWithProposal, 'error');
assert.strictEqual(failedWithProposal, 'inline');

// Structured payloads map to stage cards.
assert.strictEqual(classifyResult({
  ok: true,
  intentKind: 'calendar_event_draft',
  calendarDraft: { event: { title: '周会', start_at: '2026-07-27 10:00' } },
}), 'card');
assert.strictEqual(classifyResult({
  ok: true,
  intentKind: 'route_draft',
  routeDraft: { origin: '公司', destination: '机场' },
}), 'card');
assert.strictEqual(classifyResult({
  ok: true,
  answer: '改写已准备',
  actionProposals: [{ action_type: 'office_replace_selection' }],
}), 'card');

// Declared intent without its draft body falls back to inline.
assert.strictEqual(classifyResult({ ok: true, intentKind: 'calendar_event_draft' }), 'inline');
assert.strictEqual(classifyResult({ ok: true, intentKind: 'route_draft' }), 'inline');

// Plain answers stay inline regardless of length or generic proposals.
assert.strictEqual(classifyResult({ ok: true, answer: '短译文', actionProposals: [] }), 'inline');
assert.strictEqual(classifyResult({ ok: true, answer: 'x'.repeat(500), actionProposals: [] }), 'inline');
assert.strictEqual(classifyResult({
  ok: true,
  answer: '已复制',
  actionProposals: [{ action_type: 'copy_text_to_clipboard' }],
}), 'inline');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
assert(mainSource.includes('reason: current.reason'));
assert(mainSource.includes('captureEligibility: entry.captureEligibility'));
assert(mainSource.includes('if (!session.captureEligibility?.commandReady)'));
assert(mainSource.includes('targetPoint: safeClone(session.snapshot?.target_point || null)'));
assert(mainSource.includes('targetPointSpace: session.snapshot?.target_point_space || null'));

console.log('result surface policy test ok');
