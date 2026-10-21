import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildEgoScript, parseEgoOutput} from '../electron/ego_browser';
import {egoBrowserModule} from '../electron/runtime/ego_browser_module';
import {bootPlugins} from '../electron/runtime/agent_plugins';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry, validate} from '../electron/runtime/tools';

test('Ego scripts preserve text, reuse the task and read actual state after acting', async () => {
  const calls: unknown[] = [];
  const page = {
    label: 'p1',
    goto: async (url: string) => calls.push(['goto', url]),
    fill: async (selector: string, value: string) =>
      calls.push(['fill', selector, value]),
    click: async (selector: string) => calls.push(['click', selector]),
    url: async () => 'http://localhost/result',
    title: async () => 'Actual result',
    snapshot: async (options: {scope: string}) => {
      assert.equal(options.scope, 'only_within_viewport');
      return 'button @2 Saved';
    },
  };
  const execute = async (request: Record<string, unknown>) => {
    let output = '';
    await runInNewContext(
      `(async () => {${buildEgoScript('mp-session-1', request)}})()`,
      {
        URL,
        taskSpace: async (name: string) => {
          calls.push(['space', name]);
          return {spaceId: 7, page: () => page};
        },
        console: {
          log: (text: string) => {
            output += text;
          },
        },
      },
    );
    return parseEgoOutput(output);
  };
  const text = '中文 "quote"\n${process.exit(1)}';
  const opened = await execute({
    operation: 'open',
    url: 'http://localhost/start',
    page: 'p1',
  });
  assert.equal(opened.url, 'http://localhost/result');
  assert.equal(opened.verification?.matched, false);
  const result = await execute({
    operation: 'act',
    page: 'p1',
    actions: [
      {action: 'fill', selector: '@1', value: text},
      {action: 'click', selector: '@2'},
    ],
  });
  assert.deepEqual(calls, [
    ['space', 'mp-session-1'],
    ['goto', 'http://localhost/start'],
    ['space', 'mp-session-1'],
    ['fill', '@1', text],
    ['click', '@2'],
  ]);
  assert.equal(result.snapshot, 'button @2 Saved');
  assert.equal(result.usedBackend, 'ego-lite');
  assert.equal(result.verification, undefined);
});

test('actual plugin boot registers and unloads the browser for primary and child runtimes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-ego-plugin-'));
  try {
    const tools = new ToolRegistry();
    const session = await EventSession.open(root, 'ego-boot');
    const plugins = await bootPlugins({
      directory: path.join(root, 'plugins'),
      core: {session, tools},
    });
    assert.deepEqual(plugins.warnings, []);
    assert.ok(tools.get('EgoBrowser.open'));
    assert.ok(tools.get('EgoBrowser.newPage'));
    await plugins.context.unload();
    assert.throws(() => tools.get('EgoBrowser.open'), /Unknown tool/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Ego errors and missing replies cannot become successful browser results', () => {
  assert.throws(
    () => parseEgoOutput('some startup text'),
    /ego_browser_no_result/,
  );
  assert.throws(
    () =>
      parseEgoOutput('MP_EGO_RESULT={"ok":false,"error":"user took control"}'),
    /user took control/,
  );
  assert.throws(
    () => buildEgoScript('task', {operation: 'open', url: 'file:///private'}),
    /http/,
  );
  assert.throws(
    () =>
      parseEgoOutput(
        'MP_EGO_RESULT={"ok":false,"error":"action interrupted","mayHaveLateEffects":true}',
      ),
    {name: 'AbortError'},
  );
});

test('explicit collection capture reads the active user page and returns control without a snapshot', async () => {
  let output = '';
  let handedOff = false;
  const activePage = {
    label: 'p2',
    url: async () => 'https://example.com/selected',
    title: async () => 'Selected source',
    evaluate: async () => 'Only this selected text 中文',
    snapshot: async () => {
      throw new Error('Full-page reading is not authorized');
    },
  };
  await runInNewContext(
    `(async () => {${buildEgoScript('Magic Pointer collection', {operation: 'capture-selection'})}})()`,
    {
      listTaskSpaces: async () => [
        {
          id: 7,
          name: 'Magic Pointer collection',
          ownership: 'agentDelegatedToUser',
        },
      ],
      takeOverTaskSpace: async (id: number) => {
        assert.equal(id, 7);
        return {
          spaceId: 7,
          page: () => {
            throw new Error('Do not guess p1');
          },
          userPage: () => activePage,
          handOff: async () => {
            handedOff = true;
          },
        };
      },
      console: {
        log: (value: string) => {
          output += value;
        },
      },
    },
  );
  const result = parseEgoOutput(output);
  assert.equal(result.url, 'https://example.com/selected');
  assert.equal(result.selectedText, 'Only this selected text 中文');
  assert.equal(result.snapshot, undefined);
  assert.equal(handedOff, true);
});

test('browser capability exposes structured actions with MP permissions and one resource per task', () => {
  const module = egoBrowserModule('session-1');
  const commands = module.commands!;
  const names = commands.map(command => command.tool.name);
  assert.ok(names.includes('EgoBrowser.open'));
  assert.ok(names.includes('EgoBrowser.observe'));
  assert.ok(names.includes('EgoBrowser.act'));
  const act = commands.find(
    command => command.tool.name === 'EgoBrowser.act',
  )!.tool;
  assert.equal(act.effect, 'external_send');
  assert.deepEqual(act.resource_keys, ['ego:session-1']);
  assert.equal(act.verify_result, undefined);
  assert.ok(commands.every(command => command.tool.deferred));
  assert.notDeepEqual(
    validate({actions: [{action: 'fill', selector: '@1'}]}, act.input_schema),
    [],
  );
  assert.deepEqual(
    validate(
      {
        actions: [{action: 'fill', selector: '@1', value: '中文'}],
        expected: {selector: '#result', text: 'Saved'},
      },
      act.input_schema,
    ),
    [],
  );
});
