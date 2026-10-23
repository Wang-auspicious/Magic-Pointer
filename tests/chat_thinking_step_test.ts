import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const chat = require('../electron/renderer/chat_view');
function nodes(root: any, name: string): any[] {
  if (typeof root?.getAttribute !== 'function') return [];
  return [
    ...(root.getAttribute('class')?.split(' ').includes(name) ? [root] : []),
    ...root.children.flatMap((child: any) => nodes(child, name)),
  ];
}
function text(root: any): string {
  return typeof root === 'string' ? root : root.children.map(text).join('');
}

test('modern thinking uses the original Step label, default expansion and adjacent xs action toolbar', () => {
  chat.expansion.clear();
  for (const running of [true, false]) {
    const root = chat.thinkNode(
      'Read the original source.\nKeep the result.',
      running,
      `step-${running}`,
    );
    assert.equal(text(nodes(root, 'mp-chat-title')[0]), 'Thought process');
    assert.equal(root.getAttribute('data-open'), 'true');
    assert.equal(nodes(root, 'mp-chat-summary').length, 0);
    assert.equal(nodes(root, 'mp-chat-leading').length, 0);
    const toggle = nodes(root, 'mp-chat-think-toggle')[0];
    assert.equal(toggle.tagName.toLowerCase(), 'button');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.getAttribute('aria-label'), 'Thought process');
    const toolbar = nodes(root, 'mp-chat-think-actions')[0];
    assert.equal(toolbar.getAttribute('role'), 'toolbar');
    assert.equal(toolbar.getAttribute('aria-label'), 'Thinking actions');
    assert.equal(toolbar.getAttribute('data-size'), 'xs');
    assert.equal(nodes(toolbar, 'mp-chat-think-copy').length, 1);
  }
});

test('blank Step reasoning stays absent and an explicit closed state overrides the default', () => {
  chat.expansion.clear();
  assert.equal(chat.thinkNode(' \n\t', true).getAttribute('hidden'), 'true');
  chat.expansion.setRow('think:explicit-step', false);
  const closed = chat.thinkNode('Actual thought', false, 'explicit-step');
  assert.equal(closed.getAttribute('data-open'), 'false');
  assert.equal(
    nodes(closed, 'mp-chat-think-toggle')[0].getAttribute('aria-expanded'),
    'false',
  );
  assert.equal(
    chat
      .thinkNode('Different turn', false, 'other-step')
      .getAttribute('data-open'),
    'true',
  );
  chat.expansion.clear();
});

test('real delegated Step clicks preserve selection, update the native toggle, survive streaming and reopen history', () => {
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
    global.document={documentElement:{lang:'en',dataset:{}},getSelection:()=>selection,createElement:tag=>new TestNode(tag),createElementNS:(_ns,tag)=>new TestNode(tag),createTextNode:value=>new TestNode('',value)};
    const chat=require('./electron/renderer/chat_view');
    const host=new TestNode('div');
    host.addEventListener=(name,handler)=>handlers.set(name,handler);
    chat.bindDelegation(host);
    const live=chat.createLiveTurn(host,'step-live#0');
    live.update({thinking:'  '});
    const blank=host.querySelector('.mp-chat-think');
    assert.equal(blank.getAttribute('hidden'),'true');
    live.update({thinking:'First line'});
    const root=host.querySelector('.mp-chat-think'),body=host.querySelector('.mp-chat-think-body'),row=root.querySelector('.mp-chat-row'),toggle=root.querySelector('.mp-chat-think-toggle');
    assert.ok(toggle,'the actual live row needs a native disclosure button');
    assert.equal(root,blank,'the hidden placeholder survives the first actual reasoning chunk');
    assert.equal(root.getAttribute('hidden'),null);
    assert.equal(toggle.getAttribute('aria-controls'),root.querySelector('.mp-chat-think-viewport').getAttribute('id'));
    assert.equal(root.getAttribute('data-open'),'true');
    selection.isCollapsed=false;
    handlers.get('click')({target:row});
    assert.equal(root.getAttribute('data-open'),'true','selecting header text cannot close the Step');
    handlers.get('click')({target:toggle});
    assert.equal(root.getAttribute('data-open'),'false','the explicit button still toggles with a text selection');
    assert.equal(toggle.getAttribute('aria-expanded'),'false');
    selection.isCollapsed=true;
    live.update({thinking:'First line\\nSecond line',answer:'Done'});
    assert.equal(host.querySelector('.mp-chat-think-body'),body);
    assert.equal(root.getAttribute('data-open'),'false');
    assert.equal(root.querySelector('.mp-chat-title').textContent,'Thought process');
    assert.equal(root.querySelector('.mp-chat-summary'),null);
    assert.equal(toggle.getAttribute('aria-expanded'),'false');
    const id=root.getAttribute('data-row-id').slice('think:'.length);
    assert.equal(chat.thinkNode('Historical reasoning',false,id).getAttribute('data-open'),'false');
    handlers.get('click')({target:toggle});
    assert.equal(root.getAttribute('data-open'),'true');
    assert.equal(toggle.getAttribute('aria-expanded'),'true');
    assert.equal(chat.thinkNode('Historical reasoning',false,id).getAttribute('data-open'),'true');
    let prevented=false;
    handlers.get('keydown')({target:toggle,key:'Enter',repeat:false,preventDefault:()=>{prevented=true;}});
    assert.equal(prevented,false,'native button activation is left to the browser, without a second synthetic toggle');
    const traceHost=new TestNode('div');
    traceHost.addEventListener=(name,handler)=>handlers.set(name,handler);
    chat.bindDelegation(traceHost);
    const traceLive=chat.createLiveTurn(traceHost,'step-trace#0');
    const thought={kind:'message',turn:1,reasoning:'Inspect the source',state:'running'};
    traceLive.update({trajectory:[thought]});
    const traceRoot=traceHost.querySelector('.mp-chat-think');
    handlers.get('click')({target:traceRoot.querySelector('.mp-chat-think-toggle')});
    const tool={kind:'tool',turn:1,callId:'read-step',name:'Read',text:'{"path":"a.ts"}',result:'Actual file content',state:'done'};
    traceLive.update({trajectory:[{...thought,reasoning:'Inspect the source\\nThen read',state:'done'},tool]});
    assert.equal(traceHost.querySelector('.mp-chat-think').getAttribute('data-open'),'false','moving preceding thinking into a real tool group keeps the user choice');
    traceLive.finish({conversationId:'step-trace',turnIndex:0,answer:'Finished',trajectory:[{...thought,state:'done'},tool]});
    assert.equal(traceHost.querySelector('.mp-chat-think').getAttribute('data-open'),'false','final persisted trajectory rendering keeps the collapse');
    assert.equal(traceHost.querySelector('.mp-chat-think-toggle').getAttribute('aria-expanded'),'false');
  `,
    ],
    {cwd: process.cwd(), encoding: 'utf8', timeout: 10000},
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
