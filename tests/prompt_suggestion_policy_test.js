'use strict';

// Next-prompt suggestions: when to ask, and what is fit to show.
//
// The reference's whole design is one sentence — "Would they think *I was just
// about to type that*?" — so the reject rules are not decoration. A ghost line
// the user would not have typed is worse than no ghost line, because it costs
// a model call and still has to be read and dismissed. The rules below are
// pinned individually so a future edit cannot quietly widen the channel.

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {
  SUGGESTION_PROMPT,
  CACHE_COLD_TOKENS,
  MIN_ASSISTANT_TURNS,
  suggestionGate,
  acceptSuggestion,
  createSuggestionThrottle,
} = require('../electron/runtime/prompt_suggestion');

const ready = {
  assistantTurns: 4,
  lastTurnTokens: 900,
};

test('the prompt keeps the two constraints that are easy to paraphrase away', () => {
  assert.match(SUGGESTION_PROMPT, /\[SUGGESTION MODE/);
  assert.match(SUGGESTION_PROMPT, /I was just about to type that/,
    'the test the model is asked to apply is the whole design');
  assert.match(SUGGESTION_PROMPT, /Even when the user is doing legitimate security/,
    'the unsafe-topic silence rule must survive editing; dropping it turns the feature into a suggestion engine for sensitive actions');
  assert.match(SUGGESTION_PROMPT, /2-12 words/);
});

test('a gate fires only when its condition holds', () => {
  assert.deepEqual(suggestionGate(ready), {allowed: true});
});

test('each gate is named so a skip can be told apart from a failure', () => {
  const cases = [
    [{...ready, aborted: true}, 'aborted'],
    [{...ready, assistantTurns: MIN_ASSISTANT_TURNS - 1}, 'early_conversation'],
    [{...ready, lastResponseError: true}, 'last_response_error'],
    [{...ready, lastTurnTokens: CACHE_COLD_TOKENS + 1}, 'cache_cold'],
    [{...ready, unfocused: true}, 'unfocused'],
    [{...ready, planMode: true}, 'plan_mode'],
    [{...ready, rateLimited: true}, 'rate_limit'],
    [{...ready, elicitationActive: true}, 'elicitation_active'],
    [{...ready, unusedStreak: 3}, 'throttled'],
  ];
  for (const [state, reason] of cases) {
    assert.deepEqual(suggestionGate(state), {allowed: false, reason}, reason);
  }
});

test('the cost gate sits at the reference ceiling', () => {
  assert.equal(CACHE_COLD_TOKENS, 10000);
  assert.deepEqual(suggestionGate({...ready, lastTurnTokens: CACHE_COLD_TOKENS}),
    {allowed: true},
    'the ceiling is exclusive; exactly at it still predicts');
});

test('an aborted turn never starts new work', () => {
  assert.deepEqual(
    suggestionGate({...ready, aborted: true, assistantTurns: 0}),
    {allowed: false, reason: 'aborted'},
    'aborted outranks every other reason');
});

test('a suggestion the user would plausibly type survives', () => {
  assert.equal(acceptSuggestion('run the tests'), 'run the tests');
  assert.equal(acceptSuggestion('try it out'), 'try it out');
  assert.equal(acceptSuggestion('yes'), 'yes', 'a bare yes is a complete instruction');
  assert.equal(acceptSuggestion('commit this'), 'commit this');
  assert.equal(acceptSuggestion('/clear'), '/clear', 'a slash command is complete at one word');
  assert.equal(acceptSuggestion('  go ahead  '), 'go ahead', 'surrounding whitespace is not part of the answer');
});

test('each reject rule fires on its own example', () => {
  const rejected = {
    done: 'done',
    meta_text: 'no suggestion',
    meta_wrapped: '(silence)',
    error_message: 'api error: 429',
    // Not "Suggestion:" — that prefix is stripped, not rejected. This rule is
    // for labels the model invented on its own.
    prefixed_label: 'Note: run the tests',
    too_few_words: 'tests',
    too_many_words: 'run the tests and then commit and push and open the pull request now',
    too_long: 'x'.repeat(120),
    multiple_sentences: 'run the tests. Then commit',
    has_formatting: 'run the tests\nand commit',
    evaluative: 'looks good',
    assistant_voice: "I'll run the tests",
  };
  for (const [rule, example] of Object.entries(rejected)) {
    assert.equal(acceptSuggestion(example), null, `${rule} must reject ${JSON.stringify(example)}`);
  }
});

test('rejection is on the model answer, not on the instruction it was given', () => {
  assert.equal(acceptSuggestion(''), null);
  assert.equal(acceptSuggestion('   '), null);
  assert.equal(acceptSuggestion(null), null);
  assert.equal(acceptSuggestion(undefined), null);
});

test('the wrapper strip runs before the rules judge the text', () => {
  assert.equal(acceptSuggestion('<suggestion>run the tests</suggestion>'), 'run the tests');
  assert.equal(acceptSuggestion('suggestion: commit this'), 'commit this');
  // Stripping must not become a bypass: the unwrapped text is still filtered.
  assert.equal(acceptSuggestion('<suggestion>looks good</suggestion>'), null);
});

test('praise is rejected at a word boundary only', () => {
  assert.equal(acceptSuggestion('nice'), null);
  assert.equal(acceptSuggestion('nice work on the parser'), null,
    'praise must not pass just because it was extended');
});

test('the throttle counts offers and only a use resets it', () => {
  const throttle = createSuggestionThrottle();
  assert.equal(throttle.throttled(), false);
  throttle.offered();
  throttle.offered();
  assert.equal(throttle.unusedStreak(), 2);
  assert.deepEqual(suggestionGate({...ready, unusedStreak: throttle.unusedStreak()}),
    {allowed: true},
    'still under the run length');
  throttle.offered();
  assert.equal(throttle.throttled(), true);
  assert.deepEqual(suggestionGate({...ready, unusedStreak: throttle.unusedStreak()}),
    {allowed: false, reason: 'throttled'});
  throttle.used();
  assert.equal(throttle.throttled(), false, 'using one brings them back');
  assert.equal(throttle.unusedStreak(), 0);
});
