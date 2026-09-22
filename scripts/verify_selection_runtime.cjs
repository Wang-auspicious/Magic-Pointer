'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/runtime/selection-multisource-20260919');
process.env.MAGIC_POINTER_PERMISSION_MODE = 'plan';
process.env.MAGIC_POINTER_INLOOP_REVERSIBLE = '0';
app.setName('magic-pointer');
app.setPath('userData', path.join(process.env.APPDATA, 'magic-pointer'));
const mainPath = path.join(root, 'build/electron/main.js');
const production = new Module(mainPath, module);
production.filename = mainPath;
production.paths = Module._nodeModulePaths(path.dirname(mainPath));
production._compile(fs.readFileSync(mainPath, 'utf8') + `
module.exports.selectionAcceptance = {
  run: (payload, onProgress, onComplete) => runPythonBridge({...payload, modelRuntime:activeModelRuntimeConfig()}, 'scripts/selection_bridge.py', null, {allowWithoutSurface:true,onProgress,onComplete}),
  model: () => {const r=activeModelRuntimeConfig();return r ? {model:r.model,provider:r.provider,apiMode:r.apiMode} : {model:fs.readFileSync(path.join(__dirname,'../../secrets/model.txt'),'utf8').trim(),configuration:'local'};},
  open: () => { onboardingWindow?.hide(); showDashboard({view:'chat'}, {activate:true}); }
};`, mainPath);
app.whenReady().then(() => {
  const api = production.exports.selectionAcceptance;
  if (process.argv.includes('--open-only')) {
    api.open();
    console.log(JSON.stringify({openedDeveloperBuild:mainPath,version:require('../package.json').version}));
    return;
  }
  const payload = JSON.parse(fs.readFileSync(path.join(out, 'request.json'), 'utf8'));
  payload.selectionSessionId += '-' + Date.now();
  const start = Date.now();
  fs.writeFileSync(path.join(out,'runtime-progress.jsonl'),'');
  console.log(JSON.stringify({model:api.model(),requestBytes:Buffer.byteLength(JSON.stringify(payload))}));
  api.run(payload, record => {
    fs.appendFileSync(path.join(out,'runtime-progress.jsonl'),JSON.stringify(record)+'\n');
  }, result => {
    const witness = {elapsedMs:Date.now()-start,model:api.model(),result};
    fs.writeFileSync(path.join(out,'runtime-result.json'),JSON.stringify(witness,null,2));
    console.log(JSON.stringify({elapsedMs:witness.elapsedMs,ok:result.ok,error:result.error,answer:result.answer,usedBackend:result.usedBackend}));
    if(process.argv.includes('--keep-open')) api.open();
    else app.exit(result.ok ? 0 : 1);
  });
}).catch(error=>{console.error(error);app.exit(1);});
