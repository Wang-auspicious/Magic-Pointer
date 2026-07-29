// Reuse the locally installed Electron distribution. This avoids electron-builder
// re-extracting Electron on every Windows build and keeps packaging offline-safe.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function electronDistDir() {
  return path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
}

function electronBuilderCli() {
  const packagePath = require.resolve('electron-builder/package.json');
  const bin = require(packagePath).bin;
  const relativeBin = typeof bin === 'string' ? bin : bin['electron-builder'];
  return path.join(path.dirname(packagePath), relativeBin);
}

function preparePythonRuntime({ root = ROOT, spawnSync: run = spawnSync } = {}) {
  const scriptPath = path.join(root, 'scripts', 'prepare_python_runtime.ps1');
  const result = run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Python runtime preparation failed with exit code ${result.status}`);
}

function runBuild(args, {
  platform = process.platform,
  root = ROOT,
  electronDist = electronDistDir(),
  electronBuilderCli: builderCli = electronBuilderCli(),
  nodeExecutable = process.execPath,
  spawnSync: run = spawnSync,
} = {}) {
  const electronExe = path.join(electronDist, 'electron.exe');
  if (!fs.existsSync(electronExe) && root === ROOT) {
    throw new Error(`Local Electron distribution is unavailable: ${electronExe}`);
  }
  if (platform === 'win32') preparePythonRuntime({ root, spawnSync: run });
  const result = run(
    nodeExecutable,
    [builderCli, `-c.electronDist=${electronDist}`, ...args],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return result.status == null ? 1 : result.status;
}

if (require.main === module) process.exitCode = runBuild(process.argv.slice(2));

module.exports = { preparePythonRuntime, runBuild };
