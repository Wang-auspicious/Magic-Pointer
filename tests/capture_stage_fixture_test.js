'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const source = fs.readFileSync('scripts/capture_stage.ts', 'utf8');

assert.ok(source.includes('layout evidence'),
  'the capture helper must identify itself as layout-only evidence');
assert.ok(!source.includes('CHANGELOG.md'),
  'a layout fixture must not fabricate a file understanding result');
assert.ok(!source.includes("scene === 'approval-grid'"),
  'the reference collage must not survive as a fake product workflow');

console.log('capture stage fixture test ok');
