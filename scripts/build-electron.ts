import { cpSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'electron');
const outputRoot = path.join(root, 'build', 'electron');
const scriptsOutputRoot = path.join(root, 'build', 'scripts');
const typescriptRoot = path.resolve(path.dirname(require.resolve('typescript')), '..');
const compiler = path.join(typescriptRoot, 'bin', 'tsc');

rmSync(outputRoot, { force: true, recursive: true });
rmSync(scriptsOutputRoot, { force: true, recursive: true });

function compileProject(project: string): void {
  const compile = spawnSync(process.execPath, [compiler, '--project', path.join(root, project)], {
    cwd: root,
    stdio: 'inherit',
  });

  if (compile.status !== 0) {
    process.exit(compile.status ?? 1);
  }
}

compileProject('tsconfig.electron.json');
compileProject('tsconfig.scripts-build.json');

cpSync(sourceRoot, outputRoot, {
  recursive: true,
  filter(source) {
    return !/\.tsx?$/i.test(source);
  },
});

function verifyCopiedJavaScript(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      verifyCopiedJavaScript(source);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const relative = path.relative(sourceRoot, source);
    const output = path.join(outputRoot, relative);
    if (!readFileSync(source).equals(readFileSync(output))) {
      throw new Error(`JavaScript source was transformed during build: ${relative}`);
    }
  }
}

verifyCopiedJavaScript(sourceRoot);

console.log(`Electron runtime built at ${path.relative(root, outputRoot)}`);
console.log(`Script runtime built at ${path.relative(root, scriptsOutputRoot)}`);
