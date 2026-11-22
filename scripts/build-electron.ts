import {cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildSync} from 'esbuild';

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'electron');
const outputRoot = path.join(root, 'build', 'electron');
const scriptsOutputRoot = path.join(root, 'build', 'scripts');
const typescriptRoot = path.resolve(
  path.dirname(require.resolve('typescript')),
  '..',
);
const compiler = path.join(typescriptRoot, 'bin', 'tsc');

rmSync(outputRoot, {force: true, recursive: true});
rmSync(scriptsOutputRoot, {force: true, recursive: true});

function compileProject(project: string): void {
  const compile = spawnSync(
    process.execPath,
    [compiler, '--project', path.join(root, project)],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );

  if (compile.status !== 0) {
    process.exit(compile.status ?? 1);
  }
}

// The renderer program compiles to ES modules and also emits any main-process
// module it merely type-references, so the electron program must run last to
// leave the CommonJS emit the main process actually requires.
compileProject('tsconfig.browser-globals.json');
compileProject('tsconfig.renderer.json');
compileProject('tsconfig.scripts-build.json');
compileProject('tsconfig.electron.json');

cpSync(sourceRoot, outputRoot, {
  recursive: true,
  filter(source) {
    return !/\.tsx?$/i.test(source);
  },
});

function verifyCopiedJavaScript(directory: string): void {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const source = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      verifyCopiedJavaScript(source);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue;
    }
    const relative = path.relative(sourceRoot, source);
    const output = path.join(outputRoot, relative);
    if (!readFileSync(source).equals(readFileSync(output))) {
      throw new Error(
        `JavaScript source was transformed during build: ${relative}`,
      );
    }
  }
}

verifyCopiedJavaScript(sourceRoot);

// Sandboxed preloads can require Electron, but cannot resolve local modules.
buildSync({
  entryPoints: [path.join(sourceRoot, 'preload.ts')],
  outfile: path.join(outputRoot, 'preload.js'),
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: ['electron'],
  sourcemap: true,
});

buildSync({
  entryPoints: [path.join(sourceRoot, 'compaction_status.ts')],
  outfile: path.join(outputRoot, 'renderer', 'compaction_status.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'CompactionStatus',
  target: 'es2022',
  sourcemap: true,
});

buildSync({
  entryPoints: [path.join(sourceRoot, 'renderer', 'chat_diff_rows.ts')],
  outfile: path.join(outputRoot, 'renderer', 'chat_diff_rows.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'ChatDiffRows',
  target: 'es2022',
  sourcemap: true,
});

buildSync({
  entryPoints: [path.join(sourceRoot, 'renderer', 'chat_file_icons.ts')],
  outfile: path.join(outputRoot, 'renderer', 'chat_file_icons.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'ChatFileIcons',
  target: 'es2022',
  sourcemap: true,
});

buildSync({
  entryPoints: [path.join(sourceRoot, 'renderer', 'chat_tool_summary.ts')],
  outfile: path.join(outputRoot, 'renderer', 'chat_tool_summary.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'ChatToolSummary',
  target: 'es2022',
  sourcemap: true,
});

buildSync({
  entryPoints: [path.join(sourceRoot, 'renderer', 'workflow_card.ts')],
  outfile: path.join(outputRoot, 'renderer', 'workflow_card.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'WorkflowCard',
  target: 'es2022',
  sourcemap: true,
});

buildSync({
  entryPoints: [path.join(sourceRoot, 'renderer', 'studio_workflow_panel.ts')],
  outfile: path.join(outputRoot, 'renderer', 'studio_workflow_panel.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'StudioWorkflowPanel',
  target: 'es2022',
  sourcemap: true,
});

(function bundleKatexAssets(): void {
  const katexEntry = require.resolve('katex');
  const katexDist = path.dirname(katexEntry);
  const vendorOut = path.join(outputRoot, 'renderer', 'vendor', 'katex');
  const fontsOut = path.join(vendorOut, 'fonts');
  mkdirSync(fontsOut, {recursive: true});
  buildSync({
    entryPoints: [katexEntry],
    outfile: path.join(vendorOut, 'katex.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'katex',
    target: 'es2022',
    minify: true,
  });
  const rawCss = readFileSync(path.join(katexDist, 'katex.min.css'), 'utf8');
  // Strip legacy .woff/.ttf fallback descriptors so packaged builds ship only .woff2.
  const woff2OnlyCss = rawCss.replace(
    /,url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g,
    '',
  );
  writeFileSync(path.join(vendorOut, 'katex.css'), woff2OnlyCss, 'utf8');
  const fontsSrc = path.join(katexDist, 'fonts');
  for (const entry of readdirSync(fontsSrc)) {
    if (entry.endsWith('.woff2')) {
      cpSync(path.join(fontsSrc, entry), path.join(fontsOut, entry));
    }
  }
})();

// Opaque null-origin <iframe sandbox="allow-scripts"> documents cannot load
// sibling file:// <script src> / <link href> resources in Chromium. Inline the
// built styles, local KaTeX fonts/JS, and Learn Kit runtime into the built
// iui_sandbox.html while keeping standalone source files intact.
(function inlineIuiSandboxAssets(): void {
  const rendererOut = path.join(outputRoot, 'renderer');
  const sandboxPath = path.join(rendererOut, 'iui_sandbox.html');
  let html = readFileSync(sandboxPath, 'utf8');

  const escapeStyle = (css: string): string =>
    css.replace(/<\/style/gi, '<\\/style');
  const escapeScript = (js: string): string =>
    js.replace(/<\/script/gi, '<\\/script');

  const inlineStyleTag = (relHref: string, transformCss?: (css: string) => string): void => {
    const cssPath = path.join(rendererOut, relHref);
    const rawCss = readFileSync(cssPath, 'utf8');
    const finalCss = transformCss ? transformCss(rawCss) : rawCss;
    const tagRe = new RegExp(
      `<link\\s+rel="stylesheet"\\s+href="${relHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\\/?>`,
    );
    if (!tagRe.test(html)) {
      throw new Error(`Expected stylesheet link ${relHref} in built iui_sandbox.html`);
    }
    html = html.replace(
      tagRe,
      () => `<style data-inlined-src="${relHref}">\n${escapeStyle(finalCss)}\n</style>`,
    );
  };

  const inlineScriptTag = (relSrc: string): void => {
    const jsPath = path.join(rendererOut, relSrc);
    const js = readFileSync(jsPath, 'utf8');
    const tagRe = new RegExp(
      `<script\\s+src="${relSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*><\\/script>`,
    );
    if (!tagRe.test(html)) {
      throw new Error(`Expected script tag ${relSrc} in built iui_sandbox.html`);
    }
    html = html.replace(
      tagRe,
      () => `<script data-inlined-src="${relSrc}">\n${escapeScript(js)}\n</script>`,
    );
  };

  inlineStyleTag('theme_tokens.css');
  inlineStyleTag('vendor/katex/katex.css', katexCss => {
    const katexFontsDir = path.join(rendererOut, 'vendor', 'katex', 'fonts');
    return katexCss.replace(
      /url\(fonts\/([^)]+\.woff2)\)/g,
      (_match, fontFile: string) => {
        const fontData = readFileSync(path.join(katexFontsDir, fontFile)).toString('base64');
        return `url(data:font/woff2;base64,${fontData})`;
      },
    );
  });
  inlineStyleTag('learn_kit_styles.css');
  inlineScriptTag('vendor/katex/katex.js');
  inlineScriptTag('learn_kit_runtime.js');

  writeFileSync(sandboxPath, html, 'utf8');
})();

function verifyBrowserGlobalScripts(): void {
  const htmlRoot = path.join(sourceRoot, 'renderer');
  const referenced = new Set<string>();
  const stylesheets = new Set<string>();
  for (const entry of readdirSync(htmlRoot, {withFileTypes: true})) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) {
      continue;
    }
    const html = readFileSync(path.join(htmlRoot, entry.name), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      const source = match[1].split('?')[0];
      referenced.add(path.normalize(path.join('renderer', source)));
    }
    for (const match of html.matchAll(
      /<link\b[^>]*rel="stylesheet"[^>]*\bhref="([^"]+)"/g,
    )) {
      const href = match[1].split('?')[0];
      stylesheets.add(path.normalize(path.join('renderer', href)));
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
    if (
      /^\s*Object\.defineProperty\(exports\b/m.test(contents) ||
      /^\s*exports\.\w/m.test(contents)
    ) {
      offenders.push(`${relative} (CommonJS wrapper in a classic script)`);
    }
  }
  for (const relative of stylesheets) {
    const output = path.join(outputRoot, relative);
    try {
      readFileSync(output, 'utf8');
    } catch {
      offenders.push(`${relative} (stylesheet missing from build output)`);
    }
  }
  const requiredFonts = [
    'AnthropicSansMicro-Text.woff2',
    'AnthropicSansMicro-Display.woff2',
    'AnthropicMono-Regular.woff2',
    'AnthropicMono-Italic.woff2',
  ];
  for (const fontName of requiredFonts) {
    const fontPath = path.join(outputRoot, 'renderer', 'assets', 'fonts', fontName);
    try {
      readFileSync(fontPath);
    } catch {
      offenders.push(
        `${path.join('renderer', 'assets', 'fonts', fontName)} (font missing from build output)`,
      );
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Browser-loaded scripts must compile to classic scripts:\n  ${offenders.join('\n  ')}`,
    );
  }
}

verifyBrowserGlobalScripts();

// Main-process modules are loaded with require(); an ES module emit here means a
// second program overwrote them and the app cannot start.
function verifyMainProcessModules(): void {
  const offenders: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'renderer') {
          walk(source);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.js')) {
        continue;
      }
      if (/^\s*(?:import|export)\s/m.test(readFileSync(source, 'utf8'))) {
        offenders.push(path.relative(outputRoot, source));
      }
    }
  };
  walk(outputRoot);
  if (offenders.length > 0) {
    throw new Error(
      `Main-process modules must compile to CommonJS:\n  ${offenders.join('\n  ')}`,
    );
  }
}

verifyMainProcessModules();

console.log(`Electron runtime built at ${path.relative(root, outputRoot)}`);
console.log(
  `Script runtime built at ${path.relative(root, scriptsOutputRoot)}`,
);
