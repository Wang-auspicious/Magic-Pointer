'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'selectRuntimeModel');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-model-selection-'));
const context = { fs, path, ROOT: root, FABRIC_DATA_DIR: path.join(root, 'data'), process: { env: {} },
  fabricSettings: null, selectActiveProfileModel: () => null,
  invalidateRuntimeState() {},
  runPythonBridgePromise: () => { throw new Error('model selection must not cold-start the Python/Fabric runtime'); },
};
vm.runInNewContext(ts.transpileModule(fn.getText(ast), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, context);
void (async () => {
  try {
    const result = await context.selectRuntimeModel('vendor/model');
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.readFileSync(path.join(root, 'data/secrets/model.txt'), 'utf8').trim(), 'vendor/model');
    fs.mkdirSync(path.join(root, 'secrets'));
    await context.selectRuntimeModel('second');
    assert.equal(fs.readFileSync(path.join(root, 'secrets/model.txt'), 'utf8').trim(), 'second');
    context.process.env.MAGIC_POINTER_MODEL = 'fixed';
    assert.equal((await context.selectRuntimeModel('third')).ok, false);
    console.log('Model selection persists locally without Python startup or catalog I/O');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => {console.error(error);process.exitCode=1;});
