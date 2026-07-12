const SHOPPING_LIST_TARGET_URI = 'magic-pointer://dashboard/shopping-list/default';

function canAutoExecuteInternalProposal(parsed, proposal) {
  return Boolean(
    parsed?.intentKind === 'shopping_list_add'
    && parsed?.autoExecuteProposalId
    && parsed.autoExecuteProposalId === proposal?.id
    && proposal?.action_type === 'shopping_list_add'
    && proposal?.confirmation_required === false
    && proposal?.target?.object_id === SHOPPING_LIST_TARGET_URI
    && proposal?.metadata?.trusted_local_intent === true
    && proposal?.metadata?.auto_execute === true
  );
}

module.exports = { SHOPPING_LIST_TARGET_URI, canAutoExecuteInternalProposal };
