const assert = require('assert');
const { STUDIO_VIEWS, normalizeView, shellState } = require('../electron/studio_shell');

assert.deepStrictEqual(
  STUDIO_VIEWS.map((view: { id: string }) => view.id),
  ['chat', 'stash', 'timeline', 'memory', 'artifacts', 'settings'],
  'Studio must have one canonical list of real work views',
);
assert.strictEqual(new Set(STUDIO_VIEWS.map((view: { id: string }) => view.id)).size, STUDIO_VIEWS.length);
for (const view of STUDIO_VIEWS) {
  assert(String(view.title).trim());
  assert(String(view.description).trim());
  assert(String(view.eyebrow).trim());
}
assert.strictEqual(normalizeView('settings'), 'settings');
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
