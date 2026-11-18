import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

test('sidebar uses 16x16 high-contrast ellipsis glyph rather than microscopic 24x24 pinpricks', () => {
  const studioSource = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'studio.ts'),
    'utf8',
  );
  const iconsSource = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'icons.ts'),
    'utf8',
  );
  assert.ok(
    iconsSource.includes('<symbol id="ic-mp-chat-ellipsis"'),
    '16x16 CDS ellipsis symbol must remain defined',
  );
  const idx = studioSource.indexOf('ellipsis.dataset.sessionMenu');
  assert.ok(idx > 0, 'sidebar ellipsis button must exist');
  const nearby = studioSource.slice(Math.max(0, idx - 400), idx + 300);
  assert.match(
    nearby,
    /ic-mp-chat-ellipsis|CdsIcons\.html\(['"]dots/,
    'sidebar conversation row must use the full-size 16x16 ellipsis icon, not tiny ic-ellipsis',
  );
});

test('sidebar row renders a single mutual-exclusion status dot and hover swaps cleanly with ellipsis', () => {
  const css = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'studio_layout.css'),
    'utf8',
  );
  const studioSource = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'studio.ts'),
    'utf8',
  );

  assert.match(
    css,
    /\.side-actions\s*>\s*\.side-unread,\s*\.side-actions\s*>\s*\.status-dot,\s*\.side-actions\s*>\s*\.side-ellipsis\s*\{\s*grid-area:\s*1\s*\/\s*1;/s,
  );
  assert.match(
    css,
    /:is\(\.side-item,\s*\.df-session-list\s*>\s*button\):is\(:hover,\s*:focus-within,\s*\[data-menu-open\]\)\s*:is\(\.side-unread,\s*\.status-dot,\s*\[data-row-decoration\]\)\s*\{\s*opacity:\s*0;/s,
  );

  // Confirm conversationNode appends at most one dot per row across ready/awaiting/running/error
  const fnStart = studioSource.indexOf('function conversationNode(');
  const fnEnd = studioSource.indexOf('return row;', fnStart);
  const fnBody = studioSource.slice(fnStart, fnEnd);
  const dotCreates = fnBody.match(/createElement\(['"]span['"]\)/g) || [];
  assert.match(
    fnBody,
    /dot\.className\s*=\s*rowStatus === 'ready' \? 'status-dot side-unread' : 'status-dot'/,
    'conversationNode must emit a single unified status dot slot',
  );
  assert.ok(dotCreates.length <= 5);
});
