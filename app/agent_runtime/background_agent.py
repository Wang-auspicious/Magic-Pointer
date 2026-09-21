"""Independent coding Agent processes; durable status, input and completion inbox.

Credentials cross the initial stdin pipe only. The worker owns its status file;
UI responses go through the existing session journal, never a second tool queue.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.agent_runtime.session import FileSessionStore

ACTIVE = {'starting', 'running', 'awaiting_user'}


def _path(root: Path, child_id: str) -> Path:
    FileSessionStore._validate_id(child_id)
    return Path(root) / f'{child_id}.agent.json'


def _persist(path: Path, value: dict) -> None:
    temporary = path.with_suffix('.pending')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    # Windows readers can briefly hold a handle that disallows replacement.
    # Keep the old complete snapshot visible and retry the same new snapshot.
    for attempt in range(5):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(.02 * (attempt + 1))


def read_status(root: Path, child_id: str) -> dict | None:
    path = _path(root, child_id)
    for attempt in range(5):
        try:
            value = json.loads(path.read_text(encoding='utf-8'))
            break
        except FileNotFoundError:
            return None
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(.02 * (attempt + 1))
    from app.agent_runtime.coding_tools import _pid_alive
    if value.get('status') in ACTIVE and value.get('pid') and not _pid_alive(value['pid']):
        value = {**value, 'status': 'stopped', 'phase': 'stopped',
                 'summary': 'Worker exited before finishing. Resume this Agent to continue from its journal.', 'pendingInput': None}
    return value


def list_children(root: Path, parent_id: str) -> list[dict]:
    parent = FileSessionStore(root).resume(parent_id)
    ids = dict.fromkeys(e.data['childSessionId'] for e in parent.events if e.type == 'subagent/created')
    return [status for child_id in ids if (status := read_status(root, child_id)) is not None]


def _child(root: Path, parent_id: str, child_id: str):
    child = FileSessionStore(root).resume(child_id)
    if child.header.parent_session_id != parent_id:
        raise ValueError('subagent_parent_mismatch')
    return child


def respond(root: Path, parent_id: str, child_id: str, request_id: str, response: dict) -> dict:
    try:
        child = _child(root, parent_id, child_id)
        status = read_status(root, child_id)
        if not status or status['status'] not in ACTIVE or stop_requested(child):
            raise ValueError('subagent_not_running')
        # A retried IPC after a lost response must not consume another request.
        answered = next((e for e in child.events if e.type == 'user_input/answered'
                         and e.data['requestId'] == request_id), None)
        if answered:
            if answered.data['response'] != response:
                raise ValueError('input_already_answered_differently')
        else:
            child.answer_user_input(request_id, response)
        return {'ok': True, 'accepted': True, 'sessionId': child_id}
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        return {'ok': False, 'error': str(exc)}


def stop_requested(child) -> bool:
    return child.path.with_suffix('.agent.stop').exists()


def stop(root: Path, parent_id: str, child_id: str) -> dict:
    try:
        child = _child(root, parent_id, child_id)
        status = read_status(root, child_id)
        if not status or status['status'] not in ACTIVE:
            raise ValueError('subagent_not_running')
        child.path.with_suffix('.agent.stop').touch()
        if child.open_turn is not None and not child.pending_cancel_request():
            child.request_cancel(reason='user stopped this subagent')
        return {'ok': True, 'sessionId': child_id}
    except (ValueError, RuntimeError, FileNotFoundError) as exc:
        return {'ok': False, 'error': str(exc)}


def launch(*, child, parent, provider: Any, workspace_root: Path, prompt: str,
           mode: str, effort: str, readonly: bool, permissions, parent_call_id: str,
           max_tool_calls: int, max_tokens: int) -> dict:
    config = provider.background_config()  # Provider explicitly supports process handoff.
    path = _path(child.path.parent, child.id)
    previous = read_status(child.path.parent, child.id)
    if previous and previous['status'] in ACTIVE:
        raise ValueError('subagent_already_running')
    child.path.with_suffix('.agent.stop').unlink(missing_ok=True)
    meta = {'id': child.id, 'parentCallId': parent_call_id, 'description': prompt or
            next((e.data.get('task', '') for e in child.events if e.type == 'subagent/configured'), ''),
            'parentSessionId': parent.id if parent else '', 'readonly': readonly,
            'status': 'starting', 'phase': 'starting', 'background': True, 'stepCount': 0,
            'startedAt': time.time() * 1000, 'steps': [], 'currentTool': ''}
    meta['errorPath'] = str(path.with_suffix('.log'))
    _persist(path, meta)
    payload = {'sessionRoot': str(child.path.parent), 'childId': child.id,
               'parentId': parent.id if parent else '', 'root': str(workspace_root.resolve()),
               'prompt': prompt, 'mode': mode, 'effort': effort, 'readonly': readonly,
               'allowed': list(permissions.allowed), 'denied': list(permissions.denied),
               'parentCallId': parent_call_id, 'maxToolCalls': max_tool_calls, 'maxTokens': max_tokens,
               'provider': config}
    try:
        with Path(meta['errorPath']).open('ab') as error_log:
            worker = subprocess.Popen([sys.executable, *(['-I'] if sys.flags.isolated else []), '-X', 'utf8', str(Path(__file__).resolve())],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=error_log,
                cwd=str(Path(__file__).resolve().parents[2]),
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), start_new_session=os.name != 'nt')
        meta['pid'] = worker.pid
        _persist(path, meta)
        worker.stdin.write(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
        worker.stdin.close()
    except Exception as exc:
        _persist(path, {**meta, 'status': 'failed', 'summary': str(exc)})
        raise
    return {**meta, 'status': 'running'}


def run(payload: dict) -> None:
    from app.ai_client import request_ai_config
    from app.harness.builtin_bundle import _MessagesLlmProvider
    from app.agent_runtime.permission_decisions import PermissionDecisions, current_permission_decisions
    from app.agent_runtime.subagent import register_delegate_tool
    from app.agent_runtime.tool_registry import ToolRegistry

    store = FileSessionStore(Path(payload['sessionRoot']))
    child_id = payload['childId']
    parent = store.resume(payload['parentId']) if payload['parentId'] else None
    path = _path(Path(payload['sessionRoot']), child_id)
    meta = json.loads(path.read_text(encoding='utf-8'))
    meta['pid'] = os.getpid()
    _persist(path, meta)
    started_at = meta['startedAt']
    notified = False

    def progress(value: dict) -> None:
        meta.update(value)
        meta['parentCallId'] = payload['parentCallId']
        meta['startedAt'] = started_at
        meta['elapsedMs'] = round(time.time() * 1000 - started_at)
        # An approval wait is unfinished work and has no completion timestamp.
        if meta['status'] in ACTIVE:
            meta.pop('completedAt', None)
        # A terminal state is published only after output and notification are
        # durable. Pollers must not observe 'completed' before its inbox item.
        if meta['status'] in ACTIVE:
            _persist(path, meta)

    def finish(status: str, summary: str) -> None:
        nonlocal notified
        output = path.with_suffix('.txt')
        output.write_text(summary, encoding='utf-8')
        meta.update(status=status, phase=status, summary=summary, outputPath=str(output),
                    completedAt=time.time() * 1000, pendingInput=None)
        if parent and not notified:
            parent.enqueue_inbox(f"Agent {child_id} {status}: {summary[:6000]}\nFull output: {output}",
                'next-step', message_id=f'agent-{child_id}-{int(started_at)}')
            notified = True
        _persist(path, meta)

    try:
        with request_ai_config(payload['provider']['aiConfig'], session_id=child_id):
            token = current_permission_decisions.set(PermissionDecisions(
                allowed=tuple(payload['allowed']), denied=tuple(payload['denied'])))
            try:
                registry = ToolRegistry()
                register_delegate_tool(registry, llm_provider=_MessagesLlmProvider(streaming=payload['provider']['streaming']),
                    workspace_root=payload['root'], permission_mode=payload['mode'], effort=payload['effort'],
                    max_tool_calls=payload['maxToolCalls'], max_tokens=payload['maxTokens'],
                    parent_session_getter=lambda: parent, subagent_event_sink=progress, detached=True)
                prompt = payload['prompt']
                while True:
                    child = store.resume(child_id)
                    if stop_requested(child):
                        child.cancel_unstarted_permissions()
                        finish('stopped', 'Stopped by user.')
                        return
                    pending = child.pending_user_input()
                    if pending and not child.approved_permission_calls():
                        progress({'status': 'awaiting_user', 'phase': 'awaiting_user', 'pendingInput': pending})
                        time.sleep(.25)
                        prompt = ''
                        continue
                    meta['pendingInput'] = None
                    result = registry.execute_tool('Agent', {'task': prompt, 'resume_id': child_id,
                        'readonly': payload['readonly']}, tool_call_id=payload['parentCallId'])
                    prompt = ''
                    if meta['status'] == 'awaiting_user':
                        continue
                    status = meta.get('status', 'failed')
                    if stop_requested(store.resume(child_id)):
                        status = 'stopped'
                    finish(status if not result.is_error else 'stopped' if status in {'stopped', 'user_interrupt'} else 'failed',
                           str(meta.get('summary') or result.error_message or result.value or ''))
                    return
            finally:
                current_permission_decisions.reset(token)
    except Exception as exc:
        finish('failed', f'{type(exc).__name__}: {exc}')


if __name__ == '__main__':
    run(json.loads(sys.stdin.buffer.read().decode('utf-8')))
