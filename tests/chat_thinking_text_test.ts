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

test('Step plain text follows the original line normalization and trims only surrounding blank lines', () => {
  const cases = [
    ['\r\n  first\r\n\tsecond\r\n \t\r\n', '  first\n\tsecond'],
    ['a\t\tb\n\nc\n', 'a\t\tb\n\nc'],
    [' leading and trailing spaces ', ' leading and trailing spaces '],
    ['first\u2028second\u2029third', 'first second third'],
    ['\n```\n\tconst x\t= 1;\n```\n', '```\n\tconst x\t= 1;\n```'],
  ];
  for (const [raw, displayed] of cases) {
    assert.equal(
      text(nodes(chat.thinkNode(raw, false), 'mp-chat-think-body')[0]),
      displayed,
    );
  }
});

test('actual live display normalization preserves complete original quote copy, including raw-only updates and history', () => {
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
    (async()=>{
      const assert=require('node:assert/strict');
      ${fixture}
      const events=new Map(),copied=[],timers=[];
      TestNode.prototype.closest=function(selector){for(let node=this;node;node=node.parentNode){if(selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):selector.startsWith('[')?node.getAttribute(selector.slice(1,-1))!==null:false)return node;}return null;};
      global.HTMLElement=TestNode;
      global.document={documentElement:{lang:'en',dataset:{}},createElement:tag=>new TestNode(tag),createElementNS:(_ns,tag)=>new TestNode(tag),createTextNode:value=>new TestNode('',value)};
      Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>{copied.push(value);}}}});
      global.window={addEventListener(){},setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout(){}};
      const chat=require('./electron/renderer/chat_view');
      const host=new TestNode('div');host.addEventListener=(name,fn)=>events.set(name,fn);chat.bindDelegation(host);
      const live=chat.createLiveTurn(host,'normalized-thinking#0');
      live.update({thinking:'\\n alpha\\r'});
      const body=host.querySelector('.mp-chat-think-body');
      assert.equal(body.textContent,' alpha');
      let raw='\\n alpha\\r\\n\\tbeta\\r\\n\\n';
      live.update({thinking:raw});
      assert.equal(host.querySelector('.mp-chat-think-body'),body);
      assert.equal(body.textContent,' alpha\\n\\tbeta');
      events.get('click')({target:host.querySelector('.mp-chat-think-copy')});
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(copied.at(-1),chat.__test.thinkingQuote(raw).trim(),'copy is based on source text, never reconstructed from the normalized DOM');
      raw+='\\n'.repeat(8);
      live.update({thinking:raw});
      assert.equal(body.textContent,' alpha\\n\\tbeta');
      events.get('click')({target:host.querySelector('.mp-chat-think-copy')});
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(copied.at(-1),chat.__test.thinkingQuote(raw).trim(),'a source-only update still refreshes copied text');
      const structure=host.structuralChanges;
      for(let i=0;i<40;i++){raw+='x';live.update({thinking:raw});}
      assert.equal(host.structuralChanges,structure,'normalization never detaches the thinking root');
      assert.ok(body.childNodes.length<=32,'normalization preserves the existing bounded text-fragment budget');
      live.finish({conversationId:'normalized-thinking',turnIndex:0,thinking:raw,answer:'Done'});
      assert.equal(host.querySelector('.mp-chat-think-body').textContent,' alpha\\n\\tbeta'+'\\n'.repeat(10)+'x'.repeat(40));
      events.get('click')({target:host.querySelector('.mp-chat-think-copy')});
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(copied.at(-1),chat.__test.thinkingQuote(raw).trim(),'settled history preserves the same original quote');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `,
    ],
    {cwd: process.cwd(), encoding: 'utf8', timeout: 10000},
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
