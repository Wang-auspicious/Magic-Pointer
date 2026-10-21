import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {bootPlugins} from '../electron/runtime/agent_plugins';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';
import {handleFabric} from '../electron/runtime/fabric_api';
import {updateContext} from '../electron/runtime/context';
import {runRuntime} from '../electron/runtime/index';
import {HookManager} from '../electron/runtime/hooks';

test('installed module contributes a panel, a read command and request evidence through the same scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-runtime-module-'));
  try {
    const session = await EventSession.open(root, 'agent-studio-new-module');
    const folder = path.join(root, 'data', 'plugins', 'source-note');
    const file = path.join(root, 'note.txt');
    await mkdir(folder, {recursive: true});
    await writeFile(file, 'Actual local source note');
    await writeFile(
      path.join(folder, 'plugin.json'),
      JSON.stringify({name: 'source-note', main: 'plugin.cjs'}),
    );
    await writeFile(
      path.join(folder, 'plugin.cjs'),
      `module.exports={name:'source-note',inject:['modules'],apply(ctx){ctx.get('modules').register({id:'source-note',title:'Source note',commands:[{id:'read',label:'Read note',tool:{description:'Read the authorized note',input_schema:{type:'object',properties:{},required:[]},effect:'read',access_for:()=>({action:'read',paths:[${JSON.stringify(file)}]}),execute:async()=>({text:await require('node:fs/promises').readFile(${JSON.stringify(file)},'utf8')})}}],panels:[{id:'note',render:()=>({id:'note',title:'Note',status:{state:'ready'},sections:[{id:'actions',rows:[],actions:[{id:'read',label:'Read note'}]}]}),actions:{read:{commandId:'read'}}}],requestContext:()=> 'Active note module.'});}};`,
    );
    const registry = new ToolRegistry();
    const plugins = await bootPlugins({
      directory: path.dirname(folder),
      core: {session, tools: registry},
    });
    const modules = plugins.modules;
    assert.ok(
      modules,
      'production plugin boot must install the modules service',
    );
    const snapshot = await modules.snapshot();
    assert.ok(snapshot.modules.some(module => module.id === 'task-context'));
    assert.equal(
      snapshot.modules.find(module => module.id === 'source-note')?.panels[0]
        .moduleId,
      'source-note',
    );
    assert.ok(registry.get('Modules.source_note.read'));
    assert.deepEqual(
      await modules.requestContext({
        sessionId: session.id,
        turn: 1,
        signal: new AbortController().signal,
      }),
      [{moduleId: 'source-note', text: 'Active note module.'}],
    );
    const denied = await modules.invoke({
      sessionId: session.id,
      moduleId: 'source-note',
      panelId: 'note',
      actionId: 'read',
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.agentRequest?.toolName, 'Modules.source_note.read');
    await updateContext(session, {
      scopeGrants: [
        {
          grantId: 'note',
          taskId: session.id,
          sourceIds: [],
          folderRoots: [root],
          windowIds: [],
          recipients: [],
          actions: ['read'],
          expiresAtMs: null,
        },
      ],
    });
    const allowed = await modules.invoke({
      sessionId: session.id,
      moduleId: 'source-note',
      panelId: 'note',
      actionId: 'read',
    });
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(allowed.result?.text, await readFile(file, 'utf8'));
    await plugins.unmount('user:source-note');
    assert.throws(
      () => registry.get('Modules.source_note.read'),
      /Unknown tool/,
    );
    assert.ok(
      !(await modules.snapshot()).modules.some(
        module => module.id === 'source-note',
      ),
    );
    await plugins.close();
    const ipc = await handleFabric(
      {operation: 'modules.list', sessionId: session.id},
      {root, userDataDir: root},
    );
    assert.equal(ipc.ok, true, ipc.error);
    assert.ok(
      ipc.modules.some((module: {id: string}) => module.id === 'source-note'),
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('production Runtime executes a registered module tool and logs fresh context on every request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-module-production-'));
  try {
    const folder = path.join(root, 'data', 'plugins', 'release-note');
    const document = path.join(root, 'release-notes.md');
    await mkdir(folder, {recursive: true});
    await writeFile(
      document,
      'Release candidate: MP-local-742\nValidation: read back from disk.\n',
    );
    await writeFile(
      path.join(folder, 'plugin.json'),
      JSON.stringify({name: 'release-note', main: 'plugin.cjs'}),
    );
    await writeFile(
      path.join(root, 'data', 'harness.patch.json'),
      JSON.stringify({
        schemaVersion: 1,
        patch: {'llm-provider': {disabled: true}},
      }),
    );
    await writeFile(
      path.join(folder, 'plugin.cjs'),
      `module.exports={name:'release-note',inject:['modules'],async apply(ctx){
      ctx.get('modules').register({id:'release-note',title:'Release note',requestContext:request=>'Release note module, request '+request.turn,
        commands:[{id:'read',label:'Read release note',tool:{description:'Read the release note in the selected workspace',input_schema:{type:'object',properties:{},required:[]},effect:'read',access_for:()=>({action:'read',paths:[${JSON.stringify(document)}]}),execute:()=>require('node:fs/promises').readFile(${JSON.stringify(document)},'utf8')}}]});
      let requestIndex=0;
      await ctx.provideUp('llm',async request=>{
        requestIndex++;
        const contexts=request.messages.filter(message=>message.content?.startsWith('[Module context: release-note]'));
        if(contexts.length!==1 || !contexts[0].content.endsWith('request '+requestIndex)) throw Error('module context not current: '+JSON.stringify({requestIndex,contexts}));
        if(requestIndex===1)return {text:'',tool_calls:[{id:'discover',name:'Tools',arguments:{names:['Modules.release_note.read']}}]};
        if(requestIndex===2)return {text:'',tool_calls:[{id:'read-release',name:'Modules.release_note.read',arguments:{}}]};
        const read=request.messages.find(message=>message.tool_call_id==='read-release');
        return {text:read.content,tool_calls:[],usedBackend:'fixture.module-model'};
      });
    }};`,
    );
    const result = await runRuntime(
      {
        question: 'Read the current release note',
        workspaceRoot: root,
        agentSessionId: 'agent-studio-new-module-production',
        modelRuntime: {
          model: 'fixture',
          baseUrl: 'http://127.0.0.1:1',
          credential: 'fixture',
        },
      },
      {root, userDataDir: root},
    );
    assert.equal(result.ok, true, result.error);
    assert.equal(result.answer, await readFile(document, 'utf8'));
    const session = await EventSession.open(
      root,
      String(result.agentSessionId),
      false,
    );
    assert.equal(
      session.events.filter(event => event.type === 'module/request_context')
        .length,
      3,
    );
    const contexts = session.events.filter(
      event => event.type === 'module/request_context',
    );
    assert.deepEqual(
      contexts.map(event => event.data.contexts),
      [1, 2, 3].map(turn => [
        {
          moduleId: 'release-note',
          text: `Release note module, request ${turn}`,
        },
      ]),
    );
    const prepared = session.events.find(
      event =>
        event.type === 'operation/prepared' &&
        event.data.callId === 'read-release',
    );
    const settled = session.events.find(
      event =>
        event.type === 'operation/settled' &&
        event.data.operationId === prepared?.data.operationId,
    );
    assert.ok(
      settled,
      'module command must use the ordinary durable operation ledger',
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('disposing one module retracts its commands without unloading sibling modules', async () => {
  const registry = new ToolRegistry();
  const plugins = await bootPlugins({directory: '', core: {tools: registry}});
  const remove = plugins.modules.register({
    id: 'temporary',
    title: 'Temporary',
    commands: [
      {
        id: 'inspect',
        label: 'Inspect',
        tool: {
          description: 'Read module state',
          input_schema: {type: 'object', properties: {}, required: []},
          execute: () => 'temporary',
        },
      },
    ],
  });
  plugins.modules.register({id: 'sibling', title: 'Sibling'});
  await remove();
  assert.throws(
    () => registry.get('Modules.temporary.inspect'),
    /Unknown tool/,
  );
  assert.deepEqual(
    (await plugins.modules.snapshot()).modules.map(module => module.id),
    ['sibling'],
  );
  await plugins.close();
});

test('the builtin task-context registration belongs to its plugin scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-module-owner-'));
  try {
    const session = await EventSession.open(root, 'module-owner');
    const registry = new ToolRegistry();
    const plugins = await bootPlugins({
      directory: '',
      core: {session, tools: registry},
    });
    plugins.modules.register({id: 'other', title: 'Other module'});
    assert.ok(registry.get('Modules.task_context.inspect'));
    await plugins.unmount('task-context-module');
    assert.throws(
      () => registry.get('Modules.task_context.inspect'),
      /Unknown tool/,
    );
    assert.deepEqual(
      (await plugins.modules.snapshot()).modules.map(module => module.id),
      ['ego-browser', 'other'],
    );
    await plugins.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a module preserves existing tool names and formats their result for the interface', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-module-named-'));
  try {
    const session = await EventSession.open(root, 'module-named');
    const registry = new ToolRegistry();
    const hooks = new HookManager();
    let observed: unknown;
    let observedInput: unknown;
    hooks.add('pre', payload => { observedInput = payload.input; });
    hooks.add('post', payload => { observed = payload.result; });
    const plugins = await bootPlugins({
      directory: '',
      core: {session, tools: registry, hooks},
    });
    const definition = {
      id: 'existing',
      title: 'Existing feature',
      commands: [
        {
          id: 'inspect',
          label: 'Inspect',
          tool: {
            name: 'Existing.inspect',
            description: 'Inspect existing data',
            input_schema: {type: 'object', properties: {count: {type: 'number', minimum: 1, maximum: 10}, sourceLabel: {type: 'string'}}, required: ['count', 'sourceLabel']},
            execute: (args: Record<string, unknown>) => ({count: args.count}),
          },
          present: (value: unknown) => ({
            text: `Items: ${(value as {count: number}).count}`,
          }),
        },
      ],
      panels: [
        {
          id: 'existing',
          render: () => ({
            id: 'existing',
            title: 'Existing feature',
            status: {state: 'ready' as const},
            sections: [
              {
                id: 'actions',
                rows: [],
                actions: [{id: 'inspect', label: 'Inspect', fields: [{name: 'count', label: 'Count', type: 'number' as const, value: 7}]}],
              },
            ],
          }),
          actions: {inspect: {commandId: 'inspect', arguments: {count: 3, sourceLabel: 'saved'}}},
        },
      ],
    };
    plugins.modules.register(definition);
    assert.ok(registry.get('Existing.inspect'));
    assert.throws(
      () => registry.get('Modules.existing.inspect'),
      /Unknown tool/,
    );
    const result = await plugins.modules.invoke({
      sessionId: session.id,
      moduleId: 'existing',
      panelId: 'existing',
      actionId: 'inspect',
      inputs: {count: 9},
    });
    assert.equal(result.result?.text, 'Items: 9');
    assert.deepEqual(observedInput, {count: 9, sourceLabel: 'saved'});
    assert.deepEqual(observed, {count: 9}, 'module and Agent hooks receive the same tool value');
    const request = {sessionId: session.id, moduleId: 'existing', panelId: 'existing', actionId: 'inspect'};
    assert.equal((await plugins.modules.invoke(request)).result?.text, 'Items: 7');
    for (const inputs of [{sourceLabel: 'changed'}, {count: 'nine'}, null, []]) {
      const rejected = await plugins.modules.invoke({...request, inputs: inputs as never});
      assert.equal(rejected.ok, false, JSON.stringify(inputs));
      assert.equal(rejected.agentRequest, undefined);
    }
    hooks.add('post', () => ({decision: 'block', reason: 'Result not available'}));
    const blocked = await plugins.modules.invoke({
      sessionId: session.id, moduleId: 'existing', panelId: 'existing', actionId: 'inspect',
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.agentRequest, undefined);
    const finished = session.events.filter(event => event.type === 'module/command_finished').at(-1)!;
    assert.equal((finished.data.result as {is_error: boolean}).is_error, true,
      'blocked results must not become successful panel history');
    await plugins.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a fresh module host resolves actions from the current panel render', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-module-dynamic-'));
  try {
    const session = await EventSession.open(root, 'module-dynamic');
    const plugins = await bootPlugins({
      directory: '',
      core: {session, tools: new ToolRegistry()},
    });
    const panel = {
      id: 'dynamic',
      actions: {} as Record<string, {commandId: string}>,
      render: () => {
        panel.actions = {latest: {commandId: 'inspect'}};
        return {
          id: 'dynamic',
          title: 'Dynamic',
          status: {state: 'ready' as const},
          sections: [
            {
              id: 'actions',
              rows: [],
              actions: [{id: 'latest', label: 'Latest data'}],
            },
          ],
        };
      },
    };
    plugins.modules.register({
      id: 'dynamic',
      title: 'Dynamic',
      commands: [
        {
          id: 'inspect',
          label: 'Inspect',
          tool: {
            description: 'Read latest data',
            input_schema: {type: 'object', properties: {}, required: []},
            execute: () => ({text: 'current'}),
          },
        },
      ],
      panels: [panel],
    });
    const result = await plugins.modules.invoke({
      sessionId: session.id,
      moduleId: 'dynamic',
      panelId: 'dynamic',
      actionId: 'latest',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result?.text, 'current');
    await plugins.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('a failing request extension is visible while healthy panels remain usable and writes stay behind Agent permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mp-module-boundary-'));
  try {
    const session = await EventSession.open(root, 'module-boundary');
    const registry = new ToolRegistry();
    const plugins = await bootPlugins({
      directory: '',
      core: {tools: registry, session},
    });
    let wrote = false;
    plugins.modules.register({
      id: 'bounded',
      title: 'Bounded module',
      requestContext: () => {
        throw new Error('Source currently unavailable');
      },
      commands: [
        {
          id: 'inspect',
          label: 'Inspect',
          tool: {
            description: 'Read available status',
            input_schema: {type: 'object', properties: {}, required: []},
            effect: 'read',
            execute: () => ({text: 'Status is still readable'}),
          },
        },
        {
          id: 'change',
          label: 'Change',
          tool: {
            description: 'Change state',
            input_schema: {type: 'object', properties: {message: {type: 'string'}}, required: ['message']},
            effect: 'reversible_write',
            execute: () => {
              wrote = true;
              return {text: 'Changed'};
            },
          },
        },
      ],
      panels: [
        {
          id: 'status',
          render: () => ({
            id: 'status',
            title: 'Status',
            status: {state: 'ready'},
            sections: [
              {
                id: 'commands',
                rows: [],
                actions: [
                  {id: 'inspect', label: 'Inspect'},
                  {id: 'change', label: 'Change', fields: [{name: 'message', label: 'Message', type: 'text', value: 'default'}]},
                ],
              },
            ],
          }),
          actions: {
            inspect: {commandId: 'inspect'},
            change: {commandId: 'change'},
          },
        },
      ],
    });
    assert.deepEqual(
      await plugins.modules.requestContext({
        sessionId: session.id,
        turn: 1,
        signal: new AbortController().signal,
      }),
      [],
    );
    const snapshot = await plugins.modules.snapshot();
    assert.equal(
      snapshot.modules.find(module => module.id === 'bounded')?.status,
      'error',
    );
    assert.ok(
      snapshot.errors.some(
        error => error.message === 'Source currently unavailable',
      ),
    );
    const request = {
      sessionId: session.id,
      moduleId: 'bounded',
      panelId: 'status',
      actionId: 'inspect',
    };
    const read = await plugins.modules.invoke(request);
    assert.equal(read.ok, true, read.error);
    assert.equal(read.result?.text, 'Status is still readable');
    const write = await plugins.modules.invoke({
      ...request,
      actionId: 'change',
      inputs: {message: 'Edited by user'},
    });
    assert.equal(write.ok, false);
    assert.match(write.error!, /Agent turn/);
    assert.equal(wrote, false);
    assert.equal(write.agentRequest?.toolName, 'Modules.bounded.change');
    assert.equal(write.agentRequest?.actionLabel, 'Change');
    assert.deepEqual(write.agentRequest?.arguments, {message: 'Edited by user'});
    assert.ok(
      session.events.some(
        event =>
          event.type === 'module/error' && event.data.moduleId === 'bounded',
      ),
    );
    await plugins.close();
    const restarted = await bootPlugins({
      directory: '',
      core: {session, tools: new ToolRegistry()},
    });
    restarted.modules.register({
      id: 'bounded',
      title: 'Bounded module',
      requestContext: () => '',
    });
    assert.equal(
      (await restarted.modules.snapshot()).modules.find(
        module => module.id === 'bounded',
      )?.status,
      'error',
      'a separate UI worker must retain the actual Runtime extension error',
    );
    await restarted.modules.requestContext({
      sessionId: session.id,
      turn: 2,
      signal: new AbortController().signal,
    });
    assert.equal(
      (await restarted.modules.snapshot()).modules.find(
        module => module.id === 'bounded',
      )?.status,
      'active',
      'successful requests clear the saved extension error',
    );
    await restarted.close();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
