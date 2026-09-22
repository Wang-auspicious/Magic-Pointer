'use strict';

(() => {
type AnswerShapeName = 'deliver' | 'inspect';
type UnknownRecord = Record<string, unknown>;

interface AnswerShapeInput {
  command?: unknown;
  result?: unknown;
}

interface AnswerShapeResult {
  allowMarkdown: boolean;
  needsConsent: boolean;
  reason: string;
  shape: AnswerShapeName;
}


const WRITE_BACK_ACTIONS = Object.freeze([
  'office_replace_selection',
  'capsule_delivery',
  'draft_delivery',
  'text_replace',
]);

const INSPECT_KINDS = Object.freeze([
  'image', 'slot', 'table', 'metric', 'steps', 'prompt',
]);

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function proposalTypes(result: UnknownRecord): string[] {
  const list = Array.isArray(result?.actionProposals) ? result.actionProposals : [];
  return list.map((value: unknown) => {
    const proposal = recordOf(value);
    return String(proposal?.action_type || proposal?.actionType || '');
  });
}

function answerShape(input: AnswerShapeInput = {}): AnswerShapeResult {
  const result = recordOf(input.result) ?? {};

  const kind = String(result.kind || '');
  if (INSPECT_KINDS.includes(kind)) return shape('inspect', `kind=${kind}`);
  if (kind === 'proposal') return shape('deliver', 'kind=proposal');

  const explicit = String(result.answerShape || result.deliverKind || '');
  if (explicit === 'deliver' || explicit === 'inspect') return shape(explicit, 'bridge');

  const types = proposalTypes(result);
  if (types.some((type) => WRITE_BACK_ACTIONS.includes(type))) return shape('deliver', 'write-back proposal');

  if (String(result.intentKind || '') === 'length_target') return shape('deliver', 'length_target');

  return shape('inspect', 'default');
}

function shape(name: AnswerShapeName, reason: string): AnswerShapeResult {
  const deliver = name === 'deliver';
  return {
    shape: name,
    reason,
    allowMarkdown: !deliver,
    needsConsent: deliver,
  };
}

const AnswerShapePolicy = {
  INSPECT_KINDS,
  WRITE_BACK_ACTIONS,
  answerShape,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AnswerShapePolicy;
}
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { AnswerShapePolicy?: typeof AnswerShapePolicy })
    .AnswerShapePolicy = AnswerShapePolicy;
}
})();
