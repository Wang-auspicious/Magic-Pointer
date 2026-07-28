const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const source = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

assert(html.includes('id="agent-task-list"'));
assert(html.includes('目标租约任务'));
assert(source.includes("fabricRequest('task.list'"));
assert(source.includes("fabricRequest('task.reconfirm_target'"));
assert(source.includes('paused_target_mismatch'));
assert(source.includes('确认当前桌面的目标'));
assert(source.includes('confirmed: true'));
assert(main.includes("'task.reconfirm_target'"));
assert(main.includes("'task.list'"));

console.log('dashboard target lease static test ok');
