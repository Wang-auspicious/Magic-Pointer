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
    document: { getElementById: ()=>button },
    localStorage: { getItem:k=>storage.get(k)??null, setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k) },
    activeProjectRoot: saved?.path || 'D:/repo', activeConversationId: null,
    normalizedProjectRoot: value=>value.toLowerCase(),
    setActiveProject: root=>{ context.activeProjectRoot=root; },
    Data: { projectWorktree: async payload=>{calls.push(payload); return {ok:true,path:'D:/managed/worktree',branch:'mp/example'};} },
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
  assert.equal(await f.prepare(),'D:/managed/worktree');
  assert.equal(f.calls[0].action,'create');
  f.toggle();
  assert.equal(f.attrs.get('aria-checked'),'false');
  assert.equal(f.context.activeProjectRoot,'D:/repo');
  assert.equal(f.calls.length,1,'unchecking a dirty worktree must never try to remove it');
  f.toggle();
  assert.equal(await f.prepare(),'D:/managed/worktree');
  assert.equal(f.calls.length,1,'reselecting reuses the checkout and its edits');

  const pending=fixture();
  let finish;
  pending.context.Data.projectWorktree=()=>new Promise(resolve=>{finish=resolve;});
  pending.toggle();
  const preparation=pending.prepare();
  pending.toggle();
  finish({ok:true,path:'D:/managed/other',branch:'mp/other'});
  assert.equal(await preparation,'D:/repo','cancel during git setup must keep the original folder');
  assert.equal(pending.context.activeProjectRoot,'D:/repo');

  const failed=fixture();
  failed.context.Data.projectWorktree=async()=>({ok:false,error:'not a git repository'});
  failed.toggle();
  await assert.rejects(failed.prepare(),/not a git repository/);
  assert.equal(failed.context.activeProjectRoot,'D:/repo');
  assert.equal(failed.attrs.get('data-error'),'true');
  console.log('composer worktree selection, cancellation, reuse and failure paths passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
