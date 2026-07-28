const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

assert(html.includes('id="provenance-object-list"'), 'Activity needs source object navigation');
assert(html.includes('id="provenance-trace-panel"'), 'Activity needs a reverse trace panel');
assert(js.includes("fabricRequest('provenance.objects'"));
assert(js.includes("fabricRequest('provenance.trace'"));
assert(js.includes('data-task-id'));
assert(js.includes('data-artifact-id'));
assert(main.includes("'provenance.objects'"));
assert(main.includes("'provenance.trace'"));
assert(main.includes('MAGIC_POINTER_DASHBOARD_PROVENANCE_OBJECT_ID'), 'desktop capture must be able to open a real object trace');
assert(main.includes("fabricRequest('provenance.trace'"), 'desktop capture must query through the real bridge');
assert(!js.includes('trace.object.content'), 'Activity must not render captured object content');

console.log('dashboard provenance static test ok');
