'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/window-memory');
fs.mkdirSync(out, { recursive: true });

const useRealProfile = process.argv.includes('--real-profile');
if (!useRealProfile) {
  const profile = path.join(out, `profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  process.env.MAGIC_POINTER_USER_DATA_DIR = profile;
  app.setPath('userData', profile);
  app.setLoginItemSettings = () => {};
  const settings = require('../build/electron/settings_store').defaultSettings();
  settings.voice = { ...settings.voice, enabled: false };
  settings.stash = { ...settings.stash, clipboard: false };
  settings.context_trackers = [];
  fs.writeFileSync(path.join(profile, 'fabric-settings.json'), JSON.stringify(settings));
  fs.writeFileSync(path.join(profile, 'onboarding.json'), JSON.stringify({ schemaVersion: 2, status: 'ready', bootstrapVersion: 1 }));
}
const openStudio = process.argv.includes('--studio');

const bootLog = path.join(out, 'boot.log');
const boot = (message) => fs.appendFileSync(bootLog, `${new Date().toISOString()} ${message}\n`);

const started = performance.now();
boot(`loaded agent=${process.versions.electron} args=${process.argv.slice(1).join(' ')}`);
const MAIN_PATH = path.join(root, 'build/electron/main.js');
const production = new Module(MAIN_PATH, module);
production.filename = MAIN_PATH;
production.paths = Module._nodeModulePaths(path.dirname(MAIN_PATH));
boot('module created');
const extension = `
module.exports.openStudio = () => showDashboard({}, { activate: false });
module.exports.createSurfaces = () => { createOverlayWindow(); createStageWindow(); };
module.exports.ablate = {
  overlay: () => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy(); },
  stage: () => { if (stageWindow && !stageWindow.isDestroyed()) stageWindow.destroy(); },
  cursor: () => { if (agentCursorSurfaces) agentCursorSurfaces.dispose(); },
};`;
try {
  production._compile(fs.readFileSync(MAIN_PATH, 'utf8') + extension, MAIN_PATH);
  boot('main.js compiled with extension');
} catch (error) {
  boot(`compile failed: ${error && error.stack ? error.stack : String(error)}`);
  fs.writeFileSync(path.join(out, 'compile-error.txt'), String(error && error.stack ? error.stack : error));
  process.exit(1);
}

function windowRows() {
  return BrowserWindow.getAllWindows().map((w) => {
    let pid = -1;
    let url = '';
    try {
      pid = w.webContents.getOSProcessId();
      url = w.webContents.getURL();
    } catch { /* window already torn down */ }
    return {
      id: w.id,
      pid,
      visible: w.isVisible(),
      url: url.split('/').pop() || url,
      title: w.getTitle(),
    };
  });
}

const samples = [];
const marks = [];

function writeSteps() {
  const rows = marks.map((m) => {
    const after = samples.filter((s) => s.atMs >= m.atMs + 2000);
    const last = after[after.length - 1] || samples[samples.length - 1] || { processes: [] };
    const byType = {};
    for (const p of last.processes || []) {
      const key = p.type === 'Tab' ? `Tab:${p.window}` : p.type;
      byType[key] = p.wsMb;
    }
    return {
      label: m.label,
      atMs: m.atMs,
      totalWsMb: last.totalWsMb,
      windows: (last.windows || []).length,
      byType,
    };
  });
  fs.writeFileSync(path.join(out, 'ablate-steps.json'), JSON.stringify(rows, null, 2));
  return rows;
}
boot(`hasSingleInstanceLock=${app.hasSingleInstanceLock()} windows=${BrowserWindow.getAllWindows().length}`);
app.whenReady().then(() => {
  boot('app ready');
  const metrics = setInterval(() => {
    const rows = windowRows();
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const processes = app.getAppMetrics().map((p) => ({
      pid: p.pid,
      type: p.type,
      wsMb: Math.round(p.memory.workingSetSize / 1024),
      privateMb: Math.round(p.memory.privateBytes / 1024),
      window: byPid.get(p.pid) ? `${byPid.get(p.pid).url} (${byPid.get(p.pid).title})` : '',
    }));
    samples.push({
      atMs: Math.round(performance.now() - started),
      windows: rows,
      processes,
      totalWsMb: processes.reduce((s, p) => s + p.wsMb, 0),
    });
  }, 500);

  if (openStudio) setTimeout(() => { try { production.exports.openStudio(); } catch (e) { samples.push({ atMs: -1, error: String(e) }); } }, 6000);

  if (process.argv.includes('--create-surfaces')) {
    setTimeout(() => {
      try { production.exports.createSurfaces(); } catch (e) { samples.push({ atMs: -1, createError: String(e) }); }
      marks.push({ atMs: Math.round(performance.now() - started), label: '+surfaces' });
    }, 8000);
  }

  if (process.argv.includes('--ablate')) {
    const steps = [
      { at: 6000, label: 'baseline' },
      { at: 9000, label: '-stage', run: () => production.exports.ablate.stage() },
      { at: 12000, label: '-stage-cursor', run: () => production.exports.ablate.cursor() },
      { at: 15000, label: '-stage-cursor-overlay', run: () => production.exports.ablate.overlay() },
    ];
    for (const step of steps) {
      setTimeout(() => {
        try { if (step.run) step.run(); } catch (e) { samples.push({ atMs: -1, ablateError: String(e) }); }
        marks.push({ atMs: Math.round(performance.now() - started), label: step.label });
        setTimeout(() => writeSteps(), 2600);
      }, step.at);
    }
  }

  setTimeout(async () => {
    clearInterval(metrics);
    const peak = samples.reduce((best, s) => (s.totalWsMb > (best?.totalWsMb ?? -1) ? s : best), null);
    const peaks = new Map();
    for (const s of samples) {
      for (const p of s.processes || []) {
        const key = `${p.pid}:${p.type}:${p.window}`;
        if (!peaks.has(key) || peaks.get(key).wsMb < p.wsMb) peaks.set(key, p);
      }
    }
    let gpu = null;
    try {
      gpu = {
        featureStatus: app.getGPUFeatureStatus(),
        device: await app.getGPUInfo('basic'),
      };
    } catch (error) { gpu = { error: String(error) }; }

    const witness = {
      studio: openStudio,
      realProfile: useRealProfile,
      gpu,
      elapsedMs: Math.round(performance.now() - started),
      peakTotalMb: peak?.totalWsMb ?? null,
      peakAtMs: peak?.atMs ?? null,
      peakProcesses: (peak?.processes ?? []).slice().sort((a, b) => b.wsMb - a.wsMb),
      processPeaks: [...peaks.values()].sort((a, b) => b.wsMb - a.wsMb),
      marks,
      gpuAfterMarks: marks.map((m) => {
        const after = samples.filter((s) => s.atMs >= m.atMs + 2500);
        const last = after[after.length - 1] || samples[samples.length - 1];
        const gp = (last.processes || []).find((p) => p.type === 'GPU');
        return { label: m.label, atMs: m.atMs, gpuWsMb: gp ? gp.wsMb : null, gpuPrivateMb: gp ? gp.privateMb : null, totalWsMb: last.totalWsMb };
      }),
      windows: peak?.windows ?? [],
      timeline: samples.map((s) => ({
        atMs: s.atMs,
        totalWsMb: s.totalWsMb,
        windows: (s.windows || []).length,
        top: (s.processes || []).slice().sort((a, b) => b.wsMb - a.wsMb).slice(0, 5)
          .map((p) => `${p.type}${p.window ? ':' + p.window : ''}=${p.wsMb}MB`).join(' '),
      })),
    };
    const name = `${openStudio ? 'studio' : 'overlay'}${useRealProfile ? '-real' : ''}.json`;
    fs.writeFileSync(path.join(out, name), JSON.stringify(witness, null, 2));
    console.log(JSON.stringify({ ...witness, timeline: undefined }, null, 2));
    app.quit();
  }, 22000);
}).catch((error) => { console.error(error); app.exit(1); });
