import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '..');

function walkCode(directory: string): string[] {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkCode(relative);
    return entry.isFile() && /\.[jt]s$/.test(entry.name) ? [relative] : [];
  });
}

function run(args: string[]): number {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  return result.status == null ? 1 : result.status;
}

const sourceFiles = [...walkCode('electron'), ...walkCode('scripts')].sort();
const testFiles = fs
  .readdirSync(path.join(root, 'tests'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('_test.js'))
  .map((entry) => path.join('tests', entry.name))
  .sort();

const failures: string[] = [];

// `node --check` only parses syntax. ESLint's no-undef check also catches missing
// imports that would otherwise surface as delayed runtime failures.
function runLint(): number {
  const cli = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(cli)) {
    console.warn('eslint not installed, skipping scope check');
    return 0;
  }
  // Invoke ESLint through Node directly to avoid shell quoting differences on Windows.
  return run([cli, 'electron', 'scripts', 'tests', '--max-warnings=0']);
}

function runTypecheck(): number {
  const cli = path.join(path.dirname(require.resolve('typescript')), 'tsc.js');
  const electronStatus = run([
    cli,
    '--project',
    'tsconfig.electron.json',
    '--noEmit',
    '--pretty',
    'false',
  ]);
  if (electronStatus !== 0) return electronStatus;
  return run([cli, '--project', 'tsconfig.tools.json', '--noEmit', '--pretty', 'false']);
}

if (runLint() !== 0) failures.push('lint');
if (runTypecheck() !== 0) failures.push('typecheck');

for (const file of sourceFiles) {
  if (file.endsWith('.js') && run(['--check', file]) !== 0) {
    failures.push(`syntax:${file}`);
  }
}
const tsxRegister = require.resolve('tsx/cjs');
for (const file of testFiles) {
  if (run(['--require', tsxRegister, file]) !== 0) {
    failures.push(`test:${file}`);
  }
}

if (failures.length) {
  console.error(`node suite failed (${failures.length}): ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`node suite passed: ${sourceFiles.length} source files, ${testFiles.length} tests`);
}
