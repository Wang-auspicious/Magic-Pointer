'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listProjectDirectory, readProjectText } = require('../electron/project_inspector');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-project-inspector-'));
try {
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'README.md'), '# project\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const ready = true;\n', 'utf8');

  const first = listProjectDirectory(root, '');
  assert.deepStrictEqual(first.map((entry) => [entry.name, entry.kind]), [
    ['src', 'directory'],
    ['README.md', 'file'],
  ]);
  assert.equal(first.some((entry) => entry.name === 'node_modules'), false);

  const nested = listProjectDirectory(root, 'src');
  assert.equal(nested[0].path, 'src/main.ts');
  assert.equal(readProjectText(root, 'src/main.ts').text, 'export const ready = true;\n');
  assert.throws(() => readProjectText(root, '../outside.txt'), /invalid_project_path/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('project inspector test ok');
