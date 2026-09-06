import { build } from 'esbuild';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { manifestForPlugin, normalizePublishedPluginId } from './figma_manifest';

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'integrations', 'figma');
const outputRoot = path.join(root, 'build', 'figma');
const pluginIdFile = path.join(sourceRoot, 'plugin-id.txt');
const requireManifest = process.argv.includes('--require-manifest');
const port = Number.parseInt(process.env.MAGIC_POINTER_FIGMA_PORT || '37843', 10);
const configuredId = process.env.FIGMA_PLUGIN_ID
  || (existsSync(pluginIdFile) ? readFileSync(pluginIdFile, 'utf8') : '');
const pluginId = normalizePublishedPluginId(configuredId);

async function main(): Promise<void> {
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

await build({
  entryPoints: [path.join(sourceRoot, 'code.ts')],
  outfile: path.join(outputRoot, 'code.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  logLevel: 'info',
});

const uiBuild = await build({
  entryPoints: [path.join(sourceRoot, 'ui.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  write: false,
  logLevel: 'info',
});
const uiJavaScript = uiBuild.outputFiles[0]?.text;
if (!uiJavaScript) throw new Error('Figma UI bundle was empty');
const uiTemplate = readFileSync(path.join(sourceRoot, 'ui.html'), 'utf8');
if (!uiTemplate.includes('<!-- FIGMA_UI_SCRIPT -->')) {
  throw new Error('Figma UI template is missing its script marker');
}
writeFileSync(
  path.join(outputRoot, 'ui.html'),
  uiTemplate.replace('<!-- FIGMA_UI_SCRIPT -->', `<script>${uiJavaScript}</script>`),
  'utf8',
);

if (pluginId) {
  writeFileSync(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify(manifestForPlugin(pluginId, port), null, 2)}\n`,
    'utf8',
  );
} else if (requireManifest) {
  throw new Error(
    'Figma manifest not built: set FIGMA_PLUGIN_ID or integrations/figma/plugin-id.txt '
    + 'to the genuine numeric ID assigned by Figma Create New Plugin.',
  );
}

writeFileSync(
  path.join(outputRoot, 'BUILD_STATUS.json'),
  `${JSON.stringify({
    pluginBundleBuilt: true,
    installableManifestBuilt: Boolean(pluginId),
    pluginIdSource: pluginId
      ? (process.env.FIGMA_PLUGIN_ID ? 'environment' : 'local-plugin-id-file')
      : null,
    bridgePort: port,
  }, null, 2)}\n`,
  'utf8',
);

console.log(
  pluginId
    ? `Figma plugin bundle and manifest built in ${path.relative(root, outputRoot)}`
    : `Figma plugin bundle built without manifest in ${path.relative(root, outputRoot)}; genuine Figma plugin ID is not configured`,
);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
