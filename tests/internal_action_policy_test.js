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

const main = fs.readFileSync('electron/main.js', 'utf8');
assert(main.includes("const { canAutoExecuteInternalProposal } = require('./internal_action_policy');"));
assert(main.includes('MAGIC_POINTER_USER_DATA_DIR: app.getPath(\'userData\')'));
assert(main.includes('canAutoExecuteInternalProposal(parsed, autoProposal)'));
assert(main.includes('autoExecuteProposalId'));

console.log('internal action policy test ok');
