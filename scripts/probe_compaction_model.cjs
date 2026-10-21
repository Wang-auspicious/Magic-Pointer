'use strict';
const {app, safeStorage} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data/runtime/compaction');
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
const deadline = setTimeout(() => app.exit(1), 240000);
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
    const folder = fs.mkdtempSync(path.join(output, 'model-'));
    const {EventSession} = built('runtime/session');
    const session = await EventSession.open(
      folder,
      `agent-studio-new-compact-${Date.now().toString(36)}`,
    );
    const marker = `Verified-${Date.now().toString(36)}`;
    const note =
      'A read-only project pass inspected the navigation state and saved evidence. It changed no external files. The next step is to verify the handoff identifier and report it.\n';
    for (let i = 0; i < 4; i++) {
      await session.appendMessage({
        role: i % 2 ? 'assistant' : 'user',
        content: `Historical pass ${i}. ${i === 0 ? `Critical handoff identifier: ${marker}. Preserve this exact identifier in the next context.\n` : ''}${note.repeat(90)}`,
      });
    }
    const originalBytes = JSON.stringify(session.deriveMessages()).length;
    const phases = [];
    const {runRuntime} = built('runtime/index');
    const previous = process.env.MAGIC_POINTER_CONTEXT_TOKENS;
    process.env.MAGIC_POINTER_CONTEXT_TOKENS = '8192';
    let compressed;
    try {
      compressed = await runRuntime(
        {
          question: '/compact',
          agentSessionId: session.id,
          modelRuntime: config,
          permissionPreset: 'read-only',
        },
        {
          root,
          userDataDir: folder,
          signal: AbortSignal.timeout(150000),
          onProgress: phase => phases.push(phase),
        },
      );
    } finally {
      if (previous === undefined) {
        delete process.env.MAGIC_POINTER_CONTEXT_TOKENS;
      } else {
        process.env.MAGIC_POINTER_CONTEXT_TOKENS = previous;
      }
    }
    assert.equal(compressed.ok, true, compressed.error || compressed.answer);
    const reopened = await EventSession.open(folder, session.id, false);
    const summary = JSON.stringify(reopened.deriveMessages());
    assert.ok(
      summary.includes(marker),
      'critical identifier survives the actual summarizer',
    );
    assert.ok(summary.length < originalBytes);
    const requests = reopened.events.filter(
      event => event.type === 'compaction/response',
    );
    assert.ok(requests.length > 1, 'active-window split is exercised');
    const persistedInput = requests.reduce(
      (sum, event) => sum + (event.data.requestUsage.inputTokens || 0),
      0,
    );
    assert.equal(compressed.modelUsage.inputTokens, persistedInput);
    const answer = await runRuntime(
      {
        question:
          'What exact critical handoff identifier was recorded in the prior project work? Report only the identifier.',
        agentSessionId: session.id,
        modelRuntime: config,
        permissionPreset: 'read-only',
        effort: 'low',
      },
      {root, userDataDir: folder, signal: AbortSignal.timeout(90000)},
    );
    assert.equal(answer.ok, true, answer.error);
    assert.ok(String(answer.answer).includes(marker));
    const report = {
      ok: true,
      usedBackend: compressed.usedBackend,
      answerBackend: answer.usedBackend,
      timingMs: Date.now() - started,
      compactionTimingMs: compressed.timingMs,
      compactionModelUsage: compressed.modelUsage,
      answerModelUsage: answer.modelUsage,
      compactionRequests: requests.length,
      originalBytes,
      summaryBytes: summary.length,
      persistedInput,
      answer: answer.answer,
      progressVisible: phases.includes('context_compacting'),
      error: '',
      verification:
        'real configured model through MP Runtime /compact and continuation, isolated durable session; no external application writes',
    };
    fs.writeFileSync(
      path.join(output, 'model-result.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    app.exit(0);
  } catch (error) {
    const report = {
      ok: false,
      timingMs: Date.now() - started,
      error: error.message,
    };
    fs.writeFileSync(
      path.join(output, 'model-result.json'),
      JSON.stringify(report, null, 2),
    );
    console.error(JSON.stringify(report));
    app.exit(1);
  } finally {
    clearTimeout(deadline);
  }
});
