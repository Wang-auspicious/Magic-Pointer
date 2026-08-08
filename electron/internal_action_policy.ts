const SHOPPING_LIST_TARGET_URI = 'magic-pointer://dashboard/shopping-list/default';

interface FabricPlan {
  risk?: string;
  provider?: string;
  integrityToken?: string;
}

interface InternalProposal {
  id?: string;
  action_type?: string;
  confirmation_required?: boolean;
  target?: {
    object_id?: string;
    point?: unknown;
  } | null;
  parameters?: {
    target_point?: unknown;
    target_hwnd?: number | null;
    target_process_id?: number | null;
    target_title?: string;
    target_point_space?: string;
    text_sha256?: string;
    submit?: boolean;
    context_session_id?: string;
    plan?: FabricPlan | null;
  } | null;
  metadata?: {
    trusted_local_intent?: boolean;
    auto_execute?: boolean;
    explicit_user_delivery_intent?: boolean;
    no_submit?: boolean;
    delivery_kind?: string;
    fabric_plan_signed?: boolean;
  } | null;
}

interface ParsedInternalAction {
  intentKind?: string;
  autoExecuteProposalId?: string;
}

function canAutoExecuteInternalProposal(
  parsed?: ParsedInternalAction | null,
  proposal?: InternalProposal | null,
): boolean {
  const shoppingListAction = Boolean(
    ['shopping_list_add', 'shopping_list_add_many'].includes(String(parsed?.intentKind || '')) &&
    parsed?.autoExecuteProposalId &&
    parsed.autoExecuteProposalId === proposal?.id &&
    ['shopping_list_add', 'shopping_list_add_many'].includes(String(proposal?.action_type || '')) &&
    parsed?.intentKind === proposal?.action_type &&
    proposal?.confirmation_required === false &&
    proposal?.target?.object_id === SHOPPING_LIST_TARGET_URI &&
    proposal?.metadata?.trusted_local_intent === true &&
    proposal?.metadata?.auto_execute === true,
  );
  const targetPoint = proposal?.parameters?.target_point;
  const proposalPoint = proposal?.target?.point;
  const targetHwnd = proposal?.parameters?.target_hwnd;
  const targetProcessId = proposal?.parameters?.target_process_id;
  const isReviewDelivery = parsed?.intentKind === 'review_draft_delivery';
  const isContextDelivery = parsed?.intentKind === 'context_prompt_delivery';
  const groundedPromptDelivery = Boolean(
    (isReviewDelivery || isContextDelivery) &&
    parsed?.autoExecuteProposalId &&
    parsed.autoExecuteProposalId === proposal?.id &&
    proposal?.action_type === 'paste_text_to_foreground' &&
    proposal?.confirmation_required === false &&
    Number.isInteger(targetHwnd) &&
    typeof targetHwnd === 'number' &&
    targetHwnd > 0 &&
    Number.isInteger(targetProcessId) &&
    typeof targetProcessId === 'number' &&
    targetProcessId > 0 &&
    typeof proposal?.parameters?.target_title === 'string' &&
    proposal.parameters.target_title.length > 0 &&
    proposal?.parameters?.target_point_space === 'physical_screen_pixels' &&
    Array.isArray(targetPoint) &&
    targetPoint.length === 2 &&
    targetPoint.every((value) => Number.isFinite(Number(value))) &&
    Array.isArray(proposalPoint) &&
    proposalPoint.length === 2 &&
    Number(proposalPoint[0]) === Number(targetPoint[0]) &&
    Number(proposalPoint[1]) === Number(targetPoint[1]) &&
    /^[a-f0-9]{64}$/i.test(String(proposal?.parameters?.text_sha256 || '')) &&
    proposal?.parameters?.submit === false &&
    proposal?.metadata?.trusted_local_intent === true &&
    proposal?.metadata?.explicit_user_delivery_intent === true &&
    proposal?.metadata?.auto_execute === true &&
    proposal?.metadata?.no_submit === true &&
    (isReviewDelivery ||
      (proposal?.metadata?.delivery_kind === 'context_prompt_delivery' &&
        String(proposal?.parameters?.context_session_id || '').startsWith('context-'))),
  );
  const fabricPlan = proposal?.parameters?.plan;
  const fabricAction = Boolean(
    parsed?.intentKind === 'fabric_recipe' &&
    parsed?.autoExecuteProposalId &&
    parsed.autoExecuteProposalId === proposal?.id &&
    proposal?.action_type === 'fabric_recipe_execute' &&
    proposal?.confirmation_required === false &&
    String(proposal?.target?.object_id || '').startsWith('magic-pointer://fabric/recipe/') &&
    proposal?.metadata?.trusted_local_intent === true &&
    proposal?.metadata?.fabric_plan_signed === true &&
    proposal?.metadata?.auto_execute === true &&
    ['read', 'local_write'].includes(String(fabricPlan?.risk || '')) &&
    (fabricPlan?.provider === 'internal' ||
      String(fabricPlan?.provider || '').startsWith('artifact.') ||
      String(fabricPlan?.provider || '').startsWith('local.')) &&
    /^[a-f0-9]{64}$/i.test(String(fabricPlan?.integrityToken || '')),
  );
  return shoppingListAction || groundedPromptDelivery || fabricAction;
}

export { SHOPPING_LIST_TARGET_URI, canAutoExecuteInternalProposal };
