import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

function readRepo(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('Phase 2.1: Claude Desktop native selection bar (Start a side chat | Reply) exists and is wired', () => {
  const barPath = path.join(ROOT, 'electron/renderer/side_chat_bar.ts');
  assert.ok(fs.existsSync(barPath), 'side_chat_bar.ts must exist');
  const src = fs.readFileSync(barPath, 'utf8');
  assert.match(src, /Start a side chat/, 'must offer "Start a side chat" action');
  assert.match(src, /Send to side chat/, 'must switch label to "Send to side chat" when active');
  assert.match(src, /Reply/, 'must offer "Reply" action');

  const html = readRepo('electron/renderer/studio.html');
  assert.match(html, /side_chat_bar\.js/, 'studio.html must load side_chat_bar.js');

  const css = readRepo('electron/renderer/chat_styles.css');
  assert.match(css, /\.mp-selection-bar\b/, 'chat_styles.css must style .mp-selection-bar');

  const studioSrc = readRepo('electron/renderer/studio.ts');
  const legacyBlock = studioSrc.slice(
    studioSrc.indexOf('function bindSelectionActions()'),
    studioSrc.indexOf('function bindSelectionActions()') + 450,
  );
  assert.match(
    legacyBlock,
    /typeof\s+SideChatBar\s*!==\s*'undefined'/,
    'legacy bindSelectionActions must yield to SideChatBar so only one floating bar renders',
  );
});

test('Phase 2.2: Learn HUD is opt-in (zero clutter on default canvas) with header toggle', () => {
  const html = readRepo('electron/renderer/studio.html');
  assert.match(html, /id="chat-learn-toggle"/, 'header must expose compact #chat-learn-toggle');
  const css = readRepo('electron/renderer/learn_tree.css');
  assert.match(
    css,
    /#view-chat:not\(\[data-hud-expanded="true"\]\)\s+#learn-hud/,
    'default chat canvas must keep #learn-hud collapsed until user toggles it open',
  );
});

test('Phase 2.3: Concept Map layout spreads sibling concepts horizontally instead of a 1-column stick', () => {
  const mapCode = readRepo('electron/renderer/learn_map_view.ts');
  assert.match(
    mapCode,
    /semanticTier|cognitiveTier/,
    'layoutTopology must place nodes by semantic cognitive tiers rather than collapsing follows-chains into a 1-column stick',
  );
});
