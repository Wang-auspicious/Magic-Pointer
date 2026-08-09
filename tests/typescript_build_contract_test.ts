'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const baseConfig = JSON.parse(read('tsconfig.json'));
const electronConfig = JSON.parse(read('tsconfig.electron.json'));
const toolsConfig = JSON.parse(read('tsconfig.tools.json'));
const testsConfig = JSON.parse(read('tsconfig.tests.json'));
const builder = read('electron-builder.yml');
const buildScript = read('scripts/build-electron.ts');
const testScript = read('scripts/run-node-tests.ts');

assert.strictEqual(packageJson.main, 'build/electron/main.js');
assert(packageJson.scripts.overlay.startsWith('npm run build:electron &&'));
assert(packageJson.scripts['pack:win'].startsWith('npm run build:electron &&'));
assert(packageJson.scripts['dist:win'].startsWith('npm run build:electron &&'));
assert(packageJson.scripts.typecheck.includes('tsconfig.electron.json'));
assert(packageJson.scripts.typecheck.includes('tsconfig.tools.json'));
assert(packageJson.scripts.typecheck.includes('tsconfig.tests.json'));
assert.strictEqual(baseConfig.compilerOptions.strict, true);
assert.strictEqual(baseConfig.compilerOptions.noEmitOnError, true);
assert.strictEqual(electronConfig.extends, './tsconfig.json');
assert.strictEqual(toolsConfig.extends, './tsconfig.json');
assert.strictEqual(testsConfig.extends, './tsconfig.json');
assert.deepStrictEqual(electronConfig.include, ['electron/**/*.ts']);
assert.deepStrictEqual(testsConfig.include, ['tests/**/*.ts']);
assert(testScript.includes('/_test\\.[jt]s$/'));
assert(buildScript.includes('verifyCopiedJavaScript(sourceRoot)'));
assert(builder.includes('- build/electron/**'));
assert(!builder.includes('- electron/**'));

console.log('typescript build contract test ok');
