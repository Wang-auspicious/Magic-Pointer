import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDesktop, DesktopActionSession, registerDesktopTools, type DesktopElement, type DesktopWindow } from '../electron/runtime/desktop';
import { authorizeAccess, ensureFolderReadScope, scopeFromEvents } from '../electron/runtime/context';
import { bindNamedWindows, bindDesktopWindow } from '../electron/runtime/context_prepare';
import { evidence, registerPerceptionTools } from '../electron/runtime/desktop_perception';
import { EventSession } from '../electron/runtime/session';
import { ToolRegistry } from '../electron/runtime/tools';

test('perception window enumeration hides titles outside the task window scope', async () => {
  const windows = [
    { hwnd: 41, pid: 7, title: 'Private Notes', bbox: [0, 0, 400, 300], focused: true },
    { hwnd: 42, pid: 7, title: 'Project Notes', bbox: [400, 0, 800, 300] },
  ];
  const backend = {
    read_around: () => evidence(null, 'empty_confirmed', 'fixture'),
    dump_subtree: () => evidence(null, 'empty_confirmed', 'fixture'),
    find_in_window: () => evidence(null, 'empty_confirmed', 'fixture'),
    list_windows: () => evidence(JSON.stringify(windows), 'ok', 'fixture'),
    get_focused: () => evidence(JSON.stringify(windows[0]), 'ok', 'fixture'),
  };
  const registry = new ToolRegistry();
  registerPerceptionTools(registry, { backend, windowReadScope: hwnd => hwnd === 42 });
  const listed = await registry.execute({ id: 'list', name: 'list_windows', arguments: {} });
  assert.equal(listed.is_error, false, listed.error_message);
  const rows = JSON.parse((listed.value as { value: string }).value);
  assert.equal(rows[0].title, '');
  assert.equal(rows[0].hwnd, 41);
  assert.equal(rows[1].title, 'Project Notes');
  const focused = await registry.execute({ id: 'focused', name: 'get_focused', arguments: {} });
  assert.equal(focused.is_error, false, focused.error_message);
  assert.equal(JSON.parse((focused.value as { value: string }).value).title, '');
});

test('desktop actions classify visible send and delete targets before permission and bind their window scope', () => {
  const window: DesktopWindow = { hwnd: 42, pid: 7, title: 'Chat', bbox: [0, 0, 400, 300] };
  const element = (index: number, name: string): DesktopElement => ({ index, hwnd: 42, name, role: 'button', rect: [index * 20, 10, index * 20 + 18, 30], runtime_id: [index], patterns: [] });
  const session = new DesktopActionSession('permission-fixture', 42);
  session.snapshots.set('state', { snapshot_id: 'state', state_id: 'state', window, windows: [window], elements: [element(1, 'Send'), element(2, 'Open'), element(3, '删除')], root_ref: '@r1', mode: 'ax' });
  const registry = new ToolRegistry();
  registerDesktopTools(registry, session);
  assert.equal(registry.effect('click', { state_id: 'state', ref: '@e1' }), 'external_send');
  assert.equal(registry.effect('click', { state_id: 'state', ref: '@e3' }), 'destructive');
  assert.equal(registry.effect('click', { state_id: 'state', ref: '@e2' }), 'reversible_write');
  assert.equal(registry.effect('click', { state_id: 'state', ref: '@e2', intent: 'send' }), 'external_send');
  assert.equal(registry.effect('press_key', { state_id: 'state', keys: 'enter' }), 'external_send');
  assert.equal(registry.effect('press_key', { state_id: 'state', keys: 'delete' }), 'destructive');
  assert.equal(registry.effect('press_key', { state_id: 'state', keys: 'shift+enter' }), 'reversible_write');
  for (const name of ['activate_window', 'launch_app', 'scroll', 'type_text', 'select_text', 'set_value'])
    assert.equal(registry.effect(name, {}), 'reversible_write', `${name} should not repeatedly prompt in Auto mode`);
  assert.deepEqual(registry.get('click').access_for?.({ state_id: 'state', ref: '@e1' }), { action: 'patch', windowIds: ['w-42'] });
  for (const name of ['scroll', 'drag', 'set_value', 'select_text']) assert.equal(registry.get(name).access_for, undefined);
});

test('a successfully acquired desktop target grants only that window to this task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-desktop-acquire-'));
  const task = await EventSession.open(root, 'desktop-acquire');
  const window: DesktopWindow = { hwnd: 42, pid: 7, process_name: 'msedge.exe', title: 'New tab', bbox: [0, 0, 400, 300] };
  class TargetSession extends DesktopActionSession {
    override async call() { return { ok: true, window, usedBackend: 'win32_activate', verification: { matched: true } }; }
  }
  const registry = new ToolRegistry();
  registerDesktopTools(registry, new TargetSession(task.id), request => authorizeAccess(scopeFromEvents(task.events, task.id), request),
    target => bindDesktopWindow(task, target));
  const result = await registry.execute({ id: 'focus', name: 'activate_window', arguments: { window_id: 'w-42' } });
  assert.equal(result.is_error, false, result.error_message);
  const reopened = await EventSession.open(root, task.id, false);
  const scope = scopeFromEvents(reopened.events, task.id);
  assert.equal(authorizeAccess(scope, { action: 'read', windowIds: ['w-42'] }).allowed, true);
  assert.equal(authorizeAccess(scope, { action: 'patch', windowIds: ['w-42'] }).allowed, true);
  assert.equal(authorizeAccess(scope, { action: 'read', windowIds: ['w-43'] }).allowed, false);
});

test('desktop reads honor the selected task window while keeping window candidates discoverable', async t => {
  t.after(() => closeDesktop());
  const root = await mkdtemp(join(tmpdir(), 'mp-desktop-read-scope-'));
  const task = await EventSession.open(root, 'desktop-read-scope');
  await ensureFolderReadScope(task, root);
  const windows: DesktopWindow[] = [
    { hwnd: 41, pid: 7, process_name: 'notepad.exe', title: 'Private Notes', bbox: [0, 0, 400, 300], focused: true },
    { hwnd: 42, pid: 7, process_name: 'notepad.exe', title: 'Project Notes', bbox: [400, 0, 800, 300] },
  ];
  let elementReads = 0;
  const desktop = new DesktopActionSession(task.id, 41);
  Object.assign(desktop, {
    observation: {
      windows: async () => windows,
      elements: async (hwnd: number) => {
        elementReads++;
        return [{ index: 1, hwnd, name: hwnd === 41 ? 'Private text' : 'Project text', role: 'text', rect: [10, 10, 100, 30], runtime_id: [1], patterns: [] }];
      },
    },
  });
  const registry = new ToolRegistry();
  registerDesktopTools(registry, desktop, request => authorizeAccess(scopeFromEvents(task.events, task.id), request));
  let callId = 0;
  const call = (name: string, args: Record<string, unknown> = {}) => registry.execute({ id: `${name}-${++callId}`, name, arguments: args });

  const denied = await call('get_app_state', { window_id: 'w-41', mode: 'ax' });
  assert.equal(denied.failure_type, 'permission_denied');
  assert.equal(elementReads, 0);
  const privateRoot = desktop.rootRef(41);
  const deniedRoot = await call('observe_ui', { root: privateRoot, mode: 'ax' });
  assert.equal(deniedRoot.failure_type, 'permission_denied');
  assert.equal(elementReads, 0);

  const apps = await call('list_apps');
  assert.equal(apps.is_error, false, apps.error_message);
  assert.equal(JSON.stringify(apps.value).includes('Private Notes'), false);
  const candidates = await call('find_roots', { app: 'notepad' });
  assert.equal(candidates.is_error, false, candidates.error_message);
  assert.equal(JSON.stringify(candidates.value).includes('Private Notes'), false);
  assert.equal((candidates.value as { roots: { window_id: string }[] }).roots.some(item => item.window_id === 'w-42'), true);

  await bindNamedWindows(task, '读取 Project Notes 窗口', windows);
  const namedRoots = await call('find_roots', { text: 'Project Notes' });
  assert.deepEqual((namedRoots.value as { roots: { window_id: string; title: string }[] }).roots.map(item => [item.window_id, item.title]), [['w-42', 'Project Notes']]);
  const allowed = await call('get_app_state', { window_id: 'w-42', mode: 'ax' });
  assert.equal(allowed.is_error, false, allowed.error_message);
  assert.equal((allowed.value as { window: DesktopWindow }).window.hwnd, 42);
  assert.equal(elementReads, 1);
  const allowedRoot = desktop.rootRef(42);
  const observed = await call('observe_ui', { root: allowedRoot, mode: 'ax' });
  assert.equal(observed.is_error, false, observed.error_message);
  assert.equal((observed.value as { window: DesktopWindow }).window.hwnd, 42);
  assert.equal(elementReads, 2);
  assert.equal(authorizeAccess(scopeFromEvents(task.events, task.id), { action: 'patch', windowIds: ['w-41'] }).allowed, false);
});
