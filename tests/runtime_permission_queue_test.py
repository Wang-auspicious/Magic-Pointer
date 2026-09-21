"""A permission wait must bind the real call before any side effect."""
import asyncio

from agent_runtime_loop_test import ScriptedBackend, collect, make_params
from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import ToolCall


def _registry(writes):
    registry = ToolRegistry()
    registry.register(ToolSpec(name='Modify', description='edit',
        input_schema={'type': 'object', 'properties': {'value': {'type': 'string'}}, 'required': ['value']},
        execute=lambda value, scope=None: writes.append(value) or 'verified edit', effect=Effect.REVERSIBLE_WRITE))
    return registry


def test_manual_mode_asks_directly_and_queues_actual_calls(tmp_path):
    session = FileSessionStore(tmp_path).create('approval-queue')
    writes = []
    registry = _registry(writes)
    backend = ScriptedBackend([
        ToolCallArrived(call=ToolCall(id='a', name='Modify', arguments={'value': 'first'})),
        ToolCallArrived(call=ToolCall(id='b', name='Modify', arguments={'value': 'second'})),
        TurnDone(usage=None, raw_text=None),
    ])
    _, terminal = asyncio.run(collect(make_params(registry=registry, client=LoopModelClient(backend),
        session=session, permission_mode='safe', allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE))))
    assert terminal.reason.value == 'awaiting_user'
    assert writes == []
    assert len(backend.received) == 1
    assert terminal.pending_input['requestId'] == 'a'
    assert terminal.pending_input['action'] == {'tool': 'Modify', 'arguments': {'value': 'first'}}
    session.answer_user_input('a', {'decision': 'once'})
    assert session.pending_user_input()['requestId'] == 'b'
    assert session.derive_messages()[-2].name == 'Modify'


def test_approved_action_executes_exactly_before_next_model_and_survives_restart(tmp_path):
    store = FileSessionStore(tmp_path)
    session = store.create('approval-resume')
    writes = []
    registry = _registry(writes)
    backend = ScriptedBackend([
        ToolCallArrived(call=ToolCall(id='a', name='Modify', arguments={'value': 'approved'})),
        TurnDone(usage=None, raw_text=None),
    ])
    asyncio.run(collect(make_params(registry=registry, client=LoopModelClient(backend), session=session,
        permission_mode='safe', allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE))))
    session.answer_user_input('a', {'decision': 'once'})
    session = store.resume(session.id, repair=False)

    class AfterApproval:
        def generate(self, *args, **kwargs):
            assert writes == ['approved'], 'model ran before the approved original action'
            yield TurnDone(usage=None, raw_text='Complete')

    _, terminal = asyncio.run(collect(make_params(user_input='', registry=registry,
        client=LoopModelClient(AfterApproval()), session=session, permission_mode='safe',
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE))))
    assert writes == ['approved'], [(result.value, result.failure_type) for result in terminal.results]
    assert terminal.reason.value == 'completed'
    assert session.pending_user_input() is None
    # A later turn must not replay the already settled approval.
    asyncio.run(collect(make_params(registry=registry, session=store.resume(session.id, repair=False),
        permission_mode='safe', allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE))))
    assert writes == ['approved']


def test_exact_once_allows_shell_chain_without_granting_a_prefix():
    from app.agent_runtime.permission_decisions import PermissionDecisions
    args = {'command': 'npm test && npm run build'}
    decisions = PermissionDecisions(once=('Bash',), once_arguments={'Bash': args})
    assert decisions.allows_call('Bash', args, 'approved')
    assert not decisions.allows_call('Bash', {'command': 'npm test && other'}, 'changed')
    assert not decisions.allows_call('Bash', args, 'second')


def test_new_instruction_cancels_unstarted_approval_instead_of_running_stale_work(tmp_path):
    store = FileSessionStore(tmp_path)
    session = store.create('approval-cancel')
    writes = []
    registry = _registry(writes)
    backend = ScriptedBackend([ToolCallArrived(call=ToolCall(id='a', name='Modify', arguments={'value': 'old'})),
        TurnDone(usage=None, raw_text=None)])
    asyncio.run(collect(make_params(registry=registry, client=LoopModelClient(backend), session=session,
        permission_mode='safe', allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE))))
    session.answer_user_input('a', {'decision': 'once'})
    _, terminal = asyncio.run(collect(make_params(user_input='Stop that edit, only explain the file.',
        registry=registry, session=store.resume(session.id, repair=False),
        permission_mode='safe', allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE))))
    assert writes == []
    assert terminal.reason.value == 'completed'
    restored = store.resume(session.id, repair=False)
    assert restored.pending_user_input() is None
    assert restored.approved_permission_calls() == []


def test_approval_continuation_keeps_the_original_messages_thinking_block(tmp_path):
    from app.agent_runtime.types import Role
    store = FileSessionStore(tmp_path)
    session = store.create('signed-approval')
    writes = []
    registry = _registry(writes)
    thinking = {'type': 'thinking', 'thinking': 'Prepare the exact edit.', 'signature': 'original-signature'}
    backend = ScriptedBackend([ToolCallArrived(call=ToolCall(id='a', name='Modify', arguments={'value': 'new'})),
        TurnDone(usage=None, raw_text=None, provider_items=(thinking,))])
    asyncio.run(collect(make_params(registry=registry, client=LoopModelClient(backend), session=session,
        permission_mode='safe', allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE))))
    session.answer_user_input('a', {'decision': 'once'})
    resumed_backend = ScriptedBackend([TurnDone(usage=None, raw_text='Done')])
    asyncio.run(collect(make_params(user_input='', registry=registry, client=LoopModelClient(resumed_backend),
        session=store.resume(session.id, repair=False), permission_mode='safe',
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE))))
    assistant = [message for message in resumed_backend.received[0][0] if message.role is Role.ASSISTANT][-1]
    assert assistant.provider_items == (thinking,)
