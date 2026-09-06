import assert from 'node:assert/strict';

import {
  manifestForPlugin,
  normalizePublishedPluginId,
} from '../scripts/figma_manifest';

assert.equal(normalizePublishedPluginId(''), null);
assert.equal(normalizePublishedPluginId('__FIGMA_PLUGIN_ID__'), null);
assert.equal(normalizePublishedPluginId('1234567890123456789'), '1234567890123456789');
assert.throws(() => normalizePublishedPluginId('made-up-id'), /numeric ID assigned by Figma/);

const manifest = manifestForPlugin('1234567890123456789', 37843);
assert.equal(manifest.id, '1234567890123456789');
assert.deepEqual(manifest.editorType, ['figma']);
assert.equal(manifest.documentAccess, 'dynamic-page');
assert.deepEqual(manifest.networkAccess.allowedDomains, ['http://127.0.0.1:37843']);
assert.match(manifest.networkAccess.reasoning, /Magic Pointer/i);
assert.equal(manifest.main, 'code.js');
assert.equal(manifest.ui, 'ui.html');

const packageJson = require('../package.json');
assert.match(packageJson.scripts.lint, /integrations\/figma/);

console.log('figma build contract test ok');
