import assert from 'node:assert/strict';
import test from 'node:test';
import {HookManager, type AgentOptions} from '../electron/runtime/agent';
import {PluginContext, PromptSections} from '../electron/runtime/agent_plugins';
import {SurfaceAdapterRegistry} from '../electron/runtime/desktop_adapters';
import {ToolRegistry} from '../electron/runtime/tools';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

for (const kind of [
  'hook',
  'prompt',
  'surface',
  'event',
  'session-end',
] as const) {
  test(`unloading a plugin waits for its running ${kind} callback`, async () => {
    const context = new PluginContext();
    const scope = context.scope();
    const entered = deferred();
    const release = deferred();
    let disposed = false;
    const callback = async () => {
      entered.resolve();
      await release.promise;
      assert.equal(
        disposed,
        false,
        'plugin resources must survive the active callback',
      );
    };
    let invoke: () => Promise<unknown>;
    if (kind === 'hook') {
      const hooks = new HookManager();
      await context.provide('hooks', hooks);
      scope.get<HookManager>('hooks').add('pre', callback);
      invoke = () => hooks.run('pre', {});
    } else if (kind === 'prompt') {
      const prompt = new PromptSections();
      await context.provide('prompt', prompt);
      scope.get<PromptSections>('prompt').add({
        id: 'owned',
        render: async () => {
          await callback();
          return 'owned';
        },
      });
      invoke = () => prompt.build({} as AgentOptions);
    } else if (kind === 'surface') {
      const adapters = new SurfaceAdapterRegistry();
      await context.provide('surface_adapters', adapters);
      scope.get<SurfaceAdapterRegistry>('surface_adapters').register({
        id: 'owned',
        matches: () => true,
        resolve: async () => {
          await callback();
          return {content: 'owned'};
        },
      });
      invoke = () => adapters.resolve({});
    } else if (kind === 'session-end') {
      const tools = new ToolRegistry();
      await context.provide('tools', tools);
      scope.get<ToolRegistry>('tools').onSessionEnd(callback);
      invoke = () => tools.close();
    } else {
      context.declare('changed', 'parallel');
      scope.on('changed', callback);
      invoke = () => context.dispatch('changed', {});
    }
    scope.effect(() => {
      disposed = true;
    });
    const running = invoke();
    await entered.promise;
    let unloaded = false;
    const unloading = scope.unload().then(() => {
      unloaded = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    const prematurelyDisposed = disposed;
    const prematurelyUnloaded = unloaded;
    release.resolve();
    await Promise.allSettled([running, unloading]);
    assert.equal(
      prematurelyDisposed,
      false,
      `${kind} disposer ran before callback settled`,
    );
    assert.equal(
      prematurelyUnloaded,
      false,
      `${kind} unload returned while callback was active`,
    );
    assert.equal(disposed, true);
    await context.unload();
  });
}

test('event callback cannot unload its own scope and deadlock dispatch', async () => {
  const context = new PluginContext();
  const scope = context.scope();
  context.declare('changed', 'serial');
  scope.on('changed', () => scope.unload());
  await assert.rejects(context.dispatch('changed', {}), /own active work/);
  await context.unload();
});

test('closing the host joins an already unloading child before disposing shared resources', async () => {
  const context = new PluginContext();
  const child = context.scope();
  const entered = deferred();
  const release = deferred();
  let disposed = false;
  context.effect(() => {
    disposed = true;
  });
  const running = child.run(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const childClosing = child.unload();
  const hostClosing = context.unload();
  await new Promise(resolve => setImmediate(resolve));
  const premature = disposed;
  release.resolve();
  await Promise.all([running, childClosing, hostClosing]);
  assert.equal(
    premature,
    false,
    'host cleanup must wait for the child cleanup already in progress',
  );
  assert.equal(disposed, true);
});
