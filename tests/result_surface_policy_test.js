const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { captureEligibility, classifyResult, normalizeResultPreference } = require('../electron/result_surface_policy');

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

assert.strictEqual(normalizeResultPreference(), 'inline');
assert.strictEqual(normalizeResultPreference('reader'), 'reader');
assert.strictEqual(normalizeResultPreference('anything-else'), 'inline');
assert.strictEqual(classifyResult({ ok: false, error: 'x' }), 'inline-error');
assert.strictEqual(classifyResult({ ok: true, answer: '短译文', actionProposals: [] }), 'inline');
assert.strictEqual(classifyResult({ ok: true, answer: 'x'.repeat(500), actionProposals: [] }), 'expandable');
assert.strictEqual(classifyResult({
  ok: true,
  answer: '改写已准备',
  actionProposals: [{ action_type: 'office_replace_selection' }],
}), 'expandable');
assert.strictEqual(classifyResult({ ok: true, answer: '短译文' }, 'reader'), 'reader');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
assert(mainSource.includes('captureEligibility({ snapshot: attached.snapshot, summary: attached.summary })'));
assert(mainSource.includes('captureEligibility: entry.captureEligibility'));
assert(mainSource.includes('if (!session.captureEligibility?.commandReady)'));

console.log('result surface policy test ok');
