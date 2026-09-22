import json
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app.agent_runtime.session import FileSessionStore

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def model():
    state = {'write': False, 'requests': [], 'release': threading.Event()}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            state['requests'].append(body)
            assert state['release'].wait(20)
            has_result = any(m['role'] == 'tool' and m.get('tool_call_id') == 'approval-edit' for m in body['messages'])
            message = {'role': 'assistant', 'content': 'child finished'}
            if state['write'] and not has_result:
                message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'edit', 'type': 'function',
                    'function': {'name': 'Write', 'arguments': json.dumps({'path': 'child.txt', 'content': 'approved content'})}}]}
            data = json.dumps({'choices': [{'message': message, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 30, 'completion_tokens': 10}}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state['url'] = f'http://127.0.0.1:{server.server_port}/v1'
    yield state
    state['release'].set()
    server.shutdown()
    server.server_close()


def launch(tmp_path, model, *, mode='bypass', background=True, resume=False):
    FileSessionStore(tmp_path / 'sessions').open_or_create('parent')
    code = '''
import json, sys
from pathlib import Path
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.subagent import register_delegate_tool
from app.agent_runtime.tool_registry import ToolRegistry
from app.ai_client import request_ai_config
from app.harness.builtin_bundle import _MessagesLlmProvider
p=json.load(sys.stdin)
parent=FileSessionStore(Path(p['root'])/'sessions').resume('parent')
with request_ai_config(p['ai'], session_id='parent'):
    registry=ToolRegistry()
    register_delegate_tool(registry, llm_provider=_MessagesLlmProvider(streaming=False),
        workspace_root=p['root'], permission_mode=p['mode'], parent_session_getter=lambda: parent, id_factory=lambda: 'child')
    arguments={'task':'Do the child task'}
    if p['background'] is not None:
        arguments['run_in_background']=p['background']
    if p['resume']:
        arguments['resume_id']='child'
    result=registry.execute_tool('Agent', arguments, tool_call_id='parent-call')
    print(json.dumps({'error':result.is_error, 'value':str(result.value), 'message':result.error_message}))
'''
    completed = subprocess.run([sys.executable, '-c', code], cwd=ROOT, input=json.dumps({
        'root': str(tmp_path), 'ai': {'credential': 'local-test-key', 'baseUrl': model['url'],
        'model': 'local-test', 'apiMode': 'chat-completions'}, 'mode': mode, 'background': background, 'resume': resume,
    }), capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout.splitlines()[-1])
    assert not result['error'], result
    return result


def wait_status(tmp_path, statuses):
    from app.agent_runtime.background_agent import read_status
    deadline = time.monotonic() + 15
    last = None
    while time.monotonic() < deadline:
        last = read_status(tmp_path / 'sessions', 'child')
        if last and last['status'] in statuses:
            return last
        time.sleep(.05)
    log = tmp_path / 'sessions' / 'child.agent.log'
    pytest.fail(f'child did not reach {statuses}: {last}\n{log.read_text(encoding="utf-8") if log.exists() else ""}')


def test_child_outlives_parent_and_notifies_durable_inbox(tmp_path, model):
    result = launch(tmp_path, model)
    assert 'status=running' in result['value']
    model['release'].set()
    status = wait_status(tmp_path, {'completed'})
    assert status['summary'] == 'child finished'
    assert status['parentCallId'] == 'parent-call'
    parent = FileSessionStore(tmp_path / 'sessions').resume('parent')
    assert any('child finished' in item.text for item in parent.pending_inbox('next-step'))
    assert 'local-test-key' not in ''.join(p.read_text(encoding='utf-8') for p in (tmp_path / 'sessions').glob('*') if p.suffix in {'.json', '.jsonl'})


@pytest.mark.parametrize('background', [True, False])
def test_parent_can_approve_exact_child_call_and_worker_resumes(tmp_path, model, background):
    from app.agent_runtime.background_agent import respond
    model['write'] = True
    model['release'].set()
    launch(tmp_path, model, mode='safe', background=background)
    status = wait_status(tmp_path, {'awaiting_user'})
    assert status['pendingInput']['action']['arguments']['content'] == 'approved content'
    assert not (tmp_path / 'child.txt').exists()
    assert respond(tmp_path / 'sessions', 'other-parent', 'child', 'edit', {'decision': 'once'})['ok'] is False
    assert respond(tmp_path / 'sessions', 'parent', 'child', 'wrong-id', {'decision': 'once'})['ok'] is False
    assert respond(tmp_path / 'sessions', 'parent', 'child', 'edit', {'decision': 'once'})['ok']
    wait_status(tmp_path, {'completed'})
    assert (tmp_path / 'child.txt').read_text() == 'approved content'
    events = FileSessionStore(tmp_path / 'sessions').resume('child').events
    assert sum(e.type == 'operation/prepared' and e.data.get('callId') == 'approval-edit' for e in events) == 1
    status = wait_status(tmp_path, {'completed'})
    assert status['description'] == 'Do the child task', 'approval continuation must retain the task name'
    assert {step['callId'] for step in status['steps']} == {'edit', 'approval-edit'}, 'transcript lost the pre-approval attempt'


def test_stop_waiting_child_never_executes_pending_action(tmp_path, model):
    from app.agent_runtime.background_agent import stop
    model['write'] = True
    model['release'].set()
    launch(tmp_path, model, mode='safe')
    wait_status(tmp_path, {'awaiting_user'})
    assert not stop(tmp_path / 'sessions', 'unrelated-parent', 'child')['ok']
    assert stop(tmp_path / 'sessions', 'parent', 'child')['ok']
    wait_status(tmp_path, {'stopped'})
    assert not (tmp_path / 'child.txt').exists()


def test_resuming_background_child_keeps_independent_lifetime(tmp_path, model):
    model['release'].set()
    launch(tmp_path, model)
    wait_status(tmp_path, {'completed'})
    resumed = launch(tmp_path, model, resume=True, background=None)
    assert 'status=running' in resumed['value'], 'resume silently changed the independent child into a blocking call'
    wait_status(tmp_path, {'completed'})
