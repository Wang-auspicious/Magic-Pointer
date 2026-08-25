const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { profileWorkspaceRoot } = require('../electron/profile_workspace');

const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-profile-ws-'));

// 未配置：没有 workspace.txt → 空。
assert.strictEqual(profileWorkspaceRoot(path.join(appRoot, 'nope')), '', 'missing app root must be empty');

// 存在目录：返回该路径。
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ws-target-'));
const stateDir = path.join(appRoot, 'data', 'runtime');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'workspace.txt'), target);
assert.strictEqual(profileWorkspaceRoot(appRoot), target, 'workspace.txt dir must be returned');

// 路径已消失：回落空（与 Python read_workspace 的语义一致，不给 Stage 对话绑一个死目录）。
fs.rmSync(path.join(stateDir, 'workspace.txt'));
fs.writeFileSync(path.join(stateDir, 'workspace.txt'), path.join(appRoot, 'gone-dir'));
assert.strictEqual(profileWorkspaceRoot(appRoot), '', 'vanished dir must resolve to empty');

// 只写相对/空内容：空。
fs.writeFileSync(path.join(stateDir, 'workspace.txt'), '   ');
assert.strictEqual(profileWorkspaceRoot(appRoot), '', 'blank content must be empty');

console.log('profile workspace root test ok');