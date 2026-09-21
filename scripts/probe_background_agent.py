"""Real configured-provider acceptance in a fresh, disposable task workspace."""
from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.agent_runtime.background_agent import read_status, respond, stop
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.subagent import register_delegate_tool
from app.agent_runtime.tool_registry import ToolRegistry
from app.ai_client import get_ai_config, get_ai_api_mode
from app.harness.builtin_bundle import _MessagesLlmProvider


def main() -> None:
    root = ROOT / 'data' / 'runtime' / f'background-acceptance-{uuid.uuid4().hex[:10]}'
    root.mkdir(parents=True)
    store = FileSessionStore(root / 'sessions')
    parent = store.create('parent')
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=_MessagesLlmProvider(streaming=True),
        workspace_root=root, permission_mode='safe', parent_session_getter=lambda: parent,
        id_factory=lambda: 'child', max_tool_calls=12)
    result = registry.execute_tool('Agent', {'task':
        'Use Write to create acceptance.txt with exactly background-agent-verified followed by one newline. '
        'Use Read to read it back, then briefly report the verified result. Only use Write and Read; do not use Bash. '
        'This small acceptance task requires no other files or research.', 'run_in_background': True}, tool_call_id='acceptance')
    assert not result.is_error, result.error_message
    print(json.dumps({'started': True, 'workspace': str(root), 'model': get_ai_config()[2],
                      'apiMode': get_ai_api_mode(get_ai_config()[1])}), flush=True)
    deadline = time.monotonic() + 180
    approvals = []
    last_status = ''
    while time.monotonic() < deadline:
        status = read_status(store.root, 'child')
        if status['status'] != last_status:
            last_status = status['status']
            print(json.dumps({'status': last_status, 'stepCount': status.get('stepCount', 0)}), flush=True)
        if last_status == 'awaiting_user':
            pending = status['pendingInput']
            action = pending.get('action') or {}
            args = action.get('arguments') or {}
            target = Path(str(args.get('path') or ''))
            resolved = (target if target.is_absolute() else root / target).resolve()
            if action.get('tool') != 'Write' or resolved != root / 'acceptance.txt' or args.get('content') != 'background-agent-verified\n':
                stop(store.root, 'parent', 'child')
                raise AssertionError(f'Model requested an unexpected action: {action}')
            request_id = pending['requestId']
            if request_id not in approvals:
                accepted = respond(store.root, 'parent', 'child', request_id, {'decision': 'once'})
                assert accepted['ok'], accepted
                approvals.append(request_id)
        elif last_status not in {'starting', 'running'}:
            break
        time.sleep(.25)
    else:
        stop(store.root, 'parent', 'child')
        raise TimeoutError('Real model acceptance exceeded 180 seconds; child stop requested.')
    assert last_status == 'completed', status
    assert (root / 'acceptance.txt').read_bytes() == b'background-agent-verified\n'
    assert approvals, 'The real write did not pass through manual approval.'
    assert any(step['tool'] == 'Read' and step['status'] == 'completed' for step in status['steps']), status
    assert store.resume('parent').pending_inbox('next-step'), 'Completion notification missing'
    report = {'ok': True, 'model': get_ai_config()[2], 'apiMode': get_ai_api_mode(get_ai_config()[1]),
              'approvals': approvals, 'status': status, 'usedBackend': 'subagent_loop', 'workspace': str(root)}
    report_path = root / 'acceptance.json'
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'ok': True, 'report': str(report_path), 'elapsedMs': status['elapsedMs']}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
