'use strict';

// The suggestion frequency backs off, and only using one brings it back.
//
// The reference drops the frequency after a run of suggestions the user left
// unused, and restores it the moment one is accepted. Two things must hold:
// the run length is the reference's three, and *accepting* is what resets it —
// if merely seeing a suggestion reset the counter the throttle would never
// engage, and the feature would nag forever.
//
// This is a source contract, not an execution test: the composer suggestion
// path in studio.ts touches Data, the placeholder, and the DOM, and standing
// all of that up would test the scaffolding rather than the rule. It pins the
// three commitments so a later edit has to change this file on purpose.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'electron', 'renderer', 'studio.ts'),
  'utf8',
);
const ast = ts.createSourceFile('studio.ts', source, ts.ScriptTarget.Latest, true);

function bodyOf(name) {
  let found = null;
  const walk = node => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.name.text === name &&
      node.body
    ) {
      found = node.body.getText(ast);
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  return found;
}

function initializerOf(name) {
  let found = null;
  const walk = node => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer.getText(ast);
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  return found;
}

assert.equal(initializerOf('COMPOSER_SUGGESTION_UNUSED_LIMIT'), '3',
  'the run length is the reference\'s three unused suggestions');
assert.equal(initializerOf('composerSuggestionUnused'), '0',
  'the streak starts empty');

const refresh = bodyOf('refreshComposerSuggestion');
assert.ok(refresh, 'refreshComposerSuggestion must still exist');
assert.match(refresh, /composerSuggestionUnused\s*>=\s*COMPOSER_SUGGESTION_UNUSED_LIMIT/,
  'refresh must check the streak before asking for another prediction');
assert.match(refresh, /composerSuggestionUnused\s*\+=\s*1/,
  'each suggestion actually offered counts toward the streak');

const accept = bodyOf('acceptComposerSuggestion');
assert.ok(accept, 'acceptComposerSuggestion must still exist');
assert.match(accept, /composerSuggestionUnused\s*=\s*0/,
  'accepting is what resets the streak, so backing off ends when the user engages');

assert.doesNotMatch(bodyOf('clearComposerSuggestion') ?? '', /composerSuggestionUnused\s*=\s*0/,
  'dismissing must not reset the streak; only using one does');

// The guard has to short-circuit before the request, or a throttled session
// would still pay for a model call it will not show.
const guardAt = refresh.indexOf('COMPOSER_SUGGESTION_UNUSED_LIMIT');
const requestAt = refresh.indexOf('suggestNextPrompt');
assert.ok(guardAt > -1 && requestAt > -1 && guardAt < requestAt,
  'the throttle must be checked before the prediction request, not after');

console.log('studio composer suggestion throttle ok');
