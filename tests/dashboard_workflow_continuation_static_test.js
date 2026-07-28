const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

assert(html.includes('id="workflow-task-list"'), 'activity needs cross-surface workflow list');
assert(html.includes('CLI / GUI'), 'workflow section must name both surfaces');
assert(js.includes("fabricRequest('workflow.list'"), 'GUI must resume persisted workflow tasks');
assert(js.includes("fabricRequest('workflow.approve'"), 'GUI must preserve and explicitly change approval state');
assert(js.includes("fabricRequest('workflow.execute'"), 'GUI must continue the same task after approval');
assert(js.includes('workflow.taskId'), 'workflow UI must keep the durable task id');
assert(js.includes('approvalState'), 'workflow UI must render approval state');
assert(main.includes("'workflow.list'"));
assert(main.includes("'workflow.approve'"));
assert(main.includes("'workflow.execute'"));

console.log('dashboard workflow continuation static test ok');
require('./dashboard_agent_context_static_test.js');
require('./dashboard_provenance_static_test.js');
require('./dashboard_skill_candidates_static_test.js');
