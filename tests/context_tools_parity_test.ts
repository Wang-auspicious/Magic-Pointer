import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {
  registerContextTools,
  registerSource,
  SourceReaderRegistry,
  type ContextEvent,
  type Json,
  type ReadResult,
  type SourceRef,
} from '../electron/runtime/context';
import { scheduleToolCalls, ToolRegistry, type ToolEvent } from '../electron/runtime/tools';
import { ChatReader } from '../electron/runtime/context_surfaces';

function session() {
  const events: ContextEvent[] = [];
  return { id: 'context-parity', events, append(type: string, data: Json) { events.push({ type, data }); } };
}

function source(id: string, kind: string, identity: Json = {}, origin = 'user-attached'): SourceRef {
  return { sourceId: id, taskId: 'context-parity', kind, title: id, identity, revision: {}, capabilities: ['read', 'search'], origin, parentSourceId: null };
}

function result(item: SourceRef): ReadResult {
  return { sourceId: item.sourceId, fragments: [], coverage: { extent: 'document', readRanges: [], totalUnits: 0, complete: true, nextCursor: null, missingReason: null }, evidenceStatus: 'empty_confirmed', usedBackend: 'fixture', latencyMs: 0 };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('chat reads sharing one window serialize while an independent document reads concurrently', async () => {
  const active = session();
  const chatA = source('chat-a', 'chat', { window: { hwnd: 42 }, conversationIdentity: { adapterId: 'wechat', conversationKey: 'group-a', windowHwnd: 42 } });
  const chatB = source('chat-b', 'chat', { window: { hwnd: 42 }, conversationIdentity: { adapterId: 'wechat', conversationKey: 'group-b', windowHwnd: 42 } });
  const unbound = source('chat-unbound', 'chat', { conversationIdentity: { adapterId: 'wechat', conversationKey: 'unknown' } });
  const file = source('file', 'file');
  for (const item of [chatA, chatB, unbound, file]) registerSource(active, item);
  const waits = { 'chat-a': gate(), 'chat-b': gate() }, starts: string[] = [];
  const readers = new SourceReaderRegistry();
  readers.register('chat', { async read(item) { starts.push(item.sourceId); await waits[item.sourceId as 'chat-a' | 'chat-b'].promise; return result(item); } });
  readers.register('file', { async read(item) { starts.push(item.sourceId); return result(item); } });
  const registry = new ToolRegistry();
  registerContextTools(registry, active, readers);
  const calls = [
    { id: '0', name: 'Context.read', arguments: { source_id: 'chat-a' } },
    { id: '1', name: 'Context.read', arguments: { source_id: 'file' } },
    { id: '2', name: 'Context.search', arguments: { query: 'past', source_ids: ['chat-b'] } },
  ];
  const boundKeys = registry.claim(calls[0]).keys;
  assert.equal(boundKeys.has('chat:unbound'), true);
  assert.equal(boundKeys.has('chat:window:42'), true);
  assert.equal(registry.claim(calls[2]).keys.has('chat:window:42'), true);
  assert.equal(registry.claim(calls[1]).keys.size, 0);
  const events: ToolEvent[] = [];
  const running = (async () => { for await (const event of scheduleToolCalls(calls, registry)) events.push(event); })();
  await tick();
  const beforeFirstCompleted = [...starts];
  waits['chat-a'].release();
  await tick();
  const afterFirstCompleted = [...starts];
  waits['chat-b'].release();
  await running;
  assert.deepEqual(beforeFirstCompleted, ['chat-a', 'file']);
  assert.deepEqual(afterFirstCompleted, ['chat-a', 'file', 'chat-b']);
  assert.equal(events.filter(event => event.type === 'committed').length, 3);
});

test('search covers authorized task sources and preserves each source locator and continuation', async () => {
  const active = session();
  for (const item of [source('quote-a', 'file'), source('quote-b', 'file'), source('private', 'file', {}, 'task-discovered')]) registerSource(active, item);
  const reads: string[] = [];
  const readers = new SourceReaderRegistry();
  readers.register('file', { async read(item, options) {
    reads.push(item.sourceId);
    if (options?.query === 'missing' || options?.query === 'unsupported')
      return { ...result(item), evidenceStatus: options.query === 'missing' ? 'empty_confirmed' : 'unsupported' };
    const locator = { kind: 'text', value: { lineStart: 7, lineEnd: 7 } };
    return { ...result(item), fragments: [{ fragmentId: `fragment:${item.sourceId}`, locator, text: `${item.sourceId} quote: price ${item.sourceId === 'quote-a' ? 10 : 20}`, metadata: {}, citations: [{ sourceId: item.sourceId, locator }] }],
      coverage: { extent: 'query-results', readRanges: [locator], totalUnits: 12, complete: false, nextCursor: `${item.sourceId}:next`, missingReason: null },
      evidenceStatus: 'ok', usedBackend: 'fixture.search', latencyMs: 1, structure: { query: options?.query } };
  } });
  const registry = new ToolRegistry();
  registerContextTools(registry, active, readers);
  const searched = await registry.execute({ id: 'search-all', name: 'Context.search', arguments: { query: 'quote' } });
  assert.equal(searched.is_error, false, searched.error_message);
  const value = searched.value as { results: Array<ReadResult & { source: SourceRef }> };
  assert.deepEqual(value.results.map(item => item.source.sourceId), ['quote-a', 'quote-b']);
  assert.deepEqual(value.results.map(item => item.fragments[0]?.text), ['quote-a quote: price 10', 'quote-b quote: price 20']);
  assert.deepEqual(value.results.map(item => item.fragments[0]?.citations[0]), [
    { sourceId: 'quote-a', locator: { kind: 'text', value: { lineStart: 7, lineEnd: 7 } } },
    { sourceId: 'quote-b', locator: { kind: 'text', value: { lineStart: 7, lineEnd: 7 } } },
  ]);
  assert.deepEqual(value.results.map(item => item.coverage.nextCursor), ['quote-a:next', 'quote-b:next']);
  assert.deepEqual(reads, ['quote-a', 'quote-b']);
  const bounded = await registry.execute({ id: 'search-bounded', name: 'Context.search', arguments: { query: 'quote', limit: 1 } });
  assert.equal(bounded.is_error, false, bounded.error_message);
  assert.equal((bounded.value as typeof value).results.length, 1);
  assert.deepEqual((bounded.value as { remainingSourceIds: string[] }).remainingSourceIds, ['quote-b']);
  const selected = await registry.execute({ id: 'search-b', name: 'Context.search', arguments: { query: 'quote', source_ids: ['quote-b'] } });
  assert.equal(selected.is_error, false, selected.error_message);
  assert.deepEqual((selected.value as typeof value).results.map(item => item.source.sourceId), ['quote-b']);
  const denied = await registry.execute({ id: 'search-private', name: 'Context.search', arguments: { query: 'quote', source_ids: ['private'] } });
  assert.equal(denied.failure_type, 'permission_denied');
  assert.deepEqual(reads, ['quote-a', 'quote-b', 'quote-a', 'quote-b']);
  const single = await registry.execute({ id: 'search-single', name: 'Context.search', arguments: { query: 'quote', source_id: 'quote-a' } });
  assert.equal(single.is_error, false, single.error_message);
  assert.deepEqual((single.value as typeof value).results.map(item => item.source.sourceId), ['quote-a']);
  const empty = await registry.execute({ id: 'search-missing', name: 'Context.search', arguments: { query: 'missing' } });
  assert.equal((empty.value as { evidenceStatus: string }).evidenceStatus, 'empty_confirmed');
  const unsupported = await registry.execute({ id: 'search-unsupported', name: 'Context.search', arguments: { query: 'unsupported' } });
  assert.equal((unsupported.value as { evidenceStatus: string }).evidenceStatus, 'unsupported');
});

test('browser pointing binds CDP browser PID to the visible window and resolves shared PID only at reliable scale', async () => {
  const file = readFileSync(join(__dirname, '..', 'electron', 'runtime', 'desktop_adapters.ts'), 'utf8');
  const ast = ts.createSourceFile('desktop_adapters.ts', file, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readBrowserSelection');
  assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(ast).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let pages = [{ id: 'background', type: 'page' }, { id: 'foreground', type: 'page' }];
  let states: Record<string, Json> = {
    background: { visibilityState: 'hidden', screenX: 100, screenY: 100, outerWidth: 900, outerHeight: 600, devicePixelRatio: 1 },
    foreground: { visibilityState: 'visible', screenX: 100, screenY: 100, outerWidth: 900, outerHeight: 600, devicePixelRatio: 1 },
  };
  let browserPid = 7;
  let nativeWindows: Json[] = [];
  const select = vm.runInNewContext(`${code}\nreadBrowserSelection`, {
    AbortSignal,
    BROWSER_DOM_PROBE_SCRIPT: 'probe', BROWSER_DOM_REGION_PROBE_SCRIPT: 'regionProbe',
    CdpConnection: class {
      async request() { return { processInfo: [{ type: 'browser', id: browserPid }] }; }
      close() {}
    },
    listWindows: async () => nativeWindows,
    fetch: async (url: string) => ({ json: async () => url.endsWith('/json/list') ? pages : { webSocketDebuggerUrl: 'ws://browser-instance' } }),
    evaluateBrowser: async (_endpoint: string, id: string, expression: string) => vm.runInNewContext(expression, {
      document: { visibilityState: states[id]!.visibilityState }, window: states[id],
      probe: () => ({ state: 'resolved', page: { title: 'Shared', url: 'https://example.test/same', documentEpoch: 'epoch-1' },
        node: { text: id }, coordinates: { hitTestVerified: true } }),
      regionProbe: () => ({ state: 'resolved', page: { title: 'Shared', url: 'https://example.test/same', documentEpoch: 'epoch-1' },
        text: id }),
    }),
  }) as (window: Json, request: Json) => Promise<Json>;
  const window = { hwnd: 42, pid: 7, title: 'Shared - Chrome', bbox: [100, 100, 1000, 700] };
  nativeWindows = [window];
  const pointed = await select(window, { endpoint: 'http://cdp.test', point: { x: 500, y: 400 } });
  assert.equal(((pointed.artifacts as Json).browser_context as Json).provenance &&
    (((pointed.artifacts as Json).browser_context as Json).provenance as Json).targetId, 'foreground');
  states.foreground!.devicePixelRatio = 1.25;
  const singleHighDpi = await select(window, { endpoint: 'http://cdp.test', point: { x: 500, y: 400 } });
  assert.equal(((((singleHighDpi.artifacts as Json).browser_context as Json).provenance as Json).targetId), 'foreground');
  states.foreground!.devicePixelRatio = 1;
  pages = [{ id: 'unrelated', type: 'page' }];
  states = { unrelated: { visibilityState: 'visible', screenX: 100, screenY: 100, outerWidth: 900, outerHeight: 600, devicePixelRatio: 1 } };
  browserPid = 8;
  nativeWindows = [window, { hwnd: 43, pid: 8, title: 'Shared - Chrome', bbox: [100, 100, 1000, 700] }];
  await assert.rejects(select(window, { endpoint: 'http://cdp.test', point: { x: 500, y: 400 } }), /browser_target_ambiguous/);
  browserPid = 0;
  nativeWindows = [window];
  await assert.rejects(select(window, { endpoint: 'http://cdp.test', point: { x: 500, y: 400 } }), /browser_target_ambiguous/);
  browserPid = 7;

  pages = [{ id: 'left', type: 'page' }, { id: 'right', type: 'page' }];
  states = {
    left: { visibilityState: 'visible', screenX: 0, screenY: 0, outerWidth: 900, outerHeight: 600, devicePixelRatio: 1 },
    right: { visibilityState: 'visible', screenX: 100, screenY: 100, outerWidth: 900, outerHeight: 600, devicePixelRatio: 1 },
  };
  nativeWindows = [window, { hwnd: 43, pid: 7, title: 'Shared - Chrome', bbox: [0, 0, 900, 600] }];
  const matched = await select(window, { endpoint: 'http://cdp.test', point: { x: 500, y: 400 } });
  assert.equal(((((matched.artifacts as Json).browser_context as Json).provenance as Json).targetId), 'right');
  states.right!.devicePixelRatio = 1.25;
  await assert.rejects(select(window, { endpoint: 'http://cdp.test', point: { x: 500, y: 400 } }), /browser_target_ambiguous/);

  const windows: Record<string, Json> = {
    a: { visibilityState: 'visible', screenX: 0, screenY: 0, outerWidth: 900, outerHeight: 600, devicePixelRatio: 1 },
    b: { visibilityState: 'visible', screenX: 100, screenY: 100, outerWidth: 900, outerHeight: 600, devicePixelRatio: 1 },
  };
  const acrossEndpoints = vm.runInNewContext(`${code}\nreadBrowserSelection`, {
    AbortSignal,
    process: { env: { MAGIC_POINTER_CDP_ENDPOINTS: 'http://cdp-a.test,http://cdp-b.test' } },
    BROWSER_DOM_PROBE_SCRIPT: 'probe', BROWSER_DOM_REGION_PROBE_SCRIPT: 'regionProbe',
    CdpConnection: class {
      constructor(private url: string) {}
      async request() { return { processInfo: [{ type: 'browser', id: this.url.includes('cdp-a') ? 8 : 7 }] }; }
      close() {}
    },
    listWindows: async () => [window, { hwnd: 43, pid: 8, title: 'Shared - Chrome', bbox: [0, 0, 900, 600] }],
    fetch: async (url: string) => ({ json: async () => url.endsWith('/json/list')
      ? [{ id: url.includes('cdp-a') ? 'a' : 'b', type: 'page' }]
      : { webSocketDebuggerUrl: `ws://cdp-${url.includes('cdp-a') ? 'a' : 'b'}` } }),
    evaluateBrowser: async (_endpoint: string, id: string, expression: string) => vm.runInNewContext(expression, {
      document: { visibilityState: 'visible' }, window: windows[id],
      probe: () => ({ state: 'resolved', page: { title: 'Shared', url: 'https://example.test/same', documentEpoch: 'epoch-1' },
        node: { text: id }, coordinates: { hitTestVerified: true } }),
      regionProbe: () => ({ state: 'resolved', page: { title: 'Shared', url: 'https://example.test/same', documentEpoch: 'epoch-1' },
        text: id }),
    }),
  }) as (window: Json, request: Json) => Promise<Json>;
  const actualWindow = await acrossEndpoints(window, { point: { x: 500, y: 400 } });
  assert.equal(((((actualWindow.artifacts as Json).browser_context as Json).provenance as Json).targetId), 'b');
  windows.b!.devicePixelRatio = 1.25;
  const highDpiWindow = await acrossEndpoints(window, { point: { x: 500, y: 400 } });
  assert.equal(((((highDpiWindow.artifacts as Json).browser_context as Json).provenance as Json).targetId), 'b');
});

test('bound chat identity rejects a different conversation in the same window', () => {
  const file = readFileSync(join(__dirname, '..', 'electron', 'runtime', 'context_surfaces.ts'), 'utf8');
  const ast = ts.createSourceFile('context_surfaces.ts', file, ts.ScriptTarget.Latest, true);
  const fields = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'identityFields'));
  const matcher = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sameConversation');
  assert.ok(fields && matcher, 'ChatReader must use a bound identity comparison');
  const code = ts.transpileModule(`${fields.getText(ast)}\n${matcher.getText(ast)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sameConversation = vm.runInNewContext(`${code}\nsameConversation`, {}) as (expected: Json, current: Json) => boolean;
  const expected = { adapterId: 'wechat', conversationKey: 'wechat:window:42:surface:root',
    windowHwnd: 42, title: 'Original group', type: 'group' };
  assert.equal(sameConversation(expected, { ...expected, title: 'Another group' }), false);
});

test('chat adapter retains a verified bound identity and does not label general UI text as messages', async () => {
  const file = readFileSync(join(__dirname, '..', 'electron', 'runtime', 'desktop_adapters.ts'), 'utf8');
  const ast = ts.createSourceFile('desktop_adapters.ts', file, ts.ScriptTarget.Latest, true);
  const names = new Set(['conversationIdentity', 'readChat']);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''));
  assert.equal(declarations.length, 2);
  const code = ts.transpileModule(declarations.map(node => node.getText(ast).replace(/^export /, '')).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let liveTitle = 'North launch';
  let liveNativeId: string | null = 'group-native-42';
  let requestedRegion: Json = {};
  const readPage = vm.runInNewContext(`${code}\nreadChat`, {
    nativeRequest: async () => ({ hwnd: 9001, pid: 7, title: liveTitle, bbox: [10, 20, 810, 620] }),
    probeSelection: async (_hwnd: number, options: Json) => {
      requestedRegion = options.region as Json;
      return { native_conversation_id: liveNativeId, region_elements: [
        { text: 'North launch', control_type: 'ControlType.Text', rect: [20, 30, 80, 20] },
        { text: '确认财务报价', native_message_id: 'msg-1', speaker: 'Ada', time: '09:01', rect: [400, 300, 120, 30] },
      ], text: 'North launch\n确认财务报价' };
    },
  }) as (window: Json, adapter: string) => Promise<Json>;
  const bound = { hwnd: 9001, pid: 7, title: 'North launch', bbox: [10, 20, 810, 620], nativeConversationId: 'group-native-42', accountKey: 'workspace-a' };
  const page = await readPage(bound, 'wechat');
  assert.deepEqual(JSON.parse(JSON.stringify(requestedRegion)), { x: 10, y: 20, width: 800, height: 600 });
  assert.equal((page.conversationIdentity as Json).nativeConversationId, 'group-native-42');
  assert.equal(page.nextCursor, 'older:1');
  assert.deepEqual((page.messages as Json[]).map(item => item.text), ['确认财务报价']);
  liveNativeId = null;
  const unverified = await readPage(bound, 'wechat');
  assert.equal((unverified.conversationIdentity as Json).nativeConversationId, 'group-native-42');
  assert.equal(unverified.nextCursor, null);
  assert.ok((unverified.limitations as string[]).includes('conversation-native-identity-unavailable'));
  liveTitle = 'Another group';
  liveNativeId = 'group-native-42';
  const switched = await readPage(bound, 'wechat');
  assert.equal((switched.conversationIdentity as Json).title, 'Another group');
  assert.equal(switched.nextCursor, null);

  const surfaceFile = readFileSync(join(__dirname, '..', 'electron', 'runtime', 'context_surfaces.ts'), 'utf8');
  const surfaceAst = ts.createSourceFile('context_surfaces.ts', surfaceFile, ts.ScriptTarget.Latest, true);
  const navigator = surfaceAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'navigateChatHistory');
  assert.ok(navigator);
  const navigatorCode = ts.transpileModule(navigator.getText(surfaceAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const actions: Array<{ name: string; args: Json }> = [];
  const navigate = vm.runInNewContext(`${navigatorCode}\nnavigateChatHistory`, {
    record: (value: unknown) => value ?? {}, array: (value: unknown) => Array.isArray(value) ? value : [],
    delay: async () => {},
    executeDesktopAction: async (name: string, args: Json) => {
      actions.push({ name, args });
      if (name === 'activate_window') return { ok: true };
      if (name === 'get_app_state') return { snapshot_id: 'full-state-1', window: { hwnd: 9001, pid: 7, title: 'North launch', bbox: [10, 20, 810, 620] } };
      return { ok: true, usedBackend: 'fixture.native-scroll' };
    },
  }) as (window: Json, identity: Json, cursor: string) => Promise<Json>;
  const navigation = await navigate(bound, { nativeConversationId: 'group-native-42', windowHwnd: 9001, processId: 7, title: 'North launch' }, 'older:1');
  assert.equal(navigation.ok, true);
  assert.deepEqual(actions.map(item => item.name), ['activate_window', 'get_app_state', 'scroll']);
  assert.deepEqual(JSON.parse(JSON.stringify(actions[2]!.args)), { sessionId: 'chat-history', snapshot_id: 'full-state-1', x: 410, y: 320, dx: 0, dy: 720 });
});

test('chat search follows a verified native conversation into older pages and stops at a repeated viewport', async () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'chat', 'two_page_conversation.json'), 'utf8')) as {
    conversation: Json;
    pages: { messages: Json[] }[];
  };
  const conversation = fixture.conversation;
  const chat = source('chat-history', 'chat', {
    conversationIdentity: conversation,
    window: { hwnd: conversation.windowHwnd, pid: 7, title: conversation.title, bbox: [0, 0, 800, 600], process_name: 'WeChat.exe' },
  });
  let viewport = 0;
  const navigation: string[] = [];
  const newer = fixture.pages[1]!.messages, older = fixture.pages[0]!.messages;
  const io = {
    readPage: async (_window: Json, _adapter: string) => ({
      conversationIdentity: conversation,
      messages: viewport === 0 ? newer : older,
      nextCursor: `older:${viewport + 1}`,
      complete: false,
      limitations: [],
      usedBackend: 'fixture.chat-uia',
      pagePosition: viewport ? 'before' : 'initial',
    }),
    navigate: async (_window: Json, _identity: Json, cursor: string) => {
      navigation.push(cursor);
      viewport = 1;
      return { ok: true, receipt: { ok: true, usedBackend: 'fixture.scroll', cursor }, usedBackend: 'fixture.scroll' };
    },
  };
  const reader = new ChatReader(undefined, io);
  const searched = await reader.read(chat, { query: '财务', limit: 20 });
  assert.deepEqual(searched.fragments.map(item => item.text), [
    '旧报价暂按 18 万元，等待财务确认。',
    '请以财务后续确认作为最终口径。',
    '财务确认版见附件，旧报价作废。',
  ]);
  assert.deepEqual(navigation, ['older:1', 'older:2']);
  assert.equal((((searched.structure?.pages as Json[])[1]!).navigationReceipt as Json).usedBackend, 'fixture.scroll');
  assert.equal(searched.coverage.complete, false, 'idless repeated rows leave the history boundary uncertain');
  assert.match(String(searched.coverage.missingReason), /history-boundary-uncertain-identical-page/);
  viewport = 0;
  const continuationReader = new ChatReader(undefined, io);
  const first = await continuationReader.read(chat);
  assert.equal(first.coverage.nextCursor, 'older:1');
  const olderPage = await continuationReader.read(chat, { cursor: first.coverage.nextCursor });
  assert.deepEqual(olderPage.fragments.map(item => item.text), [
    '旧报价暂按 18 万元，等待财务确认。', '好的', '好的',
  ]);
  assert.equal(((olderPage.structure?.pages as Json[])[0]!.navigationReceipt as Json).usedBackend, 'fixture.scroll');

  let unsafeNavigation = 0;
  const weak = { ...chat, identity: { ...chat.identity, conversationIdentity: { ...conversation, nativeConversationId: null, conversationKey: 'wechat:window:9001:surface:root' } } };
  const weakReader = new ChatReader(undefined, {
    ...io,
    readPage: async () => ({ conversationIdentity: weak.identity.conversationIdentity, messages: newer, nextCursor: 'older:1', complete: false, limitations: [], usedBackend: 'fixture.chat-uia' }),
    navigate: async () => { unsafeNavigation++; return { ok: true }; },
  });
  const limited = await weakReader.read(weak, { query: '旧报价' });
  assert.equal(unsafeNavigation, 0);
  assert.match(String(limited.coverage.missingReason), /ambiguous-conversation-cannot-navigate/);
  const navigationCount = navigation.length;
  const oldCursor = await new ChatReader(undefined, {
    ...io,
    readPage: async () => ({ conversationIdentity: conversation, messages: newer, nextCursor: null, complete: false, limitations: ['conversation-native-identity-unavailable'] }),
  }).read(chat, { cursor: 'older:1' });
  assert.equal(oldCursor.coverage.nextCursor, null);
  assert.match(String(oldCursor.coverage.missingReason), /ambiguous-conversation-cannot-navigate/);
  assert.equal(navigation.length, navigationCount, 'stale continuation must not add a navigation');
});
