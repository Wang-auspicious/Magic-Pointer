import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extensionsInventory,
  setPluginEnabled,
} from '../electron/runtime/agent_services';
import {
  bootPlugins,
  loadHarnessConfiguration,
} from '../electron/runtime/agent_plugins';
import {handleFabric} from '../electron/runtime/fabric_api';
import {runRuntime} from '../electron/runtime/index';

test('directory enablement persists without executing code and controls the real plugin boot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-plugin-toggle-'));
  try {
    const directory = path.join(root, 'data', 'plugins');
    const plugin = path.join(directory, 'installed-folder');
    const configPath = path.join(root, 'data', 'harness.patch.json');
    const marker = path.join(root, 'imported.txt');
    await mkdir(plugin, {recursive: true});
    await writeFile(
      path.join(plugin, 'plugin.json'),
      JSON.stringify({main: 'plugin.cjs'}),
    );
    await writeFile(
      path.join(plugin, 'plugin.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'imported');module.exports={name:'exported-name',apply(ctx){return ctx.provideUp('fixture',true)}};`,
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        note: 'preserve',
        patch: {
          'web-tools': {disabled: true},
          'user:exported-name': {config: {greeting: 'preserve'}},
        },
      }),
    );
    const before = await extensionsInventory(root);
    assert.equal(before.plugins.items[0].canToggle, true);
    await assert.rejects(access(marker));
    const disabled = await handleFabric(
      {
        operation: 'extensions.set-enabled',
        id: 'installed-folder',
        enabled: false,
      },
      {root, userDataDir: root},
    );
    assert.equal(disabled.ok, true, disabled.error);
    assert.equal(disabled.appliesTo, 'next_task');
    assert.equal(disabled.plugins.items[0].status, 'disabled');
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.note, 'preserve');
    assert.deepEqual(saved.patch['user:exported-name'], {
      config: {greeting: 'preserve'},
    });
    const first = await bootPlugins({
      directory,
      ...(await loadHarnessConfiguration(configPath)),
    });
    assert.equal(first.context.has('fixture'), false);
    assert.equal(first.dumpConfig()[0].status, 'disabled');
    await first.close();
    const disabledRuntime = await runRuntime(
      {question: '/help'},
      {root, userDataDir: root},
    );
    assert.equal(
      JSON.parse(String(disabledRuntime.answer)).plugins.find(
        (row: {id: string}) => row.id === 'directory:installed-folder',
      ).status,
      'disabled',
    );
    await assert.rejects(access(marker));
    const enabled = await setPluginEnabled(root, 'installed-folder', true);
    assert.equal(enabled.plugins.items[0].status, 'configured');
    const second = await bootPlugins({
      directory,
      ...(await loadHarnessConfiguration(configPath)),
    });
    assert.equal(second.context.get('fixture'), true);
    await second.close();
    const enabledRuntime = await runRuntime(
      {question: '/help'},
      {root, userDataDir: root},
    );
    assert.equal(
      JSON.parse(String(enabledRuntime.answer)).plugins.find(
        (row: {id: string}) => row.id === 'user:exported-name',
      ).status,
      'active',
    );
    await assert.rejects(
      setPluginEnabled(root, '../missing', false),
      /Unknown plugin/,
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('named row disablement is visible and enabling clears both explicit disable sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-plugin-row-'));
  try {
    const plugin = path.join(root, 'data', 'plugins', 'folder');
    const configPath = path.join(root, 'data', 'harness.patch.json');
    await mkdir(plugin, {recursive: true});
    await writeFile(
      path.join(plugin, 'plugin.json'),
      JSON.stringify({name: 'named', main: 'plugin.cjs'}),
    );
    await writeFile(
      path.join(plugin, 'plugin.cjs'),
      "module.exports={name:'named',apply(){}};",
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        disabledPluginDirectories: ['folder'],
        patch: {'user:named': {disabled: true, config: {keep: 1}}},
      }),
    );
    const before = await extensionsInventory(root);
    assert.equal(before.plugins.items[0].status, 'disabled');
    await setPluginEnabled(root, 'folder', true);
    const after = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(after.patch['user:named'].disabled, false);
    assert.deepEqual(after.patch['user:named'].config, {keep: 1});
    assert.deepEqual(after.disabledPluginDirectories, []);
    await writeFile(configPath, '{invalid');
    const invalid = await extensionsInventory(root);
    assert.ok(invalid.plugins.error);
    assert.equal(invalid.plugins.items[0].status, 'invalid');
    await assert.rejects(setPluginEnabled(root, 'folder', true));
    assert.equal(await readFile(configPath, 'utf8'), '{invalid');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
