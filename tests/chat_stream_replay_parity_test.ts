import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const {RuntimeActivitySink} = require('../electron/runtime/agent_activity') as typeof import('../electron/runtime/agent_activity');
const ChatView = require('../electron/renderer/chat_view');

const ROOT = path.resolve(__dirname, '..');

test('failed tool_call_finished without arguments preserves started command and URL', () => {
  const blobs: Array<{phase: string; decoded: Record<string, unknown>}> = [];
  const sink = new RuntimeActivitySink((phase, fields) => {
    if (phase === 'tool_result' && typeof fields.b64 === 'string') {
      blobs.push({
        phase,
        decoded: JSON.parse(
          Buffer.from(fields.b64, 'base64').toString('utf8'),
        ) as Record<string, unknown>,
      });
    }
  });

  sink.onEvent({
    kind: 'turn_started',
    turn: 1,
    sessionId: 'sess-1',
    time: Date.now(),
  } as unknown as Parameters<typeof sink.onEvent>[0]);

  const cmdArgs = JSON.stringify({
    command: 'node -e "console.error(\'probe-fail\'); process.exit(2)"',
  });
  sink.onEvent({
    kind: 'tool_call_started',
    id: 'call-bash-fail',
    name: 'Bash',
    arguments: cmdArgs,
  } as unknown as Parameters<typeof sink.onEvent>[0]);

  sink.onEvent({
    kind: 'tool_call_finished',
    result: {
      tool_call_id: 'call-bash-fail',
      tool_name: 'Bash',
      is_error: true,
      value: JSON.stringify({error: 'Command failed with exit code 2'}),
      latency_ms: 42,
    },
  } as unknown as Parameters<typeof sink.onEvent>[0]);

  const fetchArgs = JSON.stringify({url: 'http://127.0.0.1:59999/not-found'});
  sink.onEvent({
    kind: 'tool_call_started',
    id: 'call-fetch-fail',
    name: 'Fetch',
    arguments: fetchArgs,
  } as unknown as Parameters<typeof sink.onEvent>[0]);

  sink.onEvent({
    kind: 'tool_call_finished',
    result: {
      tool_call_id: 'call-fetch-fail',
      tool_name: 'Fetch',
      is_error: true,
      value: JSON.stringify({error: 'fetch failed'}),
      latency_ms: 19,
    },
  } as unknown as Parameters<typeof sink.onEvent>[0]);

  const bashTool = sink.trajectory.find(
    row => row.kind === 'tool' && row.callId === 'call-bash-fail',
  );
  const fetchTool = sink.trajectory.find(
    row => row.kind === 'tool' && row.callId === 'call-fetch-fail',
  );
  assert.equal(
    bashTool?.text,
    cmdArgs,
    'failed Bash trajectory record must keep original command arguments',
  );
  assert.equal(
    fetchTool?.text,
    fetchArgs,
    'failed Fetch trajectory record must keep original url arguments',
  );
  assert.equal(
    blobs[0]?.decoded.args,
    cmdArgs,
    'tool_result progress event must retain started args when result.arguments is omitted',
  );
});

test('Fetch failure uses Failed to fetch <url> errorTitle instead of Read Fetch', () => {
  const model = ChatView.toolRowModel(
    'Fetch',
    JSON.stringify({url: 'http://127.0.0.1:59999/not-found'}),
    {text: 'fetch failed', isError: true},
  );
  assert.equal(model.state, 'error');
  assert.equal(model.errorTitle, true);
  assert.equal(model.title, 'Failed to fetch');
  assert.equal(model.summary, 'http://127.0.0.1:59999/not-found');
});

test('tool group title aligns verb and summary on baseline without drop', () => {
  const css = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'chat_styles.css'),
    'utf8',
  );
  assert.match(
    css,
    /\.mp-chat-tool-group-title[^{]*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*baseline/s,
    '.mp-chat-tool-group-title must align verb and target on a single typographic baseline',
  );
});

test('studio sendFromComposer binds ChatView delegation before turn settles', () => {
  const studioSource = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'studio.ts'),
    'utf8',
  );
  const start = studioSource.indexOf('pendingConversation = {');
  assert.ok(start > 0, 'pendingConversation creation site must exist');
  const slice = studioSource.slice(Math.max(0, start - 900), start + 900);
  assert.match(
    slice,
    /ChatView\.bindDelegation\(/,
    'new live turn must ensure ChatView.bindDelegation is attached before settling',
  );
});

test('live manual tool/think expansion survives turnPrefix change to settled turn', () => {
  ChatView.expansion.clear();
  // Simulate live click on unscoped single-tool group & think row during turn 1
  ChatView.expansion.setGroup('group:call-read-1', true);
  ChatView.expansion.setRow('tool:call-read-1', true);
  ChatView.expansion.setRow('think:r1', true);

  const settled = ChatView.assistantTurnNode(
    {
      answer: 'Done.',
      trajectory: [
        {kind: 'message', turn: 1, text: '', reasoning: 'Checked file first.'},
        {
          kind: 'tool',
          turn: 1,
          callId: 'call-read-1',
          name: 'Read',
          state: 'done',
          text: JSON.stringify({path: 'package.json'}),
          result: '{"name":"magic-pointer"}',
        },
        {kind: 'message', turn: 2, text: 'Done.'},
      ],
    },
    'conv-live-to-settled#0',
  )
    .map((node: {outerHTML: string}) => node.outerHTML)
    .join('');

  assert.match(
    settled,
    /<details class="mp-chat-tool-group"[^>]*open=/,
    'manually expanded live single-tool group must stay open after settling with scoped turnPrefix',
  );
  assert.match(
    settled,
    /class="mp-chat-disclosure mp-chat-think"[^>]*data-open="true"/,
    'manually expanded live thinking row must stay open after settling with scoped turnPrefix',
  );
});
