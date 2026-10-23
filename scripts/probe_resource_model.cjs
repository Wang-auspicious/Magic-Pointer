'use strict';
const {app, safeStorage} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data/runtime/resource-model-acceptance');
fs.mkdirSync(output, {recursive: true});
const source = [
  path.join(process.env.LOCALAPPDATA, 'Magic Pointer'),
  path.join(root, 'data/runtime'),
].find(
  folder =>
    fs.existsSync(path.join(folder, 'credentials.v1.json')) &&
    fs.existsSync(path.join(folder, 'fabric-settings.json')),
);
app.setPath('userData', source || path.join(output, 'profile'));
const deadline = setTimeout(() => app.exit(1), 150000);
app.whenReady().then(async () => {
  try {
    const built = name => require(path.join(root, 'build/electron', name));
    const {ElectronSettingsStore} = built('settings_store');
    const {CredentialStore} = built('credential_store');
    const {resolveActiveModelRuntimeConfig} = built('model_runtime_config');
    const config = resolveActiveModelRuntimeConfig(
      new ElectronSettingsStore(
        path.join(source, 'fabric-settings.json'),
      ).load(),
      new CredentialStore(
        path.join(source, 'credentials.v1.json'),
        safeStorage,
      ),
    );
    if (!config) throw new Error('No configured model');
    const {runRuntime} = built('runtime/index');
    built('runtime/proxy').installEnvironmentProxy();
    const {ResourceCollectionService} = built('resource_collection_service');
    const {createStashRuntime} = built('stash_runtime');
    const stash = createStashRuntime({
      baseDir: path.join(output, 'stash'),
      clipboard: {
        availableFormats: () => [],
        readText: () => '',
        readImage: () => ({isEmpty: () => true}),
      },
    });
    const service = new ResourceCollectionService({
      stash: () => stash,
      projects: () => [
        {
          id: 'ui',
          name: 'UI motion study',
          root: output,
          description: 'Research interruptible sidebar transitions',
        },
      ],
      attach: () => {},
      analyze: async input =>
        runRuntime(
          {
            ...input,
            modelRuntime: config,
            workMode: 'work',
            permissionPreset: 'read-only',
            workspaceRoot: output,
            effort: 'low',
          },
          {
            root,
            userDataDir: path.join(output, 'runtime'),
            signal: AbortSignal.timeout(120000),
          },
        ),
    });
    const entry = await service.add({
      text: 'UI reference: Preserve velocity when reversing a spring animation. The sidebar may change direction before its transition ends. Keep focus on the selected control. This note contains no video and no screenshots.',
      title: 'Interruptible sidebar motion',
      projectId: 'ui',
    });
    const result = await service.process(entry.id);
    if (!result.collection.summary || !result.collection.coverage)
      throw new Error('Missing processed result');
    if (result.collection.suggestedIntent !== 'reference')
      throw new Error(
        `Expected a reference suggestion for the explicit UI reference fixture; got ${result.collection.suggestedIntent}`,
      );
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify({ok: true, ...result.collection}, null, 2),
    );
    console.log(
      JSON.stringify({
        ok: true,
        usedBackend: result.collection.usedBackend,
        timingMs: result.collection.timingMs,
        summary: result.collection.summary,
        coverage: result.collection.coverage,
      }),
    );
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  } finally {
    clearTimeout(deadline);
  }
});
