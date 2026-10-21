const assert = require('assert');
const { STUDIO_VIEWS, normalizeView, shellState } = require('../electron/studio_shell');

assert.deepStrictEqual(
  STUDIO_VIEWS.map((view: { id: string }) => view.id),
  ['resources', 'personal', 'chat', 'design', 'stash', 'artifacts', 'dashboard', 'settings', 'projects', 'scheduled', 'customize', 'chats', 'designs'],
  'Studio keeps personal activity as a primary view and trajectory inside its conversation',
);
assert.strictEqual(new Set(STUDIO_VIEWS.map((view: { id: string }) => view.id)).size, STUDIO_VIEWS.length);
for (const view of STUDIO_VIEWS) {
  assert(String(view.title).trim());
  assert(String(view.description).trim());
  assert(String(view.eyebrow).trim());
}
assert.strictEqual(normalizeView('settings'), 'settings');
assert.strictEqual(normalizeView('personal'), 'personal');
assert.strictEqual(normalizeView('resources'), 'resources');
assert.strictEqual(shellState('resources').allowsDetail, false);
assert.strictEqual(shellState('personal').allowsDetail, false);
assert.strictEqual(normalizeView('hero'), 'chat', 'the removed marketing hero must not remain a route');
assert.strictEqual(normalizeView('unknown'), 'chat');
assert.deepStrictEqual(shellState('artifacts'), {
  activeView: 'artifacts',
  title: 'Artifacts',
  description: 'View, reuse, and export generated local artifacts.',
  eyebrow: 'LOCAL OUTPUTS',
  allowsDetail: true,
});

console.log('studio shell test ok');
