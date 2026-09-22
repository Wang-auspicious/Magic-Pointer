const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-bench-'));
const storePath = path.join(tmp, 'conversations.json');
const logDir = path.join(tmp, 'runtime');
const logPath = path.join(logDir, 'electron.log');

function makeTurn(i) {
  return {
    id: `t${i}`,
    question: 'q'.repeat(200),
    answer: 'a'.repeat(4000),
    outcome: 'high',
    at: Date.now(),
    startedAt: Date.now(),
    completedAt: Date.now(),
    events: Array.from({ length: 8 }, (_u, k) => ({ type: 'tool_call', detail: 'd'.repeat(240), index: k })),
    activities: Array.from({ length: 6 }, (_u, k) => ({ label: 'step'.repeat(20), note: 'n'.repeat(120), k })),
    trajectory: Array.from({ length: 30 }, (_u, k) => ({ step: k, note: 'n'.repeat(80) })),
    receipts: Array.from({ length: 4 }, (_u, k) => ({ id: `r${k}`, detail: 'x'.repeat(200) })),
    evidence: { capturePath: 'C:/x/y.png'.repeat(4), annotatedPath: 'C:/x/y.png'.repeat(4), label: 'l'.repeat(80), contentDigest: 'c'.repeat(1600) },
  };
}

function measure(label, iterations, fn) {
  fn(); fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i += 1) fn();
  const t1 = performance.now();
  const perCallMs = (t1 - t0) / iterations;
  console.log(`${label.padEnd(62)} n=${String(iterations).padStart(4)}  per_call=${perCallMs.toFixed(2).padStart(8)}ms`);
  return perCallMs;
}

function storeOf(conversations, turnsEach) {
  return Array.from({ length: conversations }, (_u, c) => ({
    id: `c${c}`,
    title: `conversation ${c}`,
    updatedAt: Date.now(),
    turns: Array.from({ length: turnsEach }, (_v, i) => makeTurn(`${c}-${i}`)),
  }));
}

console.log('=== conversation_store.persist() — runs on EVERY updateTurn (300ms live flush) ===');
for (const [convs, turns] of [[5, 6], [20, 12], [50, 20]]) {
  const items = storeOf(convs, turns);
  const json = JSON.stringify(items);
  console.log(`  store: ${convs} conversations x ${turns} turns = ${(json.length / 1024 / 1024).toFixed(2)} MB of JSON`);
  measure(`    JSON.stringify (no indent) ${convs}x${turns}`, 20, () => JSON.stringify(items));
  measure(`    writeFileSync of that payload`, 20, () => fs.writeFileSync(storePath, json, 'utf8'));
  measure(`    persist() end-to-end (stringify+write+rename)`, 20, () => {
    const data = JSON.stringify(items);
    fs.writeFileSync(`${storePath}.tmp`, data, 'utf8');
    fs.renameSync(`${storePath}.tmp`, storePath);
  });
}

console.log('\n=== main.ts log() — mkdirSync + appendFileSync, ~150 call sites ===');
measure('log() one line (mkdirSync + appendFileSync)', 200, () => {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()} bridge phase script=scripts/selection_bridge.py phase=answer_chunk ms=12\n`, 'utf8');
});
measure('appendFileSync only (dir already exists)', 200, () => {
  fs.appendFileSync(logPath, `${new Date().toISOString()} x\n`, 'utf8');
});

console.log('\n=== observability.writeEvent() — statSync + appendFileSync per event ===');
const eventsPath = path.join(tmp, 'events.jsonl');
fs.writeFileSync(eventsPath, 'x'.repeat(1024 * 512), 'utf8');
measure('writeEvent (statSync + appendFileSync)', 200, () => {
  fs.statSync(eventsPath).size;
  fs.appendFileSync(eventsPath, '{"ts":"now","type":"x"}\n', 'utf8');
});

console.log('\n=== transcriptStore read path: conversations list re-read ===');
{
  const items = storeOf(20, 12);
  fs.writeFileSync(storePath, JSON.stringify(items), 'utf8');
  measure('readFileSync + JSON.parse of the store (cold load)', 10, () => {
    JSON.parse(fs.readFileSync(storePath, 'utf8'));
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\ndone (temp dir removed)');
