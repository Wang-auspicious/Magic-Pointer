import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '..');

function run(args: string[]): number {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  return result.status == null ? 1 : result.status;
}

const requested = process.argv.slice(2);
const testPattern = /_test\.[jt]s$/;

function selectedTestFiles(): string[] {
  if (requested.length === 0) {
    return fs
      .readdirSync(path.join(root, 'tests'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && testPattern.test(entry.name))
      .map((entry) => path.join('tests', entry.name))
      .sort();
  }

  return requested.map((candidate) => {
    const absolute = path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    const parts = relative.split(path.sep);
    if (parts[0] !== 'tests' || parts.length !== 2 || !testPattern.test(parts[1])) {
      throw new Error(`invalid test path: ${candidate}`);
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`test file not found: ${candidate}`);
    }
    return relative;
  });
}

let testFiles: string[];
try {
  testFiles = selectedTestFiles();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (testFiles.length === 0) {
  console.error('no matching test files');
  process.exit(1);
}

const failures: string[] = [];

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
  console.log(`node suite passed: ${testFiles.length} test files`);
}
