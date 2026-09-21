import asyncio

from agent_runtime_loop_test import ScriptedBackend, collect, make_params

from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.permission_decisions import PermissionDecisions
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import ToolCall
from scripts.conversation_bridge import _build_permission_decisions


def test_deny_command_prefix_blocks_execution_even_in_full_access():
    registry = ToolRegistry()
    executed = []
    registry.register(ToolSpec(name='Bash', description='shell fixture', effect=Effect.LOCAL_IRREVERSIBLE,
        input_schema={'type': 'object', 'properties': {'command': {'type': 'string'}}, 'required': ['command']},
        execute=lambda command, scope=None: executed.append(command) or 'ran'))
    backend = ScriptedBackend([
        ToolCallArrived(call=ToolCall(id='denied-call', name='Bash', arguments={'command': 'python report.py --publish'})),
        TurnDone(usage=None, raw_text=None),
    ], [TurnDone(usage=None, raw_text='Stopped')])
    asyncio.run(collect(make_params(registry=registry, client=LoopModelClient(backend),
        allowed_effects=tuple(Effect), permission_mode='bypass', permission_decisions=PermissionDecisions(denied=('Bash(python report.py)',)))))
    assert executed == []


def test_once_approval_authorizes_only_one_matching_tool_invocation():
    registry = ToolRegistry()
    executed = []
    registry.register(ToolSpec(name='Bash', description='shell fixture', effect=Effect.LOCAL_IRREVERSIBLE,
        input_schema={'type': 'object', 'properties': {'command': {'type': 'string'}}, 'required': ['command']},
        execute=lambda command, scope=None: executed.append(command) or 'ran'))
    backend = ScriptedBackend([
        ToolCallArrived(call=ToolCall(id='first', name='Bash', arguments={'command': 'python report.py'})),
        ToolCallArrived(call=ToolCall(id='second', name='Bash', arguments={'command': 'python report.py --publish'})),
        TurnDone(usage=None, raw_text=None),
    ], [TurnDone(usage=None, raw_text='Done')])
    asyncio.run(collect(make_params(registry=registry, client=LoopModelClient(backend),
        allowed_effects=tuple(Effect), permission_decisions=_build_permission_decisions((), (), ('Bash(python report.py)',), registry=registry))))
    assert executed == ['python report.py']


def test_once_approval_bound_to_blocked_arguments_rejects_modified_action():
    decisions = _build_permission_decisions((), (), ('Bash(python report.py)',),
        once_arguments={'Bash(python report.py)': {'command': 'python report.py --draft'}})
    assert not decisions.allows_call('Bash', {'command': 'python report.py --publish'}, 'changed')
    assert decisions.allows_call('Bash', {'command': 'python report.py --draft'}, 'approved')
    assert decisions.allows_call('Bash', {'command': 'python report.py --draft'}, 'approved')
    assert not decisions.allows_call('Bash', {'command': 'python report.py --draft'}, 'next-call')
