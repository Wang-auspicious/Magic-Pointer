import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync('electron/main.ts', 'utf8');
const ast = ts.createSourceFile(
  'main.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const names = ['initializePersonalActivity', 'initializeContextTrackers'];
const functions = ast.statements
  .filter(
    node =>
      ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ''),
  )
  .map(node => node.getText(ast));
assert.equal(functions.length, 2);
let reportOptions: any;
let trackerOptions: any;
const delivered: any[] = [];
const sandbox = {
  configureDesktop() {},
  ROOT: '',
  FABRIC_DATA_DIR: '',
  process: {env: {}},
  app: {getPath: () => ''},
  fs: {existsSync: () => false},
  path: {join: () => ''},
  conversations: () => ({listProjects: () => [], list: () => []}),
  PersonalActivityService: class {
    constructor(_directory: string, options: any) {
      reportOptions = options;
    }
    start() {
      return Promise.resolve();
    }
  },
  personalActivityService: null,
  contextTrackerRuntime: null,
  createContextTrackerRuntime: (options: any) => {
    trackerOptions = options;
    return {start: () => Promise.resolve()};
  },
  fabricSettings: {notifications: {}},
  dashboardWindow: null,
  desktopNotifications: {show: (...args: any[]) => delivered.push(args)},
  require: () => ({
    Notification: class {
      static isSupported() {
        return true;
      }
      on() {}
      show() {}
    },
  }),
};
vm.runInNewContext(
  ts.transpileModule(functions.join('\n'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText +
    '\ninitializePersonalActivity(); initializeContextTrackers();',
  sandbox,
);
reportOptions.onReport({date: '2026-10-20'});
trackerOptions.onRun(
  {task: 'Review'},
  {
    status: 'completed',
    conversationId: 'conversation-42',
    artifacts: [{artifactId: 'draft-7'}],
  },
);
trackerOptions.onRun({task: 'Review'}, {status: 'waiting'});
assert.deepEqual(
  JSON.parse(JSON.stringify(delivered.map(item => item[2]))),
  [
    {view: 'personal', date: '2026-10-20'},
    {view: 'chat', conversationId: 'conversation-42', artifactId: 'draft-7'},
    {view: 'scheduled'},
  ],
  'Both real notification producers must preserve the destination across process restarts',
);
console.log(
  'Real report/routine notification producers preserve their activation targets',
);
