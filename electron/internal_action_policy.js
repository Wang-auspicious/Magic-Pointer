const SHOPPING_LIST_TARGET_URI = 'magic-pointer://dashboard/shopping-list/default';

function canAutoExecuteInternalProposal(parsed, proposal) {
  const shoppingListAction = Boolean(
    ['shopping_list_add', 'shopping_list_add_many'].includes(parsed?.intentKind)
    && parsed?.autoExecuteProposalId
    && parsed.autoExecuteProposalId === proposal?.id
    && ['shopping_list_add', 'shopping_list_add_many'].includes(proposal?.action_type)
    && parsed?.intentKind === proposal?.action_type
    && proposal?.confirmation_required === false
    && proposal?.target?.object_id === SHOPPING_LIST_TARGET_URI
    && proposal?.metadata?.trusted_local_intent === true
    && proposal?.metadata?.auto_execute === true
  );
  const targetPoint = proposal?.parameters?.target_point;
  const proposalPoint = proposal?.target?.point;
  const isReviewDelivery = parsed?.intentKind === 'review_draft_delivery';
  const isContextDelivery = parsed?.intentKind === 'context_prompt_delivery';
  const groundedPromptDelivery = Boolean(
    (isReviewDelivery || isContextDelivery)
    && parsed?.autoExecuteProposalId
    && parsed.autoExecuteProposalId === proposal?.id
    && proposal?.action_type === 'paste_text_to_foreground'
    && proposal?.confirmation_required === false
    && Number.isInteger(proposal?.parameters?.target_hwnd)
    && proposal.parameters.target_hwnd > 0
    && Number.isInteger(proposal?.parameters?.target_process_id)
    && proposal.parameters.target_process_id > 0
    && typeof proposal?.parameters?.target_title === 'string'
    && proposal.parameters.target_title.length > 0
    && proposal?.parameters?.target_point_space === 'physical_screen_pixels'
    && Array.isArray(targetPoint)
    && targetPoint.length === 2
    && targetPoint.every((value) => Number.isFinite(Number(value)))
    && Array.isArray(proposalPoint)
    && proposalPoint.length === 2
    && Number(proposalPoint[0]) === Number(targetPoint[0])
    && Number(proposalPoint[1]) === Number(targetPoint[1])
    && /^[a-f0-9]{64}$/i.test(String(proposal?.parameters?.text_sha256 || ''))
    && proposal?.parameters?.submit === false
    && proposal?.metadata?.trusted_local_intent === true
    && proposal?.metadata?.explicit_user_delivery_intent === true
    && proposal?.metadata?.auto_execute === true
    && proposal?.metadata?.no_submit === true
    && (
      isReviewDelivery
      || (
        proposal?.metadata?.delivery_kind === 'context_prompt_delivery'
        && String(proposal?.parameters?.context_session_id || '').startsWith('context-')
      )
    )
  );
  const fabricPlan = proposal?.parameters?.plan;
  const fabricAction = Boolean(
    parsed?.intentKind === 'fabric_recipe'
    && parsed?.autoExecuteProposalId
    && parsed.autoExecuteProposalId === proposal?.id
    && proposal?.action_type === 'fabric_recipe_execute'
    && proposal?.confirmation_required === false
    && String(proposal?.target?.object_id || '').startsWith('magic-pointer://fabric/recipe/')
    && proposal?.metadata?.trusted_local_intent === true
    && proposal?.metadata?.fabric_plan_signed === true
    && proposal?.metadata?.auto_execute === true
    && ['read', 'local_write'].includes(String(fabricPlan?.risk || ''))
    && (
      fabricPlan?.provider === 'internal'
      || String(fabricPlan?.provider || '').startsWith('artifact.')
      || String(fabricPlan?.provider || '').startsWith('local.')
    )
    && /^[a-f0-9]{64}$/i.test(String(fabricPlan?.integrityToken || ''))
  );
  return shoppingListAction || groundedPromptDelivery || fabricAction;
}

module.exports = { SHOPPING_LIST_TARGET_URI, canAutoExecuteInternalProposal };
