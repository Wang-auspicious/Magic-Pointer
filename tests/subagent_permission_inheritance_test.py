import json
from types import SimpleNamespace

import pytest

from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.subagent import register_delegate_tool
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import AgentMessage, ORIGIN_DATA, Role, Terminal, TransitionReason


@pytest.mark.parametrize('decision,allowed', [('grant', True), ('once', False), ('deny', False)])
def test_child_inherits_parent_session_rules_but_not_parent_once_approval(monkeypatch, tmp_path, decision, allowed):
    from app.fabric import engine
    parent = FileSessionStore(tmp_path / 'sessions').create('parent')
    parent.append_message(AgentMessage(role=Role.TOOL, tool_call_id='ask', name='AskUser', origin=ORIGIN_DATA,
        content=json.dumps({'kind': 'permission', 'tool': 'Bash', 'prefix': 'npm test',
            'question': 'Allow?', 'options': ['Once', 'Session', 'Deny'], 'awaitingUserInput': True})))
    parent.answer_user_input('ask', {'decision': decision})
    captured = []
    def run(*args, **kwargs):
        captured.append(kwargs)
        return Terminal(reason=TransitionReason.COMPLETED, message='Done', turns=1, results=())
    monkeypatch.setattr(engine, 'run_agent_turn', run)
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=SimpleNamespace(create_client=lambda **kwargs: object()),
        workspace_root=tmp_path, permission_mode='default', parent_session_getter=lambda: parent)
    assert not registry.execute_tool('Agent', {'task': 'test the edit'}).is_error
    permissions = captured[0].get('permission_decisions')
    assert permissions is not None
    assert permissions.allows_call('Bash', {'command': 'npm test'}, 'child') is allowed
    assert not permissions.allows_call('Bash', {'command': 'npm install'}, 'other')


def test_runtime_dispatch_passes_explicit_parent_rules_and_restores_context(monkeypatch, tmp_path):
    import asyncio
    from agent_runtime_loop_test import ScriptedBackend, collect, make_params
    from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
    from app.agent_runtime.permission_decisions import PermissionDecisions, current_permission_decisions
    from app.agent_runtime.tool_registry import Effect
    from app.agent_runtime.types import ToolCall
    from app.fabric import engine
    captured = []
    monkeypatch.setattr(engine, 'run_agent_turn', lambda *args, **kwargs: captured.append(kwargs) or Terminal(
        reason=TransitionReason.COMPLETED, message='Done', turns=1, results=()))
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=SimpleNamespace(create_client=lambda **kwargs: object()), workspace_root=tmp_path)
    backend = ScriptedBackend([ToolCallArrived(call=ToolCall(id='delegate', name='Agent', arguments={'task': 'run tests'})),
        TurnDone(usage=None, raw_text=None)], [TurnDone(usage=None, raw_text='Done')])
    asyncio.run(collect(make_params(registry=registry, client=LoopModelClient(backend),
        permission_mode='default', allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE),
        permission_decisions=PermissionDecisions(allowed=('Bash(npm test)',), once=('Bash',)))))
    assert captured[0]['permission_decisions'].allowed == ('Bash(npm test)',)
    assert captured[0]['permission_decisions'].once == ()
    assert current_permission_decisions.get() is None


def test_resume_keeps_grants_made_in_the_child_session(monkeypatch, tmp_path):
    from app.fabric import engine
    store = FileSessionStore(tmp_path / 'sessions')
    parent = store.create('parent')
    child = store.create('child', parent_session_id='parent')
    child.append('subagent/configured', {'task': 'edit', 'readonly': False, 'effort': 'high'})
    child.append_message(AgentMessage(role=Role.TOOL, tool_call_id='ask', name='AskUser', origin=ORIGIN_DATA,
        content=json.dumps({'kind': 'permission', 'tool': 'Write', 'question': 'Allow?',
            'options': ['Once', 'Session', 'Deny'], 'awaitingUserInput': True})))
    child.answer_user_input('ask', {'decision': 'grant'})
    captured = []
    monkeypatch.setattr(engine, 'run_agent_turn', lambda *args, **kwargs: captured.append(kwargs) or Terminal(
        reason=TransitionReason.COMPLETED, message='Done', turns=1, results=()))
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=SimpleNamespace(create_client=lambda **kwargs: object()),
        workspace_root=tmp_path, permission_mode='safe', parent_session_getter=lambda: parent)
    assert not registry.execute_tool('Agent', {'task': 'continue', 'resume_id': 'child'}).is_error
    assert captured[0]['permission_decisions'].allows_call('Write', {'path': 'another.txt'}, 'next')
