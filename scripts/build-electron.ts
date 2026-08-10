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
compileProject('tsconfig.browser-globals.json');
compileProject('tsconfig.renderer.json');
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

// A <script src> tag loads a classic script: no module wrapper exists, so a
// CommonJS preamble throws `exports is not defined` on line 1 and every global
// the page depends on silently never appears. Assert the shape at build time —
// the failure is invisible at runtime until a surface stops waking up.
function verifyBrowserGlobalScripts(): void {
  const htmlRoot = path.join(sourceRoot, 'renderer');
  const referenced = new Set<string>();
  for (const entry of readdirSync(htmlRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const html = readFileSync(path.join(htmlRoot, entry.name), 'utf8');
    for (const match of html.matchAll(/<script\s+src="([^"]+)"/g)) {
      const source = match[1].split('?')[0];
      referenced.add(path.normalize(path.join('renderer', source)));
    }
  }
  const offenders: string[] = [];
  for (const relative of referenced) {
    const output = path.join(outputRoot, relative);
    let contents = '';
    try {
      contents = readFileSync(output, 'utf8');
    } catch {
      offenders.push(`${relative} (missing from build output)`);
      continue;
    }
    // The fatal shape is tsc's CommonJS preamble, which touches `exports`
    // unconditionally. A guarded `typeof module !== 'undefined' && module.exports`
    // is the deliberate dual-export these files use to serve Node tests too.
    if (/^\s*Object\.defineProperty\(exports\b/m.test(contents) || /^\s*exports\.\w/m.test(contents)) {
      offenders.push(`${relative} (CommonJS wrapper in a classic script)`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`Browser-loaded scripts must compile to classic scripts:\n  ${offenders.join('\n  ')}`);
  }
}

verifyBrowserGlobalScripts();

console.log(`Electron runtime built at ${path.relative(root, outputRoot)}`);
console.log(`Script runtime built at ${path.relative(root, scriptsOutputRoot)}`);
