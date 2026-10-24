'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const section = source.slice(source.indexOf('interface ComposerWorktree'), source.indexOf('function renderProjectContext()'));

function fixture(saved = null) {
  let click;
  const attrs = new Map();
  const storage = new Map(saved ? [['mp:composer-worktree', JSON.stringify(saved)], ['mp:composer-worktree-enabled', 'true']] : []);
  const button = { disabled: false, hidden: false, setAttribute: (k,v)=>attrs.set(k,v), removeAttribute:k=>attrs.delete(k),
    addEventListener: (_event, fn)=>{click=fn;} };
  const calls = [];
  const context = vm.createContext({
    // The extracted section registers handlers for several composer
    // controls; only the worktree button is under test, so every other id
    // resolves to null and cannot clobber the captured click.
    document: { getElementById: id=>id==='composer-worktree' ? button : null,
      querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem:k=>storage.get(k)??null, setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k) },
    activeProjectRoot: saved?.path || 'D:/repo', activeConversationId: null, activeProjectId: '',
    studioComposerBusy: false, projectEnvironment: undefined, composerBranchSelection: '',
    normalizedProjectRoot: value=>value.toLowerCase(),
    setActiveProject: root=>{ context.activeProjectRoot=root; },
    studioT: key=>key,
    Data: { projectWorktree: async payload=>{calls.push(payload); return {ok:true,path:'D:/managed/worktree',branch:'mp/example'};},
      projectEnvironment: async ()=>({ok:true, root:'D:/repo', isGit:true, branches:[]}) },
  });
  vm.runInContext(ts.transpileModule(section, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText, context);
  return { context, calls, attrs, storage, toggle:()=>click({currentTarget:button}),
    prepare:()=>vm.runInContext('prepareComposerWorktree()',context) };
}

(async()=>{
  const f=fixture();
  f.toggle();
  assert.equal(f.attrs.get('aria-checked'),'true');
  assert.equal(f.calls.length,0,'selecting must not wait for a git checkout');
  const prepared = await f.prepare();
  assert.equal(prepared.executionWorkspaceRoot,'D:/managed/worktree');
  assert.equal(prepared.projectRoot,'D:/repo');
  assert.equal(f.calls[0].action,'create');
  f.toggle();
  assert.equal(f.attrs.get('aria-checked'),'false');
  assert.equal(f.context.activeProjectRoot,'D:/repo');
  assert.equal(f.calls.length,1,'unchecking a dirty worktree must never try to remove it');
  f.toggle();
  assert.equal((await f.prepare()).executionWorkspaceRoot,'D:/managed/worktree');
  assert.equal(f.calls.length,2,'reselecting goes through the same idempotent reuse call');
  assert.equal(f.calls[1].action,'create');
  assert.equal(f.calls[1].path,'D:/managed/worktree','reuse passes the stored worktree path');

  const pending=fixture();
  pending.context.Data.projectWorktree=()=>new Promise(()=>{});
  pending.toggle();
  const cancelled=pending.prepare();
  pending.toggle();
  await assert.rejects(cancelled,/Workspace selection changed/,
    'toggling off mid-send must fail loudly, never silently use another workspace');
  assert.equal(pending.context.activeProjectRoot,'D:/repo');

  const failed=fixture();
  failed.context.Data.projectWorktree=async()=>({ok:false,error:'not a git repository'});
  failed.toggle();
  await assert.rejects(failed.prepare(),/not a git repository/);
  assert.equal(failed.context.activeProjectRoot,'D:/repo');
  assert.equal(failed.attrs.get('data-error'),'true');
  console.log('composer worktree selection, cancellation, reuse and failure paths passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
