'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const file = 'electron/renderer/studio_libraries.ts';
assert.ok(fs.existsSync(file), 'Projects, Scheduled and Customize need a real library controller');
const cells = new Map();
const sandbox = { module: { exports: {} }, localStorage: { getItem: k => cells.get(k) || null, setItem: (k, v) => cells.set(k, v) } };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const lib = sandbox.module.exports;
sandbox.CdsIcons = {html: name => `<i data-icon="${name}"></i>`};
assert.match(lib.chatsHeadingMarkup(false, false, ''), /mp-chats-heading[^]*<h1>Chats and tasks<\/h1>[^]*data-library-filters[^]*data-chat-selection/);
assert.match(lib.chatsHeadingMarkup(true, true, 'draft'), /data-library-search[^]*value="draft"/);
assert.match(lib.pluginDirectoryMarkup([{name:'Real plugin',description:'Local source',state:'configured'}], 'yours'), /mp-library-list[^]*mp-plugin-row[^]*Real plugin/);
assert.match(lib.pluginDirectoryMarkup([{name:'Real plugin'}], 'discover'), /mp-library-cards/);
const projectOptions = lib.projectOptionsMarkup([{name:'Alpha',root:'D:/alpha'},{name:'Beta',root:'D:/beta'}], 'D:/beta', 'be');
assert.match(projectOptions, /data-project-root="D:\/beta"[^]*aria-checked="true"/);
assert.doesNotMatch(projectOptions, /D:\/alpha/);
assert.match(lib.projectOptionsMarkup([], '', 'missing'), /No matching projects/);
assert.equal(lib.submenuSide(777, 248, 1037), 'left', 'right-edge Filters submenus must stay reachable by a real mouse');
assert.equal(lib.submenuSide(16, 248, 1037), 'right', 'sidebar menus expand into the available page space');
const now = Date.now();
const rows = [
  { id: 'a', title: 'Zebra', createdAt: now - 100000, updatedAt: now - 1000, turns: [] },
  { id: 'b', title: 'Apple', createdAt: now - 10000, updatedAt: now - 90000, taskContext: { taskId: 't' }, turns: [] },
  { id: 'c', title: 'Old', createdAt: now - 9e9, updatedAt: now - 9e9, turns: [] },
];
lib.setSessionPreference('b', { archived: true, pinned: true });
assert.deepEqual(Array.from(lib.filterRows(rows)).map(x => x.id), ['a', 'c'], 'archive is independent of task completion');
lib.setFilter('status', 'all');
lib.setFilter('sort', 'name');
assert.deepEqual(Array.from(lib.filterRows(rows)).map(x => x.id), ['b', 'c', 'a']);
lib.setFilter('days', '7');
assert.deepEqual(Array.from(lib.filterRows(rows)).map(x => x.id), ['b', 'a']);
lib.setFilter('type', 'task');
assert.deepEqual(Array.from(lib.filterRows(rows)).map(x => x.id), ['b']);
lib.setFilter('type', 'all'); lib.setFilter('group', 'custom');
lib.setSessionPreference('a', { group: 'Research' });
assert.equal(lib.sections(lib.filterRows(rows), [])[0].label, 'Pinned');
assert.ok(lib.sections(lib.filterRows(rows), []).some(group => group.label === 'Research'));
assert.ok(cells.size > 0, 'organization preferences persist across views and relaunches');
lib.setSessionPreference('a', { pinned: true, order: 2 });
lib.movePinned('a', -1);
assert.equal(lib.sections(lib.filterRows(rows), [])[0].items[0].id, 'a', 'Move up changes persisted pinned order');
const candidates = lib.scheduledSources([{id:'c',title:'Task',taskContext:{sources:[
  {sourceId:'file',title:'Notes',identity:{absolutePath:'D:/notes.md'}},
  {sourceId:'web',title:'Web',identity:{url:'https://example.com'}},
]}}]);
assert.equal(candidates.length, 1, 'daily material tasks require the real local-source contract');
assert.equal(candidates[0].sourceId, 'file');
assert.equal(typeof lib.designRows, 'function', 'the Design library must show actual design artifacts');
assert.deepEqual(Array.from(lib.designRows([{kind:'image', name:'Poster'}, {kind:'text',name:'Notes'}, {kind:'design_system',name:'Brand'}], 'designs')).map(x => x.name), ['Poster']);
assert.deepEqual(Array.from(lib.designRows([{kind:'design_system',name:'Brand'}], 'systems')).map(x => x.name), ['Brand']);
assert.equal(typeof lib.inventoryErrors, 'function');
assert.equal(lib.inventoryErrors({ok:true,plugins:{error:'Plugin directory unreadable'},mcp:{error:'Invalid JSON'}}), 'Plugins: Plugin directory unreadable · MCP: Invalid JSON');
assert.equal(typeof lib.mountPreviews, 'function', 'original preview markup needs a real hover animation mount');
assert.equal(typeof lib.artifactPreviewMarkup, 'function');
assert.match(lib.artifactPreviewMarkup({name:'diagram.svg',kind:'image'}, '<svg viewBox="0 0 2 2"><circle r="1"/></svg>'), /<iframe[^>]*sandbox=""/);
assert.match(lib.artifactPreviewMarkup({name:'picture',kind:'image'}, 'data:image/png;base64,aGVsbG8='), /<img/);
const htmlPreview = lib.artifactPreviewMarkup({name:'page.html',kind:'code'}, '<main>Real saved page</main><script>window.run=true</script>');
assert.match(htmlPreview, /sandbox=""/);
assert.doesNotMatch(htmlPreview, /allow-scripts|allow-same-origin/);
assert.match(htmlPreview, /default-src/);
assert.match(htmlPreview, /Real saved page/);
assert.equal(lib.artifactDateGroups([{at:now,name:'a'},{at:now-86400000,name:'b'}],now).length,2);
assert.equal(typeof lib.applyBulkConversationAction, 'function');
assert.equal(lib.nextScheduledRun({enabled:true,trigger:{kind:'schedule',startAtMs:100,everyMs:50},lastRun:{triggerKind:'schedule',dueThroughMs:200}}),250);
assert.equal(lib.nextScheduledRun({enabled:false,trigger:{kind:'schedule',startAtMs:100,everyMs:50}}),Infinity);
assert.deepEqual(Array.from(lib.sortProjects([{root:'a',name:'Z',addedAt:10,lastOpenedAt:30},{root:'b',name:'A',addedAt:20,lastOpenedAt:25}], [{workspaceRoot:'b',updatedAt:40}], 'activity')).map(x=>x.root),['b','a']);
assert.deepEqual(Array.from(lib.sortProjects([{root:'a',name:'Z',addedAt:10},{root:'b',name:'A',addedAt:20}], [], 'created')).map(x=>x.root),['b','a']);
assert.deepEqual(Array.from(lib.sortSkills([{name:'A',modifiedAt:10},{name:'Z',modifiedAt:20}], 'edited')).map(x=>x.name),['Z','A']);
const previews = JSON.parse(fs.readFileSync('electron/renderer/assets/claude-reference/artifact-previews.json', 'utf8'));
for (const [name, duration] of [['docs',9000],['slides',7000],['design',8400]]) {
  assert.equal(previews[name].timeline.durationMs, duration);
  for (const track of previews[name].timeline.tracks) {
    assert.ok(previews[name].html.includes(`data-preview-part="${track.part}"`), `${name} timeline must target real extracted parts`);
    assert.ok(track.keyframes.length > 1);
  }
}
const studio = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const changeBlock = studio.slice(studio.indexOf('let conversationChangeRaf:'), studio.indexOf('// 收藏箱条目更新'));
const refreshes = []; let changeCallback; let frameCallback;
const changes = {
  Data: { onChange: callback => { changeCallback = callback; } },
  window: { requestAnimationFrame: callback => { frameCallback = callback; return 1; } },
  document: { getElementById: () => ({hidden:true}) },
  conversationNotificationSequence: 0, shell: {dataset:{view:'chats'}},
  libraryUi: {render: view => refreshes.push(view)}, refreshOpenConversation() {}, renderSidebar() {}, renderStudioHome() {}, renderArtifacts() {}, refreshStashSummaries() {},
};
vm.runInNewContext(ts.transpileModule(changeBlock, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, changes);
changeCallback({id:'renamed'}); frameCallback();
assert.deepEqual(refreshes,['chats'], 'rename and external settled turns refresh the currently open library');
changeCallback({id:'streaming',liveProgress:{}});
assert.equal(refreshes.length,1,'stream chunks must not reload the library');
(async () => {
  const called = [];
  const removal = await lib.applyBulkConversationAction(['a','b','c'], 'delete', async id => { called.push(id); return id === 'b' ? {ok:false,error:'Still running'} : {ok:true}; });
  assert.deepEqual(called, ['a','b','c'], 'bulk delete invokes the real delete contract for every selected conversation');
  assert.deepEqual(Array.from(removal.completed), ['a','c']);
  assert.deepEqual(Array.from(removal.errors), ['Still running'], 'failed deletions remain selected and visible');
  await lib.applyBulkConversationAction(['a','c'], 'archive', async () => { throw new Error('archive must not delete'); });
  assert.equal(lib.sessionPreference('a').archived, true);
  await lib.applyBulkConversationAction(['a'], 'unarchive', async () => { throw new Error('unarchive must not delete'); });
  assert.equal(lib.sessionPreference('a').archived, false);
  console.log('Studio library data behavior ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
