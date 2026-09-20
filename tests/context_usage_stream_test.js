'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const control = require('../electron/conversation_control');
const { parseProgressLine } = require('../electron/bridge_progress_lines');
const transcript = control.createTranscript();
control.appendTranscript(transcript, { phase: 'model_request', fields: { turn: '1' } });
const usage = { inputTokens: 90823, contextTokens: 42085, contextEstimated: 0, lastOutputTokens: 805 };
control.appendTranscript(transcript, { phase: 'model_usage', fields: { b64: Buffer.from(JSON.stringify(usage)).toString('base64') } });
assert.deepEqual(transcript.trajectory[0].modelUsage, usage);
const wire = parseProgressLine('@@mp phase=tool_call ms=2 b64=' + Buffer.from(JSON.stringify({ id: 'bash', name: 'Bash', args: '{"command":"dir /s *.md"}' })).toString('base64'));
assert.equal(wire.fields.args, '{"command":"dir /s *.md"}');
control.appendTranscript(transcript, wire);
assert.equal(transcript.trajectory[1].text, wire.fields.args);

const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const start = source.indexOf('function latestContextUsage(');
assert(start >= 0, 'the UI needs a last-request selector, not a turn-total alias');
const end = source.indexOf('function renderUsageMeter(', start);
const code = ts.transpileModule(source.slice(start, end) + '\nreturn { latestContextUsage };', { compilerOptions: { target: 'ES2022', module: 'None' } }).outputText;
const { latestContextUsage } = new Function(code)();
assert.equal(latestContextUsage([{ modelUsage: usage }]).contextTokens, 42085);
assert.equal(latestContextUsage([{ modelUsage: usage, trajectory: [
  { kind: 'message', modelUsage: { inputTokens: 90823, turnsReported: 6 } },
] }]).contextTokens, 42085, 'old trajectory totals must not mask a recovered request snapshot');
assert.equal(latestContextUsage([{ modelUsage: { inputTokens: 90823, turnsReported: 6 } }]), undefined,
  'legacy aggregate is unknown, never presented as context');
assert.equal(latestContextUsage([{ modelUsage: usage, liveProgress: { trajectory: [
  { kind: 'message', modelUsage: { contextTokens: 43000, contextEstimated: 1 } },
] } }]).contextTokens, 43000, 'streaming request estimate supersedes the saved receipt');
console.log('context usage transport and selection ok');
const compositionCode = ts.transpileModule(source.slice(source.indexOf('function contextCategoryRows('), source.indexOf('function latestContextUsage(')) + '\nreturn contextCategoryRows;', { compilerOptions: { target: 'ES2022', module: 'None' } }).outputText;
const composition = new Function(compositionCode)();
const segments = composition({ contextTokens: 1000, systemTokensEstimate: 100, toolSchemaTokensEstimate: 200,
  messageTokensEstimate: 100, toolResultTokensEstimate: 100, lastOutputTokens: 99 });
assert.deepEqual(segments.map(row => row.kind), ['system', 'tools', 'messages', 'results']);
assert.equal(segments.reduce((sum, row) => sum + row.value, 0), 1000,
  'component proportions scale to the measured input; generated output is not added');
