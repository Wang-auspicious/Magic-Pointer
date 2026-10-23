'use strict';

// A running tool label lights up; a settled one is plain text.
//
// The rule that matters: the shimmer must never recolour the label itself. It
// stacks a byte-identical copy of the glyphs and sweeps a band across that
// copy, so a running row reads as lit rather than repainted. That copy must
// carry the same string, and must not exist at all once the row settles.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class TestNode {
  constructor(tag = '', text = '') {
    this.tagName = tag.toUpperCase();
    this.nodeType = tag ? 1 : 3;
    this.childNodes = [];
    this.attrs = {};
    this.dataset = {};
    this.data = text;
    this.parentNode = null;
  }
  get children() {
    return this.childNodes.filter(n => n.nodeType === 1);
  }
  get textContent() {
    return this.nodeType === 3
      ? this.data
      : this.childNodes.map(n => n.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [new TestNode('', String(value))];
  }
  get className() {
    return this.attrs.class || '';
  }
  set className(value) {
    this.setAttribute('class', value);
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
  }
  getAttribute(key) {
    return this.attrs[key] ?? null;
  }
  removeAttribute(key) {
    delete this.attrs[key];
  }
  appendChild(node) {
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }
  insertBefore(node, before) {
    const index = before
      ? this.childNodes.indexOf(before)
      : this.childNodes.length;
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceChildren(...nodes) {
    this.childNodes = [];
    nodes.forEach(n => this.appendChild(n));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const matches = node =>
      selector.startsWith('.')
        ? node.className.split(' ').includes(selector.slice(1))
        : selector.startsWith('[')
          ? node.getAttribute(selector.slice(1, -1)) !== null
          : node.tagName.toLowerCase() === selector;
    const found = [];
    for (const child of this.children) {
      if (matches(child)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  addEventListener() {}
}

global.document = {
  documentElement: {lang: 'en', dataset: {}},
  createElement: tag => new TestNode(tag),
  createElementNS: (_ns, tag) => new TestNode(tag),
  createTextNode: text => new TestNode('', text),
};

const ChatView = require('../electron/renderer/chat_view');
ChatView.expansion.clear();

function render(call, settle) {
  const host = new TestNode('div');
  const live = ChatView.createLiveTurn(host);
  live.update({records: [call]});
  if (settle) {
    live.update({
      records: [{phase: 'tool_result', fields: {...call.fields, ...settle}}],
    });
  }
  return host.querySelector('.mp-chat-tool');
}

const running = {
  phase: 'tool_call',
  fields: {id: 's1', name: 'Read', args: '{"path":"notes.txt"}'},
};

const inflight = render(running);
const inflightLabel = inflight.querySelector('.mp-chat-summary');
assert.ok(inflightLabel, 'a running tool still shows its summary');
assert.equal(
  inflightLabel.getAttribute('data-shimmering'),
  'true',
  'an in-flight label must be marked shimmering so the clone is painted',
);

const clone = inflightLabel.querySelector('.mp-shimmer-clone');
assert.ok(clone, 'a shimmering label carries a clone of its glyphs');
assert.equal(
  clone.getAttribute('aria-hidden'),
  'true',
  'the clone is decorative and must be hidden from assistive tech',
);
assert.equal(
  clone.textContent,
  'notes.txt',
  'the clone must repeat the label verbatim, otherwise the sweep lights the wrong glyphs',
);

const settled = render(running, {state: 'ok', result: 'contents'});
const settledLabel = settled.querySelector('.mp-chat-summary');
assert.ok(settledLabel, 'a settled tool still shows its summary');
assert.equal(
  settledLabel.getAttribute('data-shimmering'),
  'false',
  'a settled label must stop shimmering',
);
assert.equal(
  settledLabel.querySelector('.mp-shimmer-clone'),
  null,
  'a settled label must carry no clone, so the effect costs nothing when idle',
);

const failed = render(running, {state: 'error', result: 'boom'});
assert.equal(
  failed.querySelector('.mp-chat-summary').getAttribute('data-shimmering'),
  'false',
  'a failed call is not in flight and must not shimmer',
);

// A group header that is still running shimmers too, so the whole run reads as
// live rather than only the individual row inside it.
const groupHost = new TestNode('div');
const groupLive = ChatView.createLiveTurn(groupHost);
groupLive.update({
  trajectory: [
    {
      kind: 'tool',
      callId: 'g1',
      name: 'read',
      text: '{"path":"a.txt"}',
      state: 'running',
    },
    {
      kind: 'tool',
      callId: 'g2',
      name: 'read',
      text: '{"path":"b.txt"}',
      state: 'running',
    },
  ],
});
const groupTitle = groupHost.querySelector('.mp-chat-tool-group-title');
assert.ok(groupTitle, 'a multi-tool run renders one group card');
assert.equal(
  groupTitle.querySelector('.mp-shimmer').getAttribute('data-shimmering'),
  'true',
  'a running group header must shimmer',
);
assert.equal(
  groupTitle.querySelector('.mp-shimmer-clone').getAttribute('aria-hidden'),
  'true',
  'the group clone is decorative too',
);
assert.equal(
  groupTitle.querySelector('.mp-shimmer-clone').textContent,
  'Reading a.txt',
  'the group clones the current active tool label while busy',
);

// The effect is CSS-only, so the shipped stylesheet is part of the contract.
const css = fs.readFileSync(
  path.join(__dirname, '..', 'electron', 'renderer', 'chat_styles.css'),
  'utf8',
);
assert.match(
  css,
  /@keyframes mp-shimmer-band/,
  'the sweep keyframes must ship',
);
assert.match(
  css,
  /-webkit-mask-clip:\s*text/,
  'the band must be clipped to the glyphs; without it the whole box glows',
);
assert.match(
  css,
  /120deg/,
  'the reference sweeps on a 120deg diagonal, not horizontally',
);
assert.match(
  css,
  /animation:\s*mp-shimmer-band 3s linear infinite/,
  'the reference cycle is 3s linear, so the sweep never eases mid-flight',
);
assert.match(
  css,
  /prefers-reduced-motion[\s\S]*?\.mp-shimmer-clone\s*\{\s*display:\s*none/,
  'reduced motion must drop the clone entirely',
);

const theme = fs.readFileSync(
  path.join(__dirname, '..', 'electron', 'renderer', 'theme_tokens.css'),
  'utf8',
);
assert.equal(
  (theme.match(/--mp-shimmer-peak:/g) || []).length,
  2,
  'the band peak needs a light and a dark value',
);
assert.equal(
  (theme.match(/--mp-git-added:/g) || []).length,
  2,
  'diff counts need a light and a dark value',
);
assert.match(
  css,
  /\.mp-chat-diff-del\s*\{\s*color:\s*var\(--mp-git-removed\)/,
  'the removed count must use the token, not a hard-coded hex',
);

console.log('chat shimmer contract ok');
