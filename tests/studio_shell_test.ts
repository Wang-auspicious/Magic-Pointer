const assert = require('assert');
const { STUDIO_VIEWS, normalizeView, shellState } = require('../electron/studio_shell');

assert.deepStrictEqual(
  STUDIO_VIEWS.map((view: { id: string }) => view.id),
  ['personal', 'chat', 'design', 'stash', 'artifacts', 'settings', 'projects', 'scheduled', 'customize', 'chats', 'designs'],
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
assert.strictEqual(shellState('personal').allowsDetail, false);
assert.strictEqual(normalizeView('hero'), 'chat', 'the removed marketing hero must not remain a route');
assert.strictEqual(normalizeView('unknown'), 'chat');
assert.deepStrictEqual(shellState('artifacts'), {
  activeView: 'artifacts',
  title: '产物',
  description: '查看、复用和导出已经生成的本地产物。',
  eyebrow: 'LOCAL OUTPUTS',
  allowsDetail: true,
});

console.log('studio shell test ok');
