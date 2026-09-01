const assert = require('node:assert');
const {
  buildStudioSearchIndex,
  searchStudioIndex,
} = require('../electron/renderer/studio_search');

const index = buildStudioSearchIndex({
  conversations: [{
    id: 'c1',
    title: 'Claude 界面',
    subtitle: 'Studio',
    workspaceRoot: 'D:/Magic',
    updatedAt: 10,
  }],
  projects: [{ root: 'D:/Magic', name: 'Magic Pointer', lastOpenedAt: 20 }],
  commands: [{ name: 'compact', description: '压缩上下文' }],
  skills: [{ name: 'pdf', description: '处理 PDF' }],
  routes: [{ id: 'customize', label: '自定义', keywords: ['设置', '插件'] }],
});

assert.deepStrictEqual(searchStudioIndex(index, 'Claude').map((item: { key: string }) => item.key), [
  'conversation:c1',
]);
assert.strictEqual(searchStudioIndex(index, 'Magic')[0].key, 'project:D:/Magic');
assert.strictEqual(searchStudioIndex(index, '设置')[0].key, 'route:customize');
assert.strictEqual(searchStudioIndex(index, 'pdf')[0].key, 'skill:pdf');
assert.strictEqual(searchStudioIndex(index, '压缩')[0].key, 'command:compact');
assert.deepStrictEqual(searchStudioIndex(index, '', 8), []);

console.log('studio search test ok');
