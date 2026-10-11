export interface ConversationModelSelection {
  model: string;
  profileId?: string;
}

export function normalizeModelSelection(
  value: unknown,
): ConversationModelSelection | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid model selection.');
  }
  const selection = value as Record<string, unknown>;
  const model =
    typeof selection.model === 'string' ? selection.model.trim() : '';
  if (
    !model ||
    model.length > 120 ||
    [...model].some(char => char === '\\' || char.charCodeAt(0) < 32)
  ) {
    throw new Error('Invalid model name.');
  }
  const profileId =
    typeof selection.profileId === 'string' ? selection.profileId.trim() : '';
  return {model, ...(profileId ? {profileId} : {})};
}
