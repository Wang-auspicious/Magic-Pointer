'use strict';
const {app, safeStorage} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data/runtime/project-inbox/model');
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
  const started = Date.now();
  try {
    if (!source) {
      throw new Error('No configured model profile');
    }
    const built = name => require(path.join(root, 'build/electron', name));
    const config = built(
      'model_runtime_config',
    ).resolveActiveModelRuntimeConfig(
      new (built('settings_store').ElectronSettingsStore)(
        path.join(source, 'fabric-settings.json'),
      ).load(),
      new (built('credential_store').CredentialStore)(
        path.join(source, 'credentials.v1.json'),
        safeStorage,
      ),
    );
    if (!config) {
      throw new Error('No configured model');
    }
    built('runtime/proxy').installEnvironmentProxy();
    const project = {
      id: 'handoff-native',
      name: 'Project handoff acceptance',
      root: output,
      sharedFiles: [],
    };
    const stash = built('stash_runtime').createStashRuntime({
      baseDir: fs.mkdtempSync(path.join(output, 'stash-')),
      clipboard: {
        availableFormats: () => [],
        readText: () => '',
        readImage: () => ({isEmpty: () => true}),
      },
    });
    const service = new (built(
      'resource_collection_service',
    ).ResourceCollectionService)({
      stash: () => stash,
      projects: () => [project],
      attach: (_id, files) => {
        project.sharedFiles.push(...files);
      },
      analyze: async () => {
        throw new Error('Not used');
      },
    });
    const expected = `Handoff-${Date.now().toString(36)}`;
    const entry = await service.add({
      text: 'Local verification fixture',
      title: 'Delivery acceptance',
      projectId: project.id,
    });
    service.update(
      entry.id,
      {summary: `The delivery marker is ${expected}.`},
      1,
    );
    await service.deliver(entry.id);
    const handoffs = built('resource_handoff').handoffsForTurn(
      service.projectInbox(project.id),
    );
    const result = await built('runtime/index').runRuntime(
      {
        question:
          'Report the delivery marker from the collected project reference. Use the marker exactly as supplied.',
        projectContext: {...project, resourceInbox: handoffs},
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
    );
    const report = {
      ok: !!result.ok && String(result.answer).includes(expected),
      usedBackend: result.usedBackend,
      timingMs: Date.now() - started,
      answer: result.answer,
      error: result.error || '',
      handoffCount: handoffs.length,
      verification:
        'real configured model through MP Runtime; marker absent from user question',
    };
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(report.ok ? 0 : 1);
  } catch (error) {
    const report = {
      ok: false,
      timingMs: Date.now() - started,
      error: error.message,
    };
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify(report, null, 2),
    );
    console.error(JSON.stringify(report));
    app.exit(1);
  } finally {
    clearTimeout(deadline);
  }
});
