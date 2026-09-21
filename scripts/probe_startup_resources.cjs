'use strict';

// Execute actual application startup in an isolated profile and hidden windows.
// External health requests/login registration are disabled; native hosts are real.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const childProcess = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/startup-resources-20260920');
const variant = process.argv[2] || 'after';
const realStash = process.argv.includes('--real-stash');
const profile = path.join(out, `${variant}-${process.pid}`);
fs.mkdirSync(profile, { recursive: true });
process.env.MAGIC_POINTER_USER_DATA_DIR = profile;
app.setPath('userData', profile);
app.setLoginItemSettings = () => {};
const settings = require('../build/electron/settings_store').defaultSettings();
settings.voice = { ...settings.voice, enabled: false };
settings.stash = { ...settings.stash, clipboard: false };
settings.context_trackers = [];
settings.models = { schemaVersion: 1, defaultProfileId: 'probe', profiles: [{
  schemaVersion: 1, id: 'probe', provider: 'local', displayName: 'Local fixture',
  apiMode: 'local', model: 'deepseek-v4.1-flash', enabled: true, models: [{ id: 'deepseek-v4.1-flash' }],
}] };
fs.writeFileSync(path.join(profile, 'fabric-settings.json'), JSON.stringify(settings));
fs.writeFileSync(path.join(profile, 'onboarding.json'), JSON.stringify({ schemaVersion: 2, status: 'ready', bootstrapVersion: 1 }));
const started = performance.now();
let previous = started;
const gaps = [];
const spawns = [];
const samples = [];
const realSpawn = childProcess.spawn;
childProcess.spawn = function (exe, args, options) {
  const before = performance.now();
  const child = realSpawn.call(this, exe, args, options);
  spawns.push({ pid: child.pid, exe: path.basename(String(exe)), args: (args || []).filter(s => /\.(py|ps1|exe)$/.test(s)).map(s => path.basename(s)),
    atMs: Math.round(before - started), spawnMs: Math.round(performance.now() - before) });
  return child;
};
app.on('browser-window-created', (_event, window) => {
  window.on('show', () => window.hide());
});
const tick = setInterval(() => {
  const now = performance.now(); gaps.push(now - previous - 50); previous = now;
}, 50);
const MAIN_PATH = path.join(root, 'build/electron/main.js');
const production = new Module(MAIN_PATH, module);
production.filename = MAIN_PATH;
production.paths = Module._nodeModulePaths(path.dirname(MAIN_PATH));
let extension = '\nrefreshModelHealth = async () => modelHealth;\nmodule.exports.openStudio = () => showDashboard({}, { activate: false });';
if (realStash) {
  // The real stash is read through its production IPC handler. No watcher or
  // write operation is started against the user's material library.
  const source = path.join(process.env.APPDATA, 'magic-pointer', 'stash');
  extension = '\nrefreshModelHealth = async () => modelHealth;\nmodule.exports.openStudio = () => { stashRuntime?.stop(); stashRuntime = createStashRuntime({baseDir:' + JSON.stringify(source) + ', clipboard}); return showDashboard({}, { activate:false }); };';
}
production._compile(fs.readFileSync(MAIN_PATH, 'utf8') + extension, MAIN_PATH);
app.whenReady().then(() => {
  const metrics = setInterval(() => { samples.push({ atMs: Math.round(performance.now() - started), processes: app.getAppMetrics() }); }, 500);
  setTimeout(() => { production.exports.openStudio(); }, 3500);
  let stashWitness = null;
  if (realStash) setTimeout(async () => {
    const studio = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('studio.html'));
    try {
      const wc = studio.webContents;
      stashWitness = await wc.executeJavaScript(`(async () => {
        const started = performance.now();
        document.getElementById('mode-design').click();
        show('stash'); await renderStash(true);
        document.querySelector('#stash-mode [data-mode="canvas"]').click();
        return { renderMs: Math.round(performance.now()-started), cards:document.querySelectorAll('.node').length,
          label:document.getElementById('composer-model-label').textContent,
          canvasHeight:document.getElementById('canvas').getBoundingClientRect().height,
          zoom:document.getElementById('zoom-val').textContent };
      })()`);
    } catch (error) { stashWitness = { error: String(error) }; }
  }, 6000);
  setTimeout(async () => {
    clearInterval(tick); clearInterval(metrics);
    const studio = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('studio.html'));
    const ui = studio ? await studio.webContents.executeJavaScript(`({ label:document.getElementById('composer-model-label')?.textContent, view:document.getElementById('shell')?.dataset.view })`) : null;
    const witness = { variant, elapsedMs: Math.round(performance.now() - started), maxMainThreadDelayMs: Math.round(Math.max(...gaps)),
      peakElectronWorkingSetMB: Math.round(Math.max(...samples.map(s => s.processes.reduce((sum, p) => sum + p.memory.workingSetSize, 0))) / 1024),
      spawns, ui, stashWitness, samples };
    fs.writeFileSync(path.join(out, `${variant}.json`), JSON.stringify(witness, null, 2));
    console.log(JSON.stringify({ ...witness, samples: undefined }));
    app.quit();
  }, 18000);
}).catch(error => { console.error(error); app.exit(1); });
