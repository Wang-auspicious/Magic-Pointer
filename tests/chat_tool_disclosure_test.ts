import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

test('actual tool disclosures use native buttons and retain the user choice through streaming and history', () => {
  const source = fs.readFileSync('tests/chat_live_turn_test.js', 'utf8');
  const ast = ts.createSourceFile(
    'fixture.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const fixture = ast.statements.find(ts.isClassDeclaration)!.getText(ast);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const assert=require('node:assert/strict');
    ${fixture}
    const handlers=new Map(),selection={isCollapsed:true};
    TestNode.prototype.closest=function(selector) {
      for(let node=this;node;node=node.parentNode) {
        if(selector.split(',').some(part=>{const s=part.trim();return s.startsWith('.')?node.className.split(' ').includes(s.slice(1)):s.startsWith('[')?node.getAttribute(s.slice(1,-1))!==null:node.tagName.toLowerCase()===s;})) return node;
      }
      return null;
    };
    global.HTMLElement=TestNode;
    global.CustomEvent=class {constructor(type,options){this.type=type;this.detail=options.detail;}};
    const events=[];
    global.document={documentElement:{lang:'en',dataset:{}},getSelection:()=>selection,createElement:tag=>new TestNode(tag),createElementNS:(_ns,tag)=>new TestNode(tag),createTextNode:value=>new TestNode('',value),dispatchEvent:event=>events.push(event)};
    const chat=require('./electron/renderer/chat_view');
    const host=new TestNode('div');
    host.addEventListener=(name,handler)=>handlers.set(name,handler);
    chat.bindDelegation(host);
    const live=chat.createLiveTurn(host,'tool-button#0');
    const entry={kind:'tool',turn:1,callId:'read-button',name:'Read',text:'{"path":"D:/origin/notes.txt"}',state:'running'};
    const otherEntry={kind:'tool',turn:1,callId:'bash-button',name:'Bash',text:'{"command":"echo done"}',state:'done',result:'done'};
    live.update({trajectory:[entry,otherEntry]});
    live.update({trajectory:[{...entry,state:'done',result:'Actual persisted file content'},otherEntry]});
    const tool=host.querySelector('.mp-chat-tool'),root=tool.querySelector('.mp-chat-disclosure'),row=root.querySelector('.mp-chat-row'),toggle=row.querySelector('.mp-chat-row-toggle');
    assert.ok(toggle,'tool disclosure must expose the same native button as the original Step');
    assert.equal(toggle.tagName,'BUTTON');
    assert.equal(row.getAttribute('role'),null,'file actions cannot be nested inside a button role');
    assert.equal(row.getAttribute('tabindex'),null,'the native button owns the keyboard focus stop');
    const body=root.querySelector('.mp-chat-body-wrap');
    assert.equal(toggle.getAttribute('aria-controls'),body.getAttribute('id'));
    const labels=toggle.getAttribute('aria-labelledby').split(' ');
    const labelled=labels.map(id=>[row,...row.querySelectorAll('span')].find(node=>node.getAttribute('id')===id)).filter(Boolean);
    assert.match(labelled.map(node=>node.textContent).join(' '),/Read.*notes.txt/,'the accessible name identifies the actual file');
    assert.equal(row.querySelector('.mp-chat-row-caret').textContent,'\ue02a');
    assert.equal(root.getAttribute('data-open'),'false');
    selection.isCollapsed=false;
    handlers.get('click')({target:row});
    assert.equal(root.getAttribute('data-open'),'false','selecting the header cannot toggle it');
    handlers.get('click')({target:toggle});
    assert.equal(root.getAttribute('data-open'),'true','explicit toggle works with selected text');
    assert.equal(toggle.getAttribute('aria-expanded'),'true');
    assert.match(body.textContent,/Actual persisted file content/);
    const file=row.querySelector('.mp-chat-tool-file');
    assert.ok(file);
    assert.equal(file.closest('.mp-chat-row-toggle'),null,'the file action is a sibling of the disclosure button');
    let prevented=0,stopped=0;
    handlers.get('click')({target:file,preventDefault:()=>prevented++,stopPropagation:()=>stopped++});
    assert.equal(prevented,1);
    assert.equal(stopped,1);
    assert.equal(root.getAttribute('data-open'),'true');
    assert.ok(events.some(event=>event.type==='mp:open-file'&&event.detail.path==='D:/origin/notes.txt'));
    for(const key of ['Enter',' ']) {
      handlers.get('keydown')({target:toggle,key,repeat:false,preventDefault:()=>prevented++});
    }
    assert.equal(prevented,1,'native keyboard activation must not get a second synthetic toggle');
    selection.isCollapsed=true;
    const final={...entry,state:'done',result:'Actual persisted file content'};
    live.update({trajectory:[final,otherEntry],answer:'Done'});
    live.finish({conversationId:'tool-button',turnIndex:0,answer:'Done',trajectory:[final,otherEntry]});
    const settled=host.querySelector('.mp-chat-disclosure');
    assert.equal(settled.getAttribute('data-open'),'true','the actual explicit expansion survives final history rendering');
    assert.equal(settled.querySelector('.mp-chat-row-toggle').getAttribute('aria-expanded'),'true');
    handlers.get('click')({target:settled.querySelector('.mp-chat-row')});
    assert.equal(settled.getAttribute('data-open'),'false');
    assert.equal(settled.querySelector('.mp-chat-row-toggle').getAttribute('aria-expanded'),'false');
    const rebuilt=chat.toolRowNode(chat.toolRowModel('Read','{"path":"notes.txt"}',{text:final.result},'read-button'),'tool-button#0');
    assert.equal(rebuilt.querySelector('.mp-chat-disclosure').getAttribute('data-open'),'false');
    const other=chat.toolRowNode(chat.toolRowModel('Read','{"path":"other.txt"}',{text:'Other file'},'other-button'));
    assert.notEqual(other.querySelector('.mp-chat-body-wrap').getAttribute('id'),body.getAttribute('id'));
    const pendingModel=chat.toolRowModel('Read','',undefined,'waiting-button');
    const pending=chat.toolRowNode(pendingModel);
    assert.equal(Boolean(pending.querySelector('.mp-chat-row-toggle')),false,'a call without a body has no dead disclosure');
    const subagent=chat.toolRowNode(chat.toolRowModel('Agent','{"description":"Inspect"}',{text:'Result'},'subagent-button'));
    assert.equal(subagent.querySelector('.mp-chat-row-toggle'),null,'subagent navigation is not a disclosure');
    assert.equal(subagent.querySelector('.mp-chat-row').getAttribute('data-mp-chat-act'),'open-subagent');
  `,
    ],
    {cwd: process.cwd(), encoding: 'utf8', timeout: 10000},
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
