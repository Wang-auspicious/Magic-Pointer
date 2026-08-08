'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function walkCode(directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkCode(relative);
    return entry.isFile() && /\.[jt]s$/.test(entry.name) ? [relative] : [];
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

const sourceFiles = [...walkCode('electron'), ...walkCode('scripts')].sort();
const testFiles = fs
  .readdirSync(path.join(root, 'tests'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('_test.js'))
  .map((entry) => path.join('tests', entry.name))
  .sort();

const failures = [];

// `node --check` 只解析语法，不解析作用域。main.js 里 `createStashRuntime`
// 和 `createConversationStore` 被用了却从来没有 require，两个都通过了 --check，
// 然后在运行时抛 ReferenceError——被外层 try/catch 吞掉，表现成「收藏箱一直是空的」
// 和「最近对话里什么都没有」。要挡住这一类，只能靠 no-undef。
function runLint() {
  const cli = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(cli)) {
    console.warn('eslint not installed, skipping scope check');
    return 0;
  }
  // 直接跑 eslint 的入口脚本，不经过 .cmd 包装：省掉一层 shell，
  // Windows 上的参数转义问题也跟着没了。
  return run([cli, 'electron', 'scripts', 'tests', '--max-warnings=0']);
}

function runTypecheck() {
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
  if (file.endsWith('.js') && run(['--check', file]) !== 0) failures.push(`syntax:${file}`);
}
const tsxRegister = require.resolve('tsx/cjs');
for (const file of testFiles) {
  if (run(['--require', tsxRegister, file]) !== 0) failures.push(`test:${file}`);
}

if (failures.length) {
  console.error(`node suite failed (${failures.length}): ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`node suite passed: ${sourceFiles.length} source files, ${testFiles.length} tests`);
}
