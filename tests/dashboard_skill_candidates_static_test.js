const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('electron/renderer/dashboard.html', 'utf8');
const js = fs.readFileSync('electron/renderer/dashboard.js', 'utf8');
const main = fs.readFileSync('electron/main.js', 'utf8');

assert(html.includes('id="skill-candidate-list"'), 'Capabilities needs candidate Skill list');
assert(html.includes('id="skill-draft-panel"'), 'Capabilities needs human-readable draft review');
assert(js.includes("fabricRequest('skills.candidates.list'"));
assert(js.includes("fabricRequest('skills.candidates.draft'"));
assert(js.includes("fabricRequest('skills.candidates.install'"));
assert(js.includes('candidate_disabled'));
assert(js.includes('installed_disabled'));
assert(js.includes('confirmed: false'), 'first install click must only request confirmation');
assert(js.includes('confirmed: true'), 'second install click must explicitly confirm');
assert(js.includes('reviewToken'), 'install must be bound to a displayed draft review token');
assert(js.includes('install.disabled'), 'install must remain locked before draft review');
assert(js.includes('保持禁用'), 'UI must state install remains disabled');
assert(main.includes("'skills.candidates.list'"));
assert(main.includes("'skills.candidates.draft'"));
assert(main.includes("'skills.candidates.install'"));
assert(main.includes('MAGIC_POINTER_DASHBOARD_SKILL_CANDIDATE_ID'), 'real desktop capture must open a candidate draft');
assert(main.includes("fabricRequest('skills.candidates.draft'"), 'desktop evidence must query the real bridge');
assert(!js.includes("fabricRequest('skills.candidates.enable'"), 'N16 must never auto-enable installed drafts');

console.log('dashboard Skill candidates static test ok');
