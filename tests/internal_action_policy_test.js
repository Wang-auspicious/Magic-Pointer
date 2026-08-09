const assert = require('assert');
const fs = require('fs');
const { canAutoExecuteInternalProposal } = require('../electron/internal_action_policy');

const parsed = {
  intentKind: 'shopping_list_add',
  autoExecuteProposalId: 'proposal-1',
};
const proposal = {
  id: 'proposal-1',
  action_type: 'shopping_list_add',
  confirmation_required: false,
  target: { object_id: 'magic-pointer://dashboard/shopping-list/default' },
  metadata: { trusted_local_intent: true, auto_execute: true },
};

assert.strictEqual(canAutoExecuteInternalProposal(parsed, proposal), true);
assert.strictEqual(canAutoExecuteInternalProposal({
  intentKind: 'shopping_list_add_many', autoExecuteProposalId: 'proposal-many',
}, {
  ...proposal, id: 'proposal-many', action_type: 'shopping_list_add_many',
}), true);
const mutations = [
  [{ ...parsed, intentKind: 'model_action' }, proposal],
  [{ ...parsed, autoExecuteProposalId: 'other' }, proposal],
  [parsed, { ...proposal, action_type: 'office_replace_selection' }],
  [parsed, { ...proposal, confirmation_required: true }],
  [parsed, { ...proposal, target: { object_id: 'https://example.com/list' } }],
  [parsed, { ...proposal, metadata: { ...proposal.metadata, trusted_local_intent: false } }],
  [parsed, { ...proposal, metadata: { ...proposal.metadata, auto_execute: false } }],
];
for (const [candidateParsed, candidateProposal] of mutations) {
  assert.strictEqual(canAutoExecuteInternalProposal(candidateParsed, candidateProposal), false);
}
assert.strictEqual(canAutoExecuteInternalProposal({}, proposal), false);

const reviewParsed = {
  intentKind: 'review_draft_delivery',
  autoExecuteProposalId: 'draft-1',
};
const reviewProposal = {
  id: 'draft-1',
  action_type: 'paste_text_to_foreground',
  confirmation_required: false,
  target: { point: [450, 850], metadata: { hwnd: 909 } },
  parameters: {
    target_hwnd: 909,
    target_process_id: 910,
    target_title: 'Codex',
    target_point: [450, 850],
    target_point_space: 'physical_screen_pixels',
    text_sha256: 'a'.repeat(64),
    submit: false,
  },
  metadata: {
    trusted_local_intent: true,
    explicit_user_delivery_intent: true,
    auto_execute: true,
    no_submit: true,
  },
};
assert.strictEqual(canAutoExecuteInternalProposal(reviewParsed, reviewProposal), true);
const unsafeReviewMutations = [
  [{ ...reviewParsed, intentKind: 'model_action' }, reviewProposal],
  [reviewParsed, { ...reviewProposal, action_type: 'submit_form' }],
  [reviewParsed, { ...reviewProposal, parameters: { ...reviewProposal.parameters, submit: true } }],
  [reviewParsed, { ...reviewProposal, parameters: { ...reviewProposal.parameters, target_hwnd: null } }],
  [reviewParsed, { ...reviewProposal, parameters: { ...reviewProposal.parameters, target_process_id: null } }],
  [reviewParsed, { ...reviewProposal, parameters: { ...reviewProposal.parameters, target_point_space: 'dip' } }],
  [reviewParsed, { ...reviewProposal, metadata: { ...reviewProposal.metadata, no_submit: false } }],
];
for (const [candidateParsed, candidateProposal] of unsafeReviewMutations) {
  assert.strictEqual(canAutoExecuteInternalProposal(candidateParsed, candidateProposal), false);
}

const contextParsed = {
  intentKind: 'context_prompt_delivery',
  autoExecuteProposalId: 'context-draft-1',
};
const contextProposal = {
  ...reviewProposal,
  id: 'context-draft-1',
  parameters: {
    ...reviewProposal.parameters,
    context_session_id: 'context-1',
    target_profile: 'codex',
  },
  metadata: {
    ...reviewProposal.metadata,
    delivery_kind: 'context_prompt_delivery',
  },
};
assert.strictEqual(canAutoExecuteInternalProposal(contextParsed, contextProposal), true);
assert.strictEqual(
  canAutoExecuteInternalProposal(contextParsed, {
    ...contextProposal,
    metadata: { ...contextProposal.metadata, delivery_kind: 'review_prompt_delivery' },
  }),
  false,
);

const fabricParsed = {
  intentKind: 'fabric_recipe',
  autoExecuteProposalId: 'fabric-1',
};
const fabricProposal = {
  id: 'fabric-1',
  action_type: 'fabric_recipe_execute',
  confirmation_required: false,
  target: { object_id: 'magic-pointer://fabric/recipe/research.evidence_card' },
  parameters: {
    plan: {
      recipeId: 'research.evidence_card',
      risk: 'local_write',
      provider: 'artifact.evidence',
      integrityToken: 'b'.repeat(64),
    },
  },
  metadata: {
    trusted_local_intent: true,
    fabric_plan_signed: true,
    auto_execute: true,
  },
};
assert.strictEqual(canAutoExecuteInternalProposal(fabricParsed, fabricProposal), true);
for (const mutation of [
  { ...fabricProposal, confirmation_required: true },
  { ...fabricProposal, parameters: { plan: { ...fabricProposal.parameters.plan, risk: 'external_send' } } },
  { ...fabricProposal, parameters: { plan: { ...fabricProposal.parameters.plan, provider: 'agent.task' } } },
  { ...fabricProposal, parameters: { plan: { ...fabricProposal.parameters.plan, integrityToken: 'bad' } } },
]) {
  assert.strictEqual(canAutoExecuteInternalProposal(fabricParsed, mutation), false);
}

const main = fs.readFileSync('electron/main.ts', 'utf8');
assert(main.includes("const { canAutoExecuteInternalProposal } = require('./internal_action_policy');"));
assert(main.includes('MAGIC_POINTER_USER_DATA_DIR: FABRIC_DATA_DIR'));
assert(main.includes('canAutoExecuteInternalProposal(parsed, autoProposal)'));
assert(main.includes('autoExecuteProposalId'));
assert(main.includes("  'paste_text_to_foreground',"));
assert(main.includes("  'fabric_recipe_execute',"));
assert(main.includes("parsed?.intentKind === 'review_draft_delivery'"));
assert(main.includes("parsed?.intentKind === 'context_prompt_delivery'"));
assert(main.includes('dismissTemporarySurfaces({ invalidateSession: false, hideObserver: true })'));

console.log('internal action policy test ok');
