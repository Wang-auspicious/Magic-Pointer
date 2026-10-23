import assert from 'node:assert/strict';
import { RuntimeActivitySink } from '../electron/runtime/agent_activity';

const before = Date.now();
const progress: Array<Record<string, any>> = [];
const phases: Array<{phase: string; fields: Record<string, any>}> = [];
const sink = new RuntimeActivitySink((phase, fields) => {
  progress.push(fields);
  phases.push({phase, fields});
});
sink.onEvent({ kind: 'turn_started', turn: 1 });
sink.onEvent({ kind: 'tool_call_started', id: 'read-one', name: 'Read', arguments: { path: 'note.txt' } });
sink.onEvent({ kind: 'tool_progress', id: 'read-one', name: 'Read', text: 'half\n' });
sink.onEvent({ kind: 'tool_call_finished', result: { tool_call_id: 'read-one', tool_name: 'Read', value: 'hello', latency_ms: 12 } });
const after = Date.now();
const origins = sink.trajectory.map(row => row.timeOriginMs);
assert.ok(origins.every(origin => typeof origin === 'number' && origin >= before && origin <= after),
  'persisted events need a wall-clock origin so later runs can share one session timeline');
assert.equal(new Set(origins).size, 1, 'all events from one run keep the same clock origin');
assert.ok(progress.every(row => row.timeOriginMs === origins[0]),
  'live progress and durable trajectory must use the same time origin');
assert.ok(sink.trajectory.every(row => Number(row.timeOriginMs) + Number(row.startedAt) >= before));
const streamed = phases.filter(row => row.phase === 'tool_progress');
assert.equal(streamed.length, 1, 'tool progress must stream as one phase record per fragment');
assert.equal(
  Buffer.from(String(streamed[0].fields.b64), 'base64').toString('utf8'),
  JSON.stringify({ id: 'read-one', name: 'Read', text: 'half\n' }),
);
console.log('runtime activity wall-clock projection passed');
