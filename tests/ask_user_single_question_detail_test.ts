import assert from 'node:assert/strict';
import { normalizedInput } from '../electron/runtime/session';

// A single AskUser question with option objects must keep what the model wrote
// for the user: header and per-option descriptions reach the question card.
const pending = normalizedInput({ question: 'Which surface first?', header: 'Priority', options: [
  { label: 'Plan card', description: 'The checklist.' },
  { label: 'Question card', description: 'Choices.' },
] });
assert.deepEqual(pending.options, ['Plan card', 'Question card'], 'flat labels stay for existing consumers');
assert.deepEqual(pending.questions, [{ question: 'Which surface first?', header: 'Priority', multiSelect: false, options: [
  { label: 'Plan card', description: 'The checklist.' },
  { label: 'Question card', description: 'Choices.' },
] }], 'single question dropped its header or option descriptions');

// Plain string options carry nothing extra, so the legacy shape is unchanged.
const plain = normalizedInput({ question: 'Format?', options: ['Brief', 'Full'] });
assert.equal(plain.questions, undefined);
console.log('AskUser single question keeps header and option descriptions');
