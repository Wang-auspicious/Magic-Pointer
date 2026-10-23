import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

type Input = Record<string, unknown>;
interface DashboardApi {
  projects: {worktree(input: Input): Promise<unknown>};
  conversations: {send(input: Input): Promise<unknown>};
}

function fixture() {
  const exposed = new Map<string, DashboardApi>();
  const calls: Array<[string, Input]> = [];
  vm.runInNewContext(
    fs.readFileSync(path.resolve('build/electron/preload.js'), 'utf8'),
    {
      exports: {},
      process,
      console,
      setTimeout,
      clearTimeout,
      require(name: string) {
        assert.equal(name, 'electron');
        return {
          contextBridge: {
            exposeInMainWorld(key: string, api: DashboardApi) {
              exposed.set(key, api);
            },
          },
          ipcRenderer: {
            invoke(channel: string, input: Input) {
              calls.push([channel, input]);
              return Promise.resolve({});
            },
            on() {},
            send() {},
            removeListener() {},
          },
        };
      },
    },
  );
  return {api: exposed.get('magicPointerDashboard')!, calls};
}

test('production preload transports checkout and accepted worktree ownership', async () => {
  const {api, calls} = fixture();
  await api.projects.worktree({
    action: 'checkout',
    projectRoot: 'D:/project',
    conversationId: 'task-a',
    path: 'D:/managed/task-a',
    baseBranch: 'feature/environment',
    previousBranch: '',
  });
  const [channel, input] = calls.at(-1)!;
  assert.equal(channel, 'projects:worktree');
  assert.equal(input.action, 'checkout');
  assert.equal(input.path, 'D:/managed/task-a');
  assert.equal(input.baseBranch, 'feature/environment');
  assert.equal(input.previousBranch, '');
});

test('production preload retains explicit workspace choices and leaves omitted choices unset', async () => {
  const {api, calls} = fixture();
  await api.conversations.send({
    question: 'Read the current workspace',
    branch: 'feature/environment',
    worktree: false,
  });
  assert.equal(calls.at(-1)![1].branch, 'feature/environment');
  assert.equal(calls.at(-1)![1].worktree, false);
  await api.conversations.send({question: 'Use project defaults'});
  assert.equal(Object.hasOwn(calls.at(-1)![1], 'branch'), false);
  assert.equal(Object.hasOwn(calls.at(-1)![1], 'worktree'), false);
  assert.equal(
    Object.hasOwn(calls.at(-1)![1], 'effort'),
    false,
    'omitted effort must reach main as omitted so the saved environment can supply it',
  );
});
