const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const sharp = require('sharp');
const { bootPlugins } = require('../electron/runtime/agent_plugins');
const { registerPerceptionTools, registerLookTool, evidence } = require('../electron/runtime/desktop_perception');
const { runRuntime } = require('../electron/runtime/index');
const { settingsStore } = require('../electron/runtime/model_admin');
const { ToolRegistry } = require('../electron/runtime/tools');

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mp-perception-plugin-'));
  try {
    const image = join(root, 'frozen.png');
    await sharp({ create: { width: 16, height: 16, channels: 4, background: '#4488cc' } }).png().toFile(image);
    const snapshot = { frame_lease: { frameLeaseId: 'frozen-test', localArtifact: { path: image, width: 16, height: 16 }, surfaceBoundsPx: [0, 0, 16, 16], capturedAtUtc: '2026-09-23T00:00:00Z', targetWindow: {}, gesture: {} } };
    const pluginDir = join(root, 'plugins', 'consumer');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({ main: 'plugin.cjs' }));
    await writeFile(join(pluginDir, 'plugin.cjs'), `module.exports = {
      name: 'perception-consumer', inject: ['perception', 'vision', 'tools'],
      apply(ctx) {
        const perception = ctx.get('perception'), vision = ctx.get('vision');
        ctx.get('tools').register({ name: 'plugin_perception_probe', description: 'Probe injected perception and vision.',
          input_schema: { type: 'object', properties: {}, required: [] }, effect: 'read',
          execute: async () => ({ reading: await perception.read_around('plugin', 2), hasVision: typeof vision === 'function' }) });
      }
    };`);
    const calls: string[] = [];
    const perception = {
      read_around: async (anchor: string, radius: number) => { calls.push(`${anchor}:${radius}`); return evidence('backend selection', 'ok', 'fixture.perception'); },
      dump_subtree: async () => evidence('{}', 'ok', 'fixture.perception'),
      find_in_window: async () => evidence('', 'empty_confirmed', 'fixture.perception'),
      list_windows: async () => evidence('[]', 'ok', 'fixture.perception'),
      get_focused: async () => evidence('null', 'ok', 'fixture.perception'),
    };
    const vision = async (images: { dataUrl?: string; path?: string }[]) => {
      assert.ok(images[0].dataUrl?.startsWith('data:image/png;base64,'));
      assert.equal(images[1].path, image);
      return { text: 'visual answer', usedBackend: 'fixture.vision' };
    };
    const registry = new ToolRegistry();
    const builtins = [
      { name: 'perception-tools', inject: ['tools', 'perception'], apply: (ctx: any) => registerPerceptionTools(ctx.get('tools'), { snapshot, backend: ctx.get('perception') }) },
      { name: 'look-tool', inject: ['tools', 'vision'], apply: (ctx: any) => registerLookTool(ctx.get('tools'), { snapshot, vision: ctx.get('vision') }) },
    ];
    const plugins = await bootPlugins({ directory: join(root, 'plugins'), scope: 'agent', builtins,
      rows: builtins.map(plugin => ({ id: plugin.name, plugin: plugin.name })), core: { tools: registry, perception, vision } });
    try {
      assert.equal(plugins.dumpConfig().find((row: any) => row.id === 'user:perception-consumer')?.status, 'active');
      const read = await registry.execute({ id: 'read', name: 'read_around', arguments: { anchor: 'target', radius: 4 } });
      assert.equal(read.is_error, false);
      assert.equal(read.value.value, 'backend selection');
      assert.deepEqual(calls, ['target:4']);
      const probe = await registry.execute({ id: 'probe', name: 'plugin_perception_probe', arguments: {} });
      assert.equal(probe.value.reading.value, 'backend selection');
      assert.equal(probe.value.hasVision, true);
      const looked = await registry.execute({ id: 'look', name: 'look', arguments: { prompt: 'What is shown?' } });
      assert.equal(looked.is_error, false);
      assert.match(looked.value.value, /frozen frame captured at 2026-09-23T00:00:00Z.*\nvisual answer/);
      assert.equal(looked.value.usedBackend, 'fixture.vision');
      assert.equal(await plugins.unmount('look-tool'), true);
      assert.ok(registry.get('read_around'));
      assert.throws(() => registry.get('look'), /Unknown tool/);
    } finally { await plugins.close(); }

    const userData = join(root, 'user'), providerDir = join(userData, 'data', 'plugins', 'custom-provider');
    await mkdir(providerDir, { recursive: true });
    await writeFile(join(providerDir, 'plugin.json'), JSON.stringify({ main: 'plugin.cjs' }));
    await writeFile(join(providerDir, 'plugin.cjs'), `module.exports = {
      name: 'custom-provider', async apply(ctx) {
        await ctx.provideUp('perception', {
          read_around: async () => ({ value: 'user perception', status: 'ok', confidence: 1, source: 'user' }),
          dump_subtree: async () => ({ value: '{}', status: 'ok', confidence: 1, source: 'user' }),
          find_in_window: async () => ({ value: '', status: 'empty_confirmed', confidence: 0, source: 'user' }),
          list_windows: async () => ({ value: '[]', status: 'ok', confidence: 1, source: 'user' }),
          get_focused: async () => ({ value: 'null', status: 'ok', confidence: 1, source: 'user' })
        });
        await ctx.provideUp('vision', async () => ({ text: 'user vision', usedBackend: 'user' }));
        let turn = 0;
        await ctx.provideUp('llm', async () => ++turn === 1 ? { text: '', tool_calls: [
          { id: 'read', name: 'read_around', arguments: { anchor: 'selected', radius: 3 } },
          { id: 'look', name: 'look', arguments: { prompt: 'Describe this frozen frame' } }
        ] } : { text: 'done', tool_calls: [] });
      }
    };`);
    await writeFile(join(userData, 'data', 'harness.patch.json'), JSON.stringify({ schemaVersion: 1, patch: {
      'perception-provider': { disabled: true }, 'vision-provider': { disabled: true }, 'llm-provider': { disabled: true },
    } }));
    const help = await runRuntime({ question: '/help' }, { root, userDataDir: userData });
    const rows = JSON.parse(String(help.answer)).plugins;
    for (const id of ['custom-provider', 'perception-tools', 'look-tool']) {
      const row = rows.find((entry: any) => entry.id === (id === 'custom-provider' ? 'user:custom-provider' : id));
      assert.equal(row?.status, 'active', `${id}: ${JSON.stringify(row)}`);
    }
    const store = settingsStore(userData), settings = store.load();
    settings.privacy.upload_screenshots = true; store.save(settings);
    const result = await runRuntime({ question: 'Inspect the selected frame', selectionSnapshot: snapshot,
      modelRuntime: { model: 'fixture', baseUrl: 'http://127.0.0.1:1', credential: 'fixture' } },
    { root, userDataDir: userData, signal: AbortSignal.timeout(10000) });
    assert.equal(result.ok, true, JSON.stringify(result));
    const readResult = result.events.find((entry: any) => entry.tool_name === 'read_around');
    const lookResult = result.events.find((entry: any) => entry.tool_name === 'look');
    assert.equal(JSON.parse(String(readResult?.value)).value, 'user perception');
    assert.match(JSON.parse(String(lookResult?.value)).value, /user vision/);
  } finally { await rm(root, { recursive: true, force: true }); }
  console.log('runtime perception plugin test passed');
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
