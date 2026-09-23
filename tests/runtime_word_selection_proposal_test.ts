const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { handleSelection } = require('../electron/runtime/desktop_perception');
const { ActionBroker } = require('../electron/runtime/actions_delivery');
const { stageEventFromBridge } = require('../electron/stage_contract');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const original = '这是一段需要润色的文字。';
const replacement = '这段文字表达得更加清晰。';
const snapshot = {
  snapshot_id: 'word-snapshot', status: 'ok', structured_covers_mark: true,
  perception_trace: { selectedAdapter: 'office', liveIdentityMatched: true, conflicts: [] },
  source_window: { hwnd: 42, title: '示例.docx - Word' },
  context: {
    adapter: 'office', app: 'word', method: 'com:word.selection', content: original, error: null,
    window: { hwnd: 42, title: '示例.docx - Word' },
    artifacts: { document: 'C:\\docs\\示例.docx', document_name: '示例.docx', hwnd: 42,
      selection_start: 10, selection_end: 10 + original.length,
      selection_text_sha256: sha256(original), com_prog_id: 'Word.Application', host: 'microsoft_word' },
  },
};

async function main() {
  let agentInstruction = '';
  const runRuntime = async (payload: any) => { agentInstruction = payload.instruction; return { ok: true, answer: replacement, hasPendingWork: false }; };
  const result = await handleSelection({ command: '润色选中文字', selectionSnapshot: snapshot, selectionSessionId: 'selection-1' }, { runRuntime });
  assert.match(agentInstruction, /只输出.*替换文本/);
  assert.equal(result.actionProposals.length, 1);
  const proposal = result.actionProposals[0], parameters = proposal.parameters;
  assert.equal(proposal.action_type, 'office_replace_selection');
  assert.equal(proposal.confirmation_required, true);
  assert.equal(parameters.expected_text_excerpt, original);
  assert.equal(parameters.replacement_text_excerpt, replacement);
  assert.equal(parameters.document, snapshot.context.artifacts.document);
  assert.equal(parameters.document_name, snapshot.context.artifacts.document_name);
  assert.equal(parameters.hwnd, 42);
  assert.equal(parameters.selection_start, 10);
  assert.equal(parameters.selection_end, 10 + original.length);
  assert.equal(parameters.expected_text_sha256, sha256(original));
  assert.equal(parameters.replacement_text_sha256, sha256(replacement));
  assert.equal(parameters.selection_session_id, 'selection-1');
  assert.equal(parameters.selection_snapshot_id, 'word-snapshot');
  assert.match(result.answer, /原文预览：/);
  assert.match(result.answer, /替换为：/);
  const stage = stageEventFromBridge({ ...result, actionProposals: [{ ...proposal, action_token: 'preview-token' }] });
  assert.equal(stage.result.kind, 'text-draft');
  assert.equal(stage.result.original, original);
  assert.equal(stage.result.proposed, replacement);
  const unconfirmed = await new ActionBroker('word-preview', { root: tmpdir(), userDataDir: tmpdir() }).execute(proposal, false);
  assert.equal(unconfirmed.status, 'skipped');
  assert.match(unconfirmed.error, /confirmation required/);

  const fallbackSnapshot = { ...snapshot, context: { ...snapshot.context, artifacts: { ...snapshot.context.artifacts, selection_text_sha256: '' } } };
  const fallback = await handleSelection({ command: '润色选中文字', selectionSnapshot: fallbackSnapshot }, { runRuntime });
  assert.equal(fallback.actionProposals[0]?.parameters.expected_text_sha256, sha256(original));
  const translateAndReplace = await handleSelection({ command: '把选中文字翻译并写回文档', selectionSnapshot: snapshot }, { runRuntime });
  assert.equal(translateAndReplace.actionProposals[0]?.action_type, 'office_replace_selection');

  const base = { command: '润色选中文字', selectionSnapshot: snapshot };
  for (const [payload, reply] of [
    [{ ...base, command: '解释选中文字' }, { ok: true, answer: replacement }],
    [{ ...base, command: '总结选中文字' }, { ok: true, answer: replacement }],
    [{ ...base, command: '翻译选中文字' }, { ok: true, answer: replacement }],
    [{ ...base, command: '把选中文字润色后写入邮件' }, { ok: true, answer: replacement }],
    [{ ...base, selectionSnapshot: { ...snapshot, context: { ...snapshot.context, app: 'excel' } } }, { ok: true, answer: replacement }],
    [{ ...base, selectionSnapshot: { ...snapshot, perception_trace: { ...snapshot.perception_trace, conflicts: [{ reason: 'content_disagreement' }] } } }, { ok: true, answer: replacement }],
    [{ ...base, selectionSnapshot: { ...snapshot, context: { ...snapshot.context, artifacts: { ...snapshot.context.artifacts, selection_end: 10 } } } }, { ok: true, answer: replacement }],
    [{ ...base, selectionSnapshot: { ...snapshot, context: { ...snapshot.context, artifacts: { ...snapshot.context.artifacts, selection_start: null } } } }, { ok: true, answer: replacement }],
    [{ ...base, selectionSnapshot: { ...snapshot, context: { ...snapshot.context, artifacts: { ...snapshot.context.artifacts, selection_text_sha256: 'incorrect' } } } }, { ok: true, answer: replacement }],
    [base, { ok: true, answer: original }],
    [base, { ok: false, answer: replacement }],
    [base, { ok: true, answer: replacement, hasPendingWork: true }],
    [base, { ok: true, answer: replacement, receipts: [{ status: 'succeeded', wrote: true }] }],
  ] as [any, any][]) {
    const skipped = await handleSelection(payload, { runRuntime: async () => reply });
    assert.deepEqual(skipped.actionProposals, [], JSON.stringify(payload));
  }
  const existing = { id: 'already-proposed', action_type: 'office_replace_selection' };
  const duplicate = await handleSelection(base, { runRuntime: async () => ({ ok: true, answer: replacement, actionProposals: [existing] }) });
  assert.deepEqual(duplicate.actionProposals, [existing]);
  console.log('runtime Word selection proposal test passed');
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
