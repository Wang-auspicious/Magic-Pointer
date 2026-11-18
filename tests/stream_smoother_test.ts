import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const smootherSrcPath = path.resolve('electron/renderer/stream_smoother.ts');

function loadSmoother() {
  return require('../electron/renderer/stream_smoother');
}

test('stream_smoother compiles cleanly as a classic browser-global IIFE with zero module syntax', () => {
  assert.ok(fs.existsSync(smootherSrcPath), 'electron/renderer/stream_smoother.ts must exist');
  const source = fs.readFileSync(smootherSrcPath, 'utf8');
  assert.ok(!/^\s*(import|export)\b/m.test(source), 'stream_smoother.ts must not have top-level import/export');

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.Preserve,
    },
    reportDiagnostics: true,
  });
  assert.equal(transpiled.diagnostics?.length ?? 0, 0, 'stream_smoother.ts must transpile cleanly');
  assert.ok(
    !/^\s*export\b|\bObject\.defineProperty\(\s*exports\b/m.test(transpiled.outputText),
    'transpiled output must stay a plain browser-global script',
  );

  const sandbox: Record<string, unknown> = {globalThis: {}};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transpiled.outputText, sandbox, {filename: 'stream_smoother.js'});
  assert.ok(sandbox.StreamSmoother, 'browser-global execution must define globalThis.StreamSmoother');
});

test('createTextSmoother releases chunks adaptively on word boundaries and never splits UTF-16 surrogates', () => {
  const StreamSmoother = loadSmoother();
  const smoother = StreamSmoother.createTextSmoother();
  const shortText = 'Hello streaming world from Magic Pointer';
  smoother.push(shortText, 0);

  let steps = 0;
  let sawPartial = false;
  let lastEmitted = '';
  for (let t = 16; t <= 1500; t += 16) {
    const state = smoother.step(t);
    steps += 1;
    assert.ok(shortText.startsWith(state.emitted), 'emitted text must remain a strict prefix of target');
    assert.ok(state.emitted.length >= lastEmitted.length, 'emitted length must be monotonic');
    if (state.emitted.length > 0 && state.emitted.length < shortText.length) {
      sawPartial = true;
    }
    lastEmitted = state.emitted;
    if (state.done) {
      break;
    }
  }
  assert.ok(sawPartial, 'adaptive smoother should release progressively across frames rather than dumping in 1 tick');
  assert.equal(lastEmitted, shortText);
  assert.ok(steps < 80, 'short text should settle well within ~1.3s');

  // Larger backlog drains faster per millisecond than tiny backlog.
  const fast = StreamSmoother.createTextSmoother();
  const bigText = Array.from({length: 40}, (_, i) => `token_${i}`).join(' ');
  fast.push(bigText, 0);
  const bigStep = fast.step(32);
  const slow = StreamSmoother.createTextSmoother();
  slow.push(shortText, 0);
  const smallStep = slow.step(32);
  assert.ok(bigStep.emitted.length > smallStep.emitted.length, 'larger pending backlog must accelerate release velocity');

  // Surrogate pair safety (emoji + CJK)
  const emojiSmoother = StreamSmoother.createTextSmoother();
  const emojiText = '你好👋世界 🚀 测试🎉完成';
  emojiSmoother.push(emojiText, 0);
  for (let t = 16; t <= 500; t += 16) {
    const res = emojiSmoother.step(t);
    assert.ok(!/[\uD800-\uDBFF]$/.test(res.emitted), 'must not slice through a UTF-16 surrogate pair');
    if (res.done) {
      break;
    }
  }
  assert.equal(emojiSmoother.flush().emitted, emojiText);
});

test('createTextSmoother pauses emission during active selection and catches up cleanly on resume/flush', () => {
  const StreamSmoother = loadSmoother();
  const smoother = StreamSmoother.createTextSmoother();
  const initial = 'First paragraph of streamed content ';
  const appended = initial + 'followed by new streaming tokens while user selects text.';
  smoother.push(initial, 0);

  const first = smoother.step(24);
  assert.ok(first.emitted.length > 0 && first.emitted.length < initial.length);
  const heldAtPause = first.emitted;

  smoother.setPaused(true, 30);
  smoother.push(appended, 40);
  const p1 = smoother.step(64);
  const p2 = smoother.step(120);
  assert.equal(p1.paused, true);
  assert.equal(p1.delta, '');
  assert.equal(p1.emitted, heldAtPause, 'emission must freeze while selection pause is active');
  assert.equal(p2.delta, '');
  assert.equal(p2.emitted, heldAtPause);
  assert.equal(p2.pending, appended.length - heldAtPause.length);

  smoother.setPaused(false, 130);
  const resumed = smoother.step(150);
  assert.equal(resumed.paused, false);
  assert.ok(resumed.delta.length > 0, 'emission must resume immediately on setPaused(false)');
  assert.ok(resumed.emitted.startsWith(heldAtPause));

  const finished = smoother.flush();
  assert.equal(finished.emitted, appended);
  assert.equal(finished.pending, 0);
  assert.equal(finished.done, true);

  // Explicit flush while paused still drains everything cleanly (e.g. turn finished under selection).
  const pauseFlush = StreamSmoother.createTextSmoother();
  pauseFlush.push('Alpha beta gamma', 0);
  pauseFlush.step(20);
  pauseFlush.setPaused(true, 25);
  pauseFlush.push('Alpha beta gamma delta', 30);
  assert.equal(pauseFlush.step(50).delta, '');
  assert.equal(pauseFlush.flush().emitted, 'Alpha beta gamma delta');
});

test('TokenCountSmoother enforces oSt=5000ms live gate, 1200ms first ramp, [300..3000]ms clamp, and monotone rounding', () => {
  const StreamSmoother = loadSmoother();
  assert.equal(StreamSmoother.TOKEN_GATE_MS, 5000);

  const counter = new StreamSmoother.TokenCountSmoother();
  counter.setTarget(1200, 0);

  // Gated while running < 5000ms
  assert.equal(counter.getVisible(0, true, 0), null);
  assert.equal(counter.getVisible(2500, true, 600), null);
  assert.equal(counter.getVisible(4999, true, 1200), null);

  // First interpolation uses 1200ms duration and is strictly monotone integer Math.round
  const firstRamp = new StreamSmoother.TokenCountSmoother();
  firstRamp.setTarget(1000, 100);
  let prev = 0;
  for (let t = 100; t <= 1300; t += 100) {
    const val = firstRamp.step(t);
    assert.equal(val, Math.round(val), 'interpolated token count must be an integer');
    assert.ok(val >= prev, `token count must be monotonic (${val} >= ${prev})`);
    if (t < 1300) {
      assert.ok(val < 1000, `first interpolation (1200ms) must not hit target early at t=${t}`);
    }
    prev = val;
  }
  assert.equal(firstRamp.step(1300), 1000, 'first interpolation completes at 1200ms');

  // Gate opens at elapsedMs >= 5000 while running, or immediately on stop (!isRunning)
  const gated = new StreamSmoother.TokenCountSmoother();
  gated.setTarget(1200, 0);
  assert.equal(gated.getVisible(4999, true, 1200), null);
  assert.equal(gated.getVisible(5000, true, 1200), 1200);

  const stoppedEarly = new StreamSmoother.TokenCountSmoother();
  stoppedEarly.setTarget(950, 0);
  assert.equal(stoppedEarly.getVisible(1200, false, 100), 950, 'settled turn must reveal final tokens immediately');

  // Minimum clamp 300ms for rapid updates
  const rapid = new StreamSmoother.TokenCountSmoother();
  rapid.setTarget(100, 0);
  rapid.flush();
  rapid.setTarget(400, 20); // dt = 20ms -> clamped up to >= 300ms
  assert.ok(rapid.step(200) < 400, 'rapid cadence must still ramp for at least 300ms');
  assert.equal(rapid.step(340), 400, 'clamped 300ms ramp finishes after 300ms');

  // Maximum clamp 3000ms for slow updates
  const slow = new StreamSmoother.TokenCountSmoother();
  slow.setTarget(100, 0);
  slow.flush();
  slow.setTarget(1000, 20000); // dt = 20000ms -> clamped down to <= 3000ms
  assert.ok(slow.step(21000) < 1000, 'slow ramp is still in progress at 1000ms');
  assert.equal(slow.step(23000), 1000, 'slow cadence ramp is capped at 3000ms');
});

test('formatThinkingLabel and formatElapsedTime match Claude Desktop 4.23118 thresholds', () => {
  const StreamSmoother = loadSmoother();

  assert.equal(StreamSmoother.formatThinkingLabel(0), 'Thinking…');
  assert.equal(StreamSmoother.formatThinkingLabel(14_999), 'Thinking…');
  assert.equal(StreamSmoother.formatThinkingLabel(15_000), 'Still thinking…');
  assert.equal(StreamSmoother.formatThinkingLabel(29_999), 'Still thinking…');
  assert.equal(StreamSmoother.formatThinkingLabel(30_000), 'Thinking more…');
  assert.equal(StreamSmoother.formatThinkingLabel(44_999), 'Thinking more…');
  assert.equal(StreamSmoother.formatThinkingLabel(45_000), 'Thinking some more…');
  assert.equal(StreamSmoother.formatThinkingLabel(59_999), 'Thinking some more…');
  assert.equal(StreamSmoother.formatThinkingLabel(60_000), 'Almost done thinking…');
  assert.equal(StreamSmoother.formatThinkingLabel(180_000), 'Almost done thinking…');

  assert.equal(StreamSmoother.formatElapsedTime(-100), '');
  assert.equal(StreamSmoother.formatElapsedTime(0), '');
  assert.equal(StreamSmoother.formatElapsedTime(1999), '');
  assert.equal(StreamSmoother.formatElapsedTime(2000), '2s');
  assert.equal(StreamSmoother.formatElapsedTime(12_900), '12s');
  assert.equal(StreamSmoother.formatElapsedTime(59_999), '59s');
  assert.equal(StreamSmoother.formatElapsedTime(60_000), '1m 00s');
  assert.equal(StreamSmoother.formatElapsedTime(65_000), '1m 05s');
  assert.equal(StreamSmoother.formatElapsedTime(779_000), '12m 59s');
});

test('createStageDebouncer enforces 150ms show debounce and 650ms minimum hold', () => {
  const StreamSmoother = loadSmoother();
  const stage = StreamSmoother.createStageDebouncer({debounceMs: 150, minHoldMs: 650});

  assert.equal(stage.update('Thinking…', 0), 'Thinking…');
  // Flicker under 150ms must not switch the label
  assert.equal(stage.update('Running Bash…', 100), 'Thinking…');
  assert.equal(stage.update('Thinking…', 200), 'Thinking…');

  // Stable candidate waits 150ms debounce + minHoldMs (650ms since initial label shown at t=0)
  stage.update('Using Read…', 300);
  assert.equal(stage.step(400), 'Thinking…', 'must respect 150ms debounce before 450ms');
  assert.equal(stage.step(500), 'Thinking…', 'must respect 650ms minHold from t=0');
  assert.equal(stage.step(650), 'Using Read…', 'switches once both 150ms debounce and 650ms hold elapsed');
});

test('createLiveTurn.tickStatus advances elapsedMs and opens 5000ms token gate even when snapshot carries elapsedMs', () => {
  class MiniNode {
    tagName: string;
    nodeType: number;
    childNodes: MiniNode[] = [];
    attrs: Record<string, string> = {};
    dataset: Record<string, string> = {};
    nodeValue: string;
    parentNode: MiniNode | null = null;
    constructor(tag = '', text = '') {
      this.tagName = tag.toUpperCase();
      this.nodeType = tag ? 1 : 3;
      this.nodeValue = text;
    }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get textContent(): string {
      return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(n => n.textContent).join('');
    }
    set textContent(v: string) { this.replaceChildren(new MiniNode('', String(v))); }
    get className() { return this.attrs.class || ''; }
    set className(v: string) { this.setAttribute('class', v); }
    setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
    getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k: string) { delete this.attrs[k]; }
    hasAttribute(k: string) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    appendChild(n: MiniNode) { return this.insertBefore(n, null); }
    insertBefore(n: MiniNode, before: MiniNode | null) {
      if (n.parentNode) n.remove();
      const idx = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(idx < 0 ? this.childNodes.length : idx, 0, n);
      n.parentNode = this;
      return n;
    }
    remove() {
      if (!this.parentNode) return;
      const arr = this.parentNode.childNodes;
      const idx = arr.indexOf(this);
      if (idx >= 0) arr.splice(idx, 1);
      this.parentNode = null;
    }
    replaceChildren(...nodes: MiniNode[]) {
      this.childNodes.slice().forEach(n => n.remove());
      for (const n of nodes) this.appendChild(n);
    }
    querySelectorAll(selector: string): MiniNode[] {
      const sels = selector.split(',').map(s => s.trim()).filter(Boolean);
      const hit = (node: MiniNode, sel: string): boolean => {
        if (sel.startsWith('.')) return node.className.split(/\s+/).includes(sel.slice(1));
        if (sel.startsWith('[')) {
          const inner = sel.slice(1, -1);
          return node.hasAttribute(inner);
        }
        return node.tagName.toLowerCase() === sel.toLowerCase();
      };
      const out: MiniNode[] = [];
      for (const c of this.children) {
        if (sels.some(s => hit(c, s))) out.push(c);
        out.push(...c.querySelectorAll(selector));
      }
      return out;
    }
    querySelector(selector: string): MiniNode | null { return this.querySelectorAll(selector)[0] || null; }
  }

  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevHtml = g.HTMLElement;
  const cvPath = require.resolve('../electron/renderer/chat_view');
  const cmPath = require.resolve('../electron/renderer/chat_markdown');
  const prevCv = require.cache[cvPath];
  const prevCm = require.cache[cmPath];

  g.HTMLElement = MiniNode;
  g.document = {
    documentElement: {lang: 'en', dataset: {}, getAttribute: () => null},
    createElement: (tag: string) => new MiniNode(tag),
    createElementNS: (_ns: string, tag: string) => new MiniNode(tag),
    createTextNode: (t: string) => new MiniNode('', t),
  };
  delete require.cache[cmPath];
  delete require.cache[cvPath];
  const ChatView = require('../electron/renderer/chat_view');

  try {
    const t0 = 1_000_000;
    const host = new MiniNode('div');
    const live = ChatView.createLiveTurn(host, 'elapsed-pin#0');
    live.update({
      startedAt: t0,
      elapsedMs: 33,
      tokens: 412,
      thinking: 'Inspecting files...',
      answer: 'Draft reply...',
    });
    assert.equal(host.querySelector('.mp-chat-turn-status-meta')?.textContent, '');

    live.tickStatus(t0 + 18_000);
    assert.equal(
      host.querySelector('.mp-chat-turn-status-meta')?.textContent,
      '18s · 412 tokens',
      'tickStatus must advance elapsed time to 18s and open 5000ms token gate despite initial elapsedMs: 33',
    );

    const host2 = new MiniNode('div');
    const live2 = ChatView.createLiveTurn(host2, 'elapsed-base#0');
    live2.update({
      elapsedMs: 33,
      tokens: 412,
      thinking: 'Thinking deeply...',
      nowMs: 1033,
    });
    live2.tickStatus(19_000);
    assert.equal(host2.querySelector('.mp-chat-turn-status-label')?.textContent, 'Still thinking…');
    assert.equal(
      host2.querySelector('.mp-chat-turn-status-meta')?.textContent,
      '18s · 412 tokens',
      'without explicit startedAt, tickStatus advances from snapshotUpdatedAt + base elapsed',
    );
  } finally {
    g.document = prevDoc;
    g.HTMLElement = prevHtml;
    if (prevCm) require.cache[cmPath] = prevCm;
    else delete require.cache[cmPath];
    if (prevCv) require.cache[cvPath] = prevCv;
    else delete require.cache[cvPath];
  }
});
