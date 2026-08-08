const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

assert(!fs.existsSync(path.join(root, 'app', 'main.py')), 'the retired Tk application must not return');

for (const removedLauncher of [
  'scripts/run.bat',
  'scripts/run_background_debug.bat',
  'scripts/start_background.bat',
]) {
  assert(!fs.existsSync(path.join(root, removedLauncher)), `${removedLauncher} must stay deleted`);
}

const launcher = read('scripts/start_electron_overlay.bat');
assert(launcher.includes('cd /d "%~dp0.."'), 'launcher must run from the repository root');
assert(!launcher.includes('app.main'), 'launcher must never fall back to the retired Tk application');
assert(launcher.includes('exit /b 1'), 'a missing Electron runtime must fail explicitly');

for (const vbsLauncher of ['scripts/MagicPointer.vbs', 'scripts/MagicPointerPanel.vbs']) {
  const source = read(vbsLauncher);
  assert(source.includes('ProjectDir = FSO.GetParentFolderName(ScriptDir)'), `${vbsLauncher} must resolve the repository root`);
}

const stopScript = read('scripts/stop_magic_pointer.ps1');
assert(!stopScript.includes('app.main'), 'the stop script must not retain the retired Python process matcher');

const systemContext = read('app/system_context.py');
assert(!systemContext.includes('tk_window'), 'Python system helpers must not retain Tk-specific code');

console.log('electron-only runtime test ok');
