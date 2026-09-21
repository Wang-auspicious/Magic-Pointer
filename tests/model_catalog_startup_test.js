'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { collectModelCatalog } = require('../build/electron/model_runtime_config');
const ast = ts.createSourceFile('main.ts', fs.readFileSync('electron/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['configuredModelCatalog', 'getStudioModelCatalog'];
const fns = names.map(name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name));
assert(fns.every(Boolean), 'Studio needs a local current-model read independent of remote catalog discovery');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-catalog-startup-'));
let remoteCalls = 0;
let release;
const context = {
  fs, path, URL, Date, ROOT: root, FABRIC_DATA_DIR: path.join(root, 'user'),
  process: { env: {} }, fabricSettings: { models: { profiles: [] } }, credentialStore: null,
  collectModelCatalog, discoveredModelCatalogs: new Map(), legacyModelCatalog: [],
  modelCatalogRefresh: null, modelCatalogRefreshedAt: 0, modelCatalogErrors: new Map(),
  runPythonBridgePromise: () => { remoteCalls++; return new Promise(resolve => { release = resolve; }); },
};
vm.runInNewContext(ts.transpileModule(fns.map(n => n.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
void (async () => {
  try {
    fs.mkdirSync(path.join(root, 'secrets'));
    fs.writeFileSync(path.join(root, 'secrets/model.txt'), 'deepseek-v4.1-flash');
    fs.writeFileSync(path.join(root, 'secrets/openai_base_url.txt'), 'https://opencode.ai/zen/v1');
    const initial = await context.getStudioModelCatalog(false);
    assert.equal(initial.current, 'deepseek-v4.1-flash');
    assert.equal(initial.provider, 'opencode-zen');
    assert.equal(remoteCalls, 0, 'boot must neither start Python nor await a provider');
    const first = context.getStudioModelCatalog(true);
    const second = context.getStudioModelCatalog(true);
    assert.equal(remoteCalls, 1, 'simultaneous menu opens must share remote discovery');
    fs.writeFileSync(path.join(root, 'secrets/model.txt'), 'kimi-k3');
    release({ catalog: { source: 'gateway', groups: [{ models: [{ id: 'deepseek-v4.1-flash', contextWindow: 1000000 }] }] } });
    assert.equal((await first).current, 'kimi-k3', 'late discovery must not restore an old selection');
    assert.equal((await second).current, 'kimi-k3');
    await context.getStudioModelCatalog(true);
    assert.equal(remoteCalls, 1, 'reopening a menu must reuse a recent directory');
    context.modelCatalogRefreshedAt = 0;
    const failedRefresh = context.getStudioModelCatalog(true);
    release({ catalog: { source: 'config', error: 'gateway_unreachable', groups: [{ models: [{ id: 'kimi-k3' }] }] } });
    assert.equal((await failedRefresh).error, 'gateway_unreachable', 'cached choices must not conceal a failed refresh');
    assert.equal((await context.getStudioModelCatalog(false)).current, 'kimi-k3');
    context.fabricSettings = { models: { defaultProfileId: 'p', profiles: [{ id: 'p', enabled: true, provider: 'local', model: 'local-model', apiMode: 'local', models: [{ id: 'local-model', contextWindow: 8192 }] }] } };
    const configured = await context.getStudioModelCatalog(false);
    assert.equal(configured.current, 'local-model');
    assert.equal(configured.groups[0].models[0].contextWindow, 8192);
    assert.equal(remoteCalls, 2);
    console.log('Current model is local; remote discovery is shared and cached without stale selection');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
