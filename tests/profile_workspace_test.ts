const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { profileWorkspaceRoot } = require('../electron/profile_workspace');

test('Stage reads the profile workspace from user data, not the old installation tree', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-profile-ws-'));
  const appRoot = path.join(base, 'app');
  const userDataDir = path.join(base, 'user-data');
  const oldTarget = path.join(base, 'old-target');
  const currentTarget = path.join(base, 'current-target');
  fs.mkdirSync(path.join(appRoot, 'data', 'runtime'), { recursive: true });
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(oldTarget);
  fs.mkdirSync(currentTarget);
  fs.writeFileSync(path.join(appRoot, 'data', 'runtime', 'workspace.txt'), oldTarget);

  assert.strictEqual(profileWorkspaceRoot(userDataDir), '', 'a legacy install file must not become the current profile value');
  fs.writeFileSync(path.join(userDataDir, 'workspace.txt'), currentTarget);
  assert.strictEqual(profileWorkspaceRoot(userDataDir), currentTarget);
  fs.writeFileSync(path.join(userDataDir, 'workspace.txt'), path.join(base, 'gone-dir'));
  assert.strictEqual(profileWorkspaceRoot(userDataDir), '', 'a vanished directory must resolve to empty');
  fs.writeFileSync(path.join(userDataDir, 'workspace.txt'), '   ');
  assert.strictEqual(profileWorkspaceRoot(userDataDir), '', 'blank content must be empty');
});

test('local sync preserves a valid legacy workspace before replacing installed files', { skip: process.platform !== 'win32' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-workspace-upgrade-'));
  const installedRoot = path.join(base, 'installed');
  const userDataDir = path.join(base, 'user-data');
  const oldStateDir = path.join(installedRoot, 'resources', 'app', 'data', 'runtime');
  const workspace = path.join(base, '中文工作区');
  fs.mkdirSync(oldStateDir, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(oldStateDir, 'workspace.txt'), workspace);
  const migration = path.join(__dirname, '..', 'scripts', 'migrate_workspace.ps1');
  assert.match(fs.readFileSync(migration, 'utf8'), /Get-Content[^\r\n]*-Encoding UTF8/,
    'Windows PowerShell 5.1 must decode the old workspace path as UTF-8 on non-UTF-8 machines');
  const run = () => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', migration,
    '-InstalledRoot', installedRoot, '-UserDataDir', userDataDir], { encoding: 'utf8' });

  const first = run();
  assert.strictEqual(first.status, 0, first.stderr || first.stdout);
  assert.strictEqual(fs.readFileSync(path.join(userDataDir, 'workspace.txt'), 'utf8'), workspace);

  const chosenLater = path.join(base, 'chosen-later');
  fs.mkdirSync(chosenLater);
  fs.writeFileSync(path.join(userDataDir, 'workspace.txt'), chosenLater);
  const second = run();
  assert.strictEqual(second.status, 0, second.stderr || second.stdout);
  assert.strictEqual(fs.readFileSync(path.join(userDataDir, 'workspace.txt'), 'utf8'), chosenLater,
    'an upgrade must not overwrite a newer profile choice');

  fs.rmSync(path.join(userDataDir, 'workspace.txt'));
  fs.writeFileSync(path.join(oldStateDir, 'workspace.txt'), path.join(base, 'missing-folder'));
  const third = run();
  assert.strictEqual(third.status, 0, third.stderr || third.stdout);
  assert.strictEqual(fs.existsSync(path.join(userDataDir, 'workspace.txt')), false,
    'a deleted workspace must not be migrated');

  const sync = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sync_install.ps1'), 'utf8');
  const migrateAt = sync.indexOf('migrate_workspace.ps1');
  assert.ok(migrateAt >= 0 && migrateAt < sync.indexOf('robocopy.exe $unpackedDir $installedDir'),
    'local sync must migrate before it replaces the installed tree');
  const installer = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'installer.nsh'), 'utf8');
  assert.match(installer, /!macro customInit\b/, 'NSIS must copy legacy state before uninstallOldVersion');
  assert.match(installer, /CopyFiles[^\r\n]*workspace\.txt/, 'NSIS must copy legacy state before uninstallOldVersion');
});
