import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const {
  normalizePermissionPreset,
  presetForPermissionMode,
} = require('../electron/permission_mode') as typeof import('../electron/permission_mode');

const ROOT = path.resolve(__dirname, '..');

test('conversations:learn-send maps stored PermissionMode safely via presetForPermissionMode', () => {
  assert.throws(
    () => normalizePermissionPreset('accept_reversible'),
    /Unknown permission preset/,
  );
  assert.equal(presetForPermissionMode('accept_reversible'), 'auto');
  assert.equal(presetForPermissionMode('safe'), 'read-only');
  assert.equal(presetForPermissionMode('default'), 'workspace-write');

  const mainSource = fs.readFileSync(
    path.join(ROOT, 'electron', 'main.ts'),
    'utf8',
  );
  const start = mainSource.indexOf("'conversations:learn-send'");
  assert.ok(start > 0);
  const handlerSlice = mainSource.slice(start, start + 6500);
  assert.ok(
    !handlerSlice.includes('normalizePermissionPreset(\n        source.taskContext?.permissionMode') &&
      handlerSlice.includes('presetForPermissionMode('),
    'conversations:learn-send must map source.taskContext.permissionMode with presetForPermissionMode instead of throwing Unknown permission preset',
  );
});

test('LearnTree supports reader priority ordering, source sentence jump-back, and clean KaTeX selection without doubled MathML', () => {
  const learnTs = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'learn_tree.ts'),
    'utf8',
  );
  const learnCss = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'learn_tree.css'),
    'utf8',
  );

  // Clean borderless branch cards (no outer box borders, no colored left stripes, no .is-draft-spawn popup)
  assert.match(learnCss, /\.mp-learn-branch-card\s*\{[^}]*border:\s*0;/s);
  assert.ok(
    !learnCss.includes('is-draft-spawn') && !learnTs.includes('is-draft-spawn'),
    'bottom-of-turn draft popup must stay removed',
  );

  // Selection extraction must exclude hidden .katex-mathml duplicates
  assert.ok(
    learnTs.includes('katex-mathml') || learnTs.includes('extractSelectionTextClean'),
    'LearnTree selection extraction must strip duplicated .katex-mathml accessibility text',
  );

  // Reader priority selector + jump-back to source sentence must be wired
  assert.ok(
    learnTs.includes('mp-learn-priority') || learnTs.includes('jumpToSourceAnchor'),
    'LearnTree must support reader priority selection and returning to the exact anchored sentence',
  );
});
