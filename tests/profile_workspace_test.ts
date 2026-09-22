const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { profileWorkspaceRoot } = require('../electron/profile_workspace');

const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-profile-ws-'));

assert.strictEqual(profileWorkspaceRoot(path.join(appRoot, 'nope')), '', 'missing app root must be empty');

const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ws-target-'));
const stateDir = path.join(appRoot, 'data', 'runtime');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'workspace.txt'), target);
assert.strictEqual(profileWorkspaceRoot(appRoot), target, 'workspace.txt dir must be returned');

fs.rmSync(path.join(stateDir, 'workspace.txt'));
fs.writeFileSync(path.join(stateDir, 'workspace.txt'), path.join(appRoot, 'gone-dir'));
assert.strictEqual(profileWorkspaceRoot(appRoot), '', 'vanished dir must resolve to empty');

fs.writeFileSync(path.join(stateDir, 'workspace.txt'), '   ');
assert.strictEqual(profileWorkspaceRoot(appRoot), '', 'blank content must be empty');

console.log('profile workspace root test ok');