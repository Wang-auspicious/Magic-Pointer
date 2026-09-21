from __future__ import annotations

import json

from app.agent_runtime.permission_presets import mode_for_preset
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import AgentMessage, Role, ORIGIN_DATA


def test_plan_preset_is_a_readonly_execution_boundary():
    assert mode_for_preset('plan').value == 'plan'


def test_plan_approval_is_durable_and_bound_to_original_tool(tmp_path):
    from app.agent_runtime.plan_mode import register_plan_tools, current_mode
    store = FileSessionStore(tmp_path)
    session = store.create('plan-test')
    registry = ToolRegistry()
    register_plan_tools(registry, session_getter=lambda: session)
    entered = registry.execute_tool('EnterPlanMode', {})
    assert not entered.is_error
    assert current_mode(session, 'bypass') == 'plan'
    result = registry.execute_tool('ExitPlanMode', {'plan': 'Change one file, then run its test.'})
    assert not result.is_error
    session.append_message(AgentMessage(role=Role.TOOL, name='ExitPlanMode', tool_call_id='exit-1',
        content=result.value, origin=ORIGIN_DATA))
    pending = session.pending_user_input()
    assert pending['kind'] == 'plan'
    assert pending['plan'] == 'Change one file, then run its test.'
    assert current_mode(session, 'bypass') == 'plan'
    session.answer_user_input('exit-1', {'decision': 'grant'})
    restored = store.resume(session.id, repair=False)
    assert restored.pending_user_input() is None
    assert current_mode(restored, 'plan') == 'default'
    answer = json.loads(restored.derive_messages()[-1].content)
    assert answer['answered'] is True
    assert restored.derive_messages()[-1].name == 'ExitPlanMode'


def test_rejected_plan_stays_readonly(tmp_path):
    from app.agent_runtime.plan_mode import register_plan_tools, current_mode
    session = FileSessionStore(tmp_path).create('plan-denied')
    registry = ToolRegistry()
    register_plan_tools(registry, session_getter=lambda: session)
    registry.execute_tool('EnterPlanMode', {})
    result = registry.execute_tool('ExitPlanMode', {'plan': 'Proposed work'})
    session.append_message(AgentMessage(role=Role.TOOL, name='ExitPlanMode', tool_call_id='exit-2',
        content=result.value, origin=ORIGIN_DATA))
    session.answer_user_input('exit-2', {'decision': 'deny'})
    assert current_mode(session, 'bypass') == 'plan'


def test_enter_plan_blocks_later_mutation_in_same_model_batch(tmp_path):
    import asyncio
    from dataclasses import replace
    from agent_runtime_loop_test import ScriptedBackend, collect, make_params
    from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
    from app.agent_runtime.plan_mode import register_plan_tools
    from app.agent_runtime.tool_registry import Effect, ToolSpec
    from app.agent_runtime.types import ToolCall
    session = FileSessionStore(tmp_path).create('plan-boundary')
    registry = ToolRegistry()
    register_plan_tools(registry, session_getter=lambda: session)
    writes = []
    registry.register(ToolSpec(name='Modify', description='edit',
        input_schema={'type': 'object', 'properties': {}, 'required': []},
        execute=lambda: writes.append(True) or 'done', effect=Effect.REVERSIBLE_WRITE))
    backend = ScriptedBackend([
        ToolCallArrived(call=ToolCall(id='enter', name='EnterPlanMode', arguments={})),
        ToolCallArrived(call=ToolCall(id='write', name='Modify', arguments={})),
        TurnDone(usage=None, raw_text=None),
    ], [TurnDone(usage=None, raw_text='Planning only')])
    _, terminal = asyncio.run(collect(replace(make_params(registry=registry,
        client=LoopModelClient(backend)), session=session, permission_mode='bypass',
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE))))
    assert writes == []
    assert any(result.failure_type == 'permission_denied' for result in terminal.results)


def test_plan_bridge_approval_overrides_stale_composer_and_survives_next_turn(tmp_path, monkeypatch):
    from conversation_bridge_test import _install_runtime_service_stubs
    from scripts import conversation_bridge
    from app.agent_runtime.types import Terminal, TransitionReason
    from app.agent_runtime.plan_mode import select_mode
    store = FileSessionStore(tmp_path)
    session = store.create('agent-studio-new-plan-bridge')
    select_mode(session, 'plan')
    session.append_message(AgentMessage(role=Role.TOOL, name='ExitPlanMode', tool_call_id='approve',
        content=json.dumps({'kind': 'plan', 'tool': 'ExitPlanMode', 'plan': 'Implement',
            'question': 'Approve?', 'options': ['Yes', 'No'], 'awaitingUserInput': True}), origin=ORIGIN_DATA))
    modes = []
    def run(*args, **kwargs):
        modes.append(kwargs['permission_mode'])
        return Terminal(reason=TransitionReason.COMPLETED, message='Done', turns=1, results=())
    _install_runtime_service_stubs(monkeypatch, session_store=store, registry=ToolRegistry(),
        compactor=lambda x, **kw: x, token_estimator=lambda x: 1, run_impl=run)
    result = conversation_bridge.answer_conversation('', [], {}, 'plan', agent_session_id=session.id,
        input_response={'requestId': 'approve', 'response': {'decision': 'once'}})
    assert result['accepted'] is True
    assert result['permissionPreset'] == 'read-only'
    conversation_bridge.answer_conversation('Continue', [], {}, 'plan', agent_session_id=session.id)
    assert modes == ['safe', 'safe']


def test_loop_returns_full_plan_for_the_real_approval_card(tmp_path):
    import asyncio
    from dataclasses import replace
    from agent_runtime_loop_test import ScriptedBackend, collect, make_params
    from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
    from app.agent_runtime.plan_mode import register_plan_tools, select_mode
    from app.agent_runtime.types import ToolCall
    session = FileSessionStore(tmp_path).create('plan-card')
    select_mode(session, 'plan')
    registry = ToolRegistry()
    register_plan_tools(registry, session_getter=lambda: session)
    backend = ScriptedBackend([ToolCallArrived(call=ToolCall(id='exit', name='ExitPlanMode',
        arguments={'plan': 'Review and test the file.'})), TurnDone(usage=None, raw_text=None)])
    _, terminal = asyncio.run(collect(replace(make_params(registry=registry,
        client=LoopModelClient(backend)), session=session, permission_mode='plan')))
    assert terminal.pending_input['kind'] == 'plan'
    assert terminal.pending_input['plan'] == 'Review and test the file.'


def test_new_instruction_can_revise_a_pending_plan(tmp_path):
    import asyncio
    from agent_runtime_loop_test import ScriptedBackend, collect, make_params
    from app.agent_runtime.model_client import LoopModelClient, TurnDone
    from app.agent_runtime.plan_mode import select_mode, current_mode
    session = FileSessionStore(tmp_path).create('plan-revision')
    select_mode(session, 'plan')
    session.append_message(AgentMessage(role=Role.TOOL, name='ExitPlanMode', tool_call_id='old-plan',
        content=json.dumps({'kind': 'plan', 'tool': 'ExitPlanMode', 'plan': 'Edit the file.',
            'question': 'Approve?', 'options': ['Approve', 'Revise'], 'awaitingUserInput': True}), origin=ORIGIN_DATA))
    backend = ScriptedBackend([TurnDone(usage=None, raw_text='I will revise the plan.')])
    _, terminal = asyncio.run(collect(make_params(user_input='Revise the plan to include migration.',
        client=LoopModelClient(backend), session=session, permission_mode='plan')))
    assert len(backend.received) == 1
    assert terminal.reason.value == 'completed'
    assert current_mode(session, 'default') == 'plan'
    assert session.pending_user_input() is None
