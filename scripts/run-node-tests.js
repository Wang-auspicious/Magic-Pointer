'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function walkJavaScript(directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkJavaScript(relative);
    return entry.isFile() && entry.name.endsWith('.js') ? [relative] : [];
  });
}

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  return result.status == null ? 1 : result.status;
}

const sourceFiles = [
  ...walkJavaScript('electron'),
  ...walkJavaScript('scripts'),
].sort();
const testFiles = fs.readdirSync(path.join(root, 'tests'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('_test.js'))
  .map((entry) => path.join('tests', entry.name))
  .sort();

const failures = [];
for (const file of sourceFiles) {
  if (run(['--check', file]) !== 0) failures.push(`syntax:${file}`);
}
for (const file of testFiles) {
  if (run([file]) !== 0) failures.push(`test:${file}`);
}

if (failures.length) {
  console.error(`node suite failed (${failures.length}): ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`node suite passed: ${sourceFiles.length} source files, ${testFiles.length} tests`);
}
