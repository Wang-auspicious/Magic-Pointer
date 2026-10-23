import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {PersonalActivityService} from '../electron/personal_activity_service';
import {parseDesktopNotificationTarget} from '../electron/desktop_notifications';

const viewCode = ts.transpileModule(
  fs.readFileSync('electron/renderer/personal_activity_view.ts', 'utf8'),
  {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  },
).outputText;
const main = ts.createSourceFile(
  'main.ts',
  fs.readFileSync('electron/main.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const channels = [
  'personal-activity:read',
  'personal-activity:generate',
  'personal-activity:open-source',
];
const registrations = main.statements.filter(node => {
  if (
    !ts.isExpressionStatement(node) ||
    !ts.isCallExpression(node.expression) ||
    node.expression.expression.getText(main) !== 'ipcMain.handle'
  ) {
    return false;
  }
  const channel = node.expression.arguments[0];
  return ts.isStringLiteral(channel) && channels.includes(channel.text);
});
assert.equal(registrations.length, 3);
const studio = ts.createSourceFile(
  'studio.ts',
  fs.readFileSync('electron/renderer/studio.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const showRegistration = studio.statements.find(
  node =>
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.getText(studio) ===
      'window.magicPointerDashboard?.onShow',
);
assert.ok(showRegistration && ts.isExpressionStatement(showRegistration));
const showCallback = (showRegistration.expression as ts.CallExpression)
  .arguments[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}

async function fixture(run: (f: any) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mp-personal-date-'));
  const service = new PersonalActivityService(directory, {
    now: () => new Date(2026, 9, 22, 12).getTime(),
    createNative: () => {
      throw new Error('Native collection must not start in this test');
    },
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const sourceReads: Array<{file: string; content: string}> = [];
  const listeners = new Map<string, (event: any) => void>();
  const timers = new Map<number, () => void>();
  const reads: string[] = [];
  const generations: string[] = [];
  const gates = new Map<string, Promise<any>>();
  let generateOverride: ((date: string) => Promise<any>) | undefined;
  let lastRead: Promise<any> = Promise.resolve();
  let lastAction: Promise<any> = Promise.resolve();
  let timerId = 0;
  const feedback = {textContent: ''};
  const search = {focus() {}, setSelectionRange() {}};
  const host = {
    innerHTML: '',
    addEventListener: (name: string, callback: (event: any) => void) =>
      listeners.set(name, callback),
    querySelectorAll: () => [],
    querySelector: (selector: string) =>
      selector === '.personal-feedback' ? feedback : search,
    contains: () => false,
  };
  try {
    await service.store.open();
    await service.store.updateSettings({
      enabled: true,
      screenEnabled: true,
      screenpipeEnabled: false,
      roots: [],
    });
    await mkdir(path.join(directory, 'screens'), {recursive: true});
    for (const [day, marker] of [
      ['2026-10-19', 'material A'],
      ['2026-10-20', 'material B'],
    ]) {
      const file = path.join(directory, 'screens', `${day}.txt`);
      await writeFile(file, marker);
      await service.store.recordScreen({
        at: new Date(`${day}T12:00:00`).toISOString(),
        appId: 'fixture',
        title: marker,
        path: file,
        text: marker,
        usedBackend: 'fixture',
      });
    }
    const mainContext = vm.createContext({
      personalActivityService: service,
      ipcMain: {
        handle: (channel: string, callback: (...args: any[]) => any) =>
          handlers.set(channel, callback),
      },
      isDashboardSender: () => true,
      shell: {
        openPath: async (file: string) => {
          sourceReads.push({file, content: await readFile(file, 'utf8')});
          return '';
        },
        showItemInFolder: (file: string) => {
          sourceReads.push({file, content: fs.readFileSync(file, 'utf8')});
        },
      },
    });
    vm.runInContext(
      ts.transpileModule(
        registrations.map(node => node.getText(main)).join('\n'),
        {
          compilerOptions: {target: ts.ScriptTarget.ES2022},
        },
      ).outputText,
      mainContext,
    );
    const readSaved = (date: string) => handlers.get(channels[0])!({}, {date});
    const api = {
      read(date: string) {
        reads.push(date);
        lastRead = gates.get(date) || readSaved(date);
        return lastRead;
      },
      generate(date: string) {
        generations.push(date);
        lastAction = generateOverride
          ? generateOverride(date)
          : handlers.get(channels[1])!({}, {date});
        return lastAction;
      },
      openSource(payload: unknown) {
        lastAction = handlers.get(channels[2])!({}, payload);
        return lastAction;
      },
    };
    const context = vm.createContext({
      module: {exports: {}},
      document: {activeElement: {}},
      setInterval: (callback: () => void) => {
        timers.set(++timerId, callback);
        return timerId;
      },
      clearInterval: (id: number) => timers.delete(id),
    });
    vm.runInContext(viewCode, context);
    const controller = context.module.exports.mount(host, api);
    context.personalActivityUi = controller;
    context.show = (name: string) => {
      assert.equal(name, 'personal');
      controller.show();
    };
    vm.runInContext(
      ts.transpileModule(
        `globalThis.onShow = ${showCallback.getText(studio)}`,
        {
          compilerOptions: {target: ts.ScriptTarget.ES2022},
        },
      ).outputText,
      context,
    );
    const click = (dataset: Record<string, string>) => {
      const button = {dataset, disabled: false, closest: () => button};
      listeners.get('click')!({target: button});
    };
    const settle = async () => {
      await lastRead.catch(() => {});
      await new Promise(resolve => setImmediate(resolve));
    };
    const activate = (date: string) => {
      const target = parseDesktopNotificationTarget(
        JSON.stringify({view: 'personal', date}),
      );
      assert.ok(target?.view === 'personal');
      context.onShow({view: target.view, personalDate: target.date});
    };
    await run({
      host,
      controller,
      feedback,
      reads,
      generations,
      sourceReads,
      timers,
      gates,
      activate,
      click,
      settle,
      readSaved,
      service,
      directory,
      change(date: string) {
        listeners.get('change')!({
          target: {
            value: date,
            matches: (selector: string) => selector === '[data-personal-date]',
          },
        });
      },
      search(value: string) {
        listeners.get('input')!({
          target: {
            value,
            selectionStart: value.length,
            matches: (selector: string) =>
              selector === '[data-personal-search]',
          },
        });
      },
      poll() {
        for (const callback of timers.values()) {
          callback();
        }
      },
      async settleAction() {
        await lastAction.catch(() => {});
        await new Promise(resolve => setImmediate(resolve));
      },
      setGenerate(value: (date: string) => Promise<any>) {
        generateOverride = value;
      },
    });
    controller.hide();
  } finally {
    await service.stop();
    assert.equal(path.dirname(directory), os.tmpdir());
    await rm(directory, {recursive: true, force: true});
  }
}

test('changing the report date removes old material before a new reply and cannot open a wrong-day index', () =>
  fixture(async f => {
    f.activate('2026-10-19');
    await f.settle();
    assert.match(f.host.innerHTML, /material A/);
    const next = deferred<any>();
    f.gates.set('2026-10-20', next.promise);
    f.change('2026-10-20');
    assert.doesNotMatch(f.host.innerHTML, /material A/);
    f.click({personalScreen: '0'});
    f.click({personalAction: 'report'});
    await f.settleAction();
    assert.equal(f.sourceReads.length, 0);
    assert.equal(f.generations.length, 0);
    next.resolve(await f.readSaved('2026-10-20'));
    await f.settle();
    assert.match(f.host.innerHTML, /material B/);
    f.click({personalScreen: '0'});
    await f.settleAction();
    assert.equal(f.sourceReads[0].content, 'material B');
  }));

test('failed date loading keeps a working date picker and Refresh retry without reviving old records', () =>
  fixture(async f => {
    f.activate('2026-10-19');
    await f.settle();
    const next = deferred<any>();
    f.gates.set('2026-10-20', next.promise);
    f.change('2026-10-20');
    next.reject(new Error('report read unavailable'));
    await f.settle();
    assert.doesNotMatch(f.host.innerHTML, /material A/);
    assert.match(f.host.innerHTML, /data-personal-date/);
    assert.ok(
      f.host.innerHTML.includes('report read unavailable') ||
        f.feedback.textContent.includes('report read unavailable'),
    );
    f.gates.delete('2026-10-20');
    f.click({personalAction: 'refresh'});
    await f.settle();
    assert.match(f.host.innerHTML, /material B/);
  }));

test('notification selection invalidates the prior report even before its old promise finishes', () =>
  fixture(async f => {
    const old = deferred<any>();
    f.gates.set('2026-10-19', old.promise);
    f.activate('2026-10-19');
    f.activate('2026-10-20');
    await f.settle();
    assert.match(f.host.innerHTML, /material B/);
    old.resolve(await f.readSaved('2026-10-19'));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(f.host.innerHTML, /material B/);
    assert.doesNotMatch(f.host.innerHTML, /material A/);
  }));

test('same-day pending refreshes coalesce and hiding the report stops additional reads', () =>
  fixture(async f => {
    const gate = deferred<any>();
    f.gates.set('2026-10-19', gate.promise);
    f.activate('2026-10-19');
    const waiting = f.controller.refresh();
    f.poll();
    f.click({personalAction: 'refresh'});
    assert.deepEqual(f.reads, ['2026-10-19']);
    gate.resolve(await f.readSaved('2026-10-19'));
    await waiting;
    await f.settle();
    f.controller.hide();
    await f.controller.refresh();
    assert.deepEqual(f.reads, ['2026-10-19']);
    assert.equal(f.timers.size, 0);
  }));

test('a late old-date action error does not overwrite a newly selected report feedback', () =>
  fixture(async f => {
    f.activate('2026-10-19');
    await f.settle();
    const action = deferred<any>();
    f.setGenerate(() => action.promise);
    f.click({personalAction: 'report'});
    f.change('2026-10-20');
    await f.settle();
    action.reject(new Error('old-date generation failed'));
    await f.settleAction();
    assert.match(f.host.innerHTML, /material B/);
    assert.doesNotMatch(f.feedback.textContent, /old-date generation failed/);
  }));

test('report generation starts a fresh read after mutation instead of borrowing an older pending snapshot', () =>
  fixture(async f => {
    f.activate('2026-10-19');
    await f.settle();
    const stale = await f.readSaved('2026-10-19');
    const old = deferred<any>();
    f.gates.set('2026-10-19', old.promise);
    const olderRead = f.controller.refresh();
    await f.service.store.recordKeyboardBatch({
      at: new Date('2026-10-19T12:00:00').toISOString(),
      counts: {Enter: 37},
    });
    f.gates.delete('2026-10-19');
    f.click({personalAction: 'report'});
    await f.settleAction();
    const countAfterMutation = f.reads.length;
    old.resolve(stale);
    await olderRead;
    await f.settle();
    assert.equal(
      countAfterMutation,
      3,
      'a changed report needs a newer read generation',
    );
    assert.ok(f.host.innerHTML.includes('<kbd>Enter</kbd></dt><dd>37</dd>'));
    const report = await readFile(
      path.join(f.directory, 'reports', '2026-10-19.md'),
      'utf8',
    );
    assert.match(report, /Enter.*37/);
  }));

test('opening a retained source does not reread the whole report', () =>
  fixture(async f => {
    f.activate('2026-10-19');
    await f.settle();
    f.click({personalScreen: '0'});
    await f.settleAction();
    assert.equal(f.sourceReads[0].content, 'material A');
    assert.deepEqual(f.reads, ['2026-10-19']);
  }));
