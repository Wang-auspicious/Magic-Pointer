from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest
from agent_runtime_loop_test import ScriptedBackend, collect, make_params
from conversation_bridge_test import _install_runtime_service_stubs

from app.agent_runtime.ask_todo_tools import register_ask_user_question
from app.agent_runtime.loop import _first_messages
from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import AgentMessage, Role, Terminal, ToolCall, TransitionReason
from app.agent_runtime.user_input import normalize_input_response
from scripts import conversation_bridge


def waiting_session(tmp_path, *, permission=False, multi=False):
    session = FileSessionStore(tmp_path).create('agent-studio-new-waiting-input')
    turn = session.start_turn()
    session.append_message(AgentMessage(role=Role.USER, content='Prepare the report', tool_call_id=None, name=None))
    if permission:
        session.append_message(AgentMessage(role=Role.ASSISTANT, content='', tool_call_id=None, name=None,
            tool_calls=({'id': 'blocked-1', 'name': 'Bash', 'arguments': {'command': 'python report.py --draft'}},)))
        session.append_message(AgentMessage(role=Role.TOOL, tool_call_id='blocked-1', name='Bash',
            content='permission requires user approval', is_error=True))
    session.append_message(AgentMessage(role=Role.ASSISTANT, content='', tool_call_id=None, name=None, tool_calls=(
        {'id': 'ask-1', 'name': 'AskUser', 'arguments': {}},
    )))
    payload = {'awaitingUserInput': True, 'question': 'Which format?', 'options': ['Brief', 'Detailed']}
    if permission:
        payload.update(kind='permission', tool='Bash', prefix='python report.py')
    if multi:
        payload['questions'] = [{'question': 'Which sections?', 'header': 'Sections',
            'options': [{'label': 'Summary', 'description': 'Top lines'}, {'label': 'Details'}], 'multiSelect': True}]
    session.append_message(AgentMessage(role=Role.TOOL, name='AskUser', tool_call_id='ask-1', content=json.dumps(payload)))
    session.end_turn(turn, reason='awaiting_user')
    return session


def test_answer_replaces_bound_ask_tool_result_and_survives_restart(tmp_path):
    session = waiting_session(tmp_path)
    assert session.pending_user_input()['requestId'] == 'ask-1'
    event = session.answer_user_input('ask-1', {'answers': {'Which format?': 'Detailed'}})
    assert event.type == 'user_input/answered'
    restored = FileSessionStore(tmp_path).resume(session.id, repair=False)
    assert restored.pending_user_input() is None
    messages = restored.derive_messages()
    assert [m.content for m in messages if m.role is Role.USER] == ['Prepare the report']
    tool = next(m for m in messages if m.tool_call_id == 'ask-1')
    assert json.loads(tool.content)['answers'] == {'Which format?': 'Detailed'}
    assert json.loads(tool.content)['awaitingUserInput'] is False
    assert tool.role is Role.TOOL


def test_answers_cannot_consume_another_call_or_be_consumed_twice(tmp_path):
    session = waiting_session(tmp_path)
    with pytest.raises(ValueError, match='pending_input_mismatch'):
        session.answer_user_input('another-call', {'answers': {'Which format?': 'Brief'}})
    assert session.pending_user_input()['requestId'] == 'ask-1'
    session.answer_user_input('ask-1', {'answers': {'Which format?': 'Brief'}})
    with pytest.raises(ValueError, match='pending_input_mismatch'):
        session.answer_user_input('ask-1', {'answers': {'Which format?': 'Detailed'}})


def test_invalid_or_partial_answers_leave_question_pending(tmp_path):
    session = waiting_session(tmp_path, multi=True)
    for response in ({'answers': {}}, {'answers': {'Which sections?': 'wrong shape'}}, {'decision': 'grant'}):
        with pytest.raises(ValueError):
            session.answer_user_input('ask-1', response)
    session.answer_user_input('ask-1', {'answers': {'Which sections?': ['Summary', 'Custom appendix']}})
    assert session.pending_user_input() is None


@pytest.mark.parametrize('multi', [False, True])
def test_skipping_question_is_an_accepted_explicit_tool_answer(tmp_path, multi):
    session = waiting_session(tmp_path, multi=multi)
    question = 'Which sections?' if multi else 'Which format?'
    event = session.answer_user_input('ask-1', {'answers': {question: [] if multi else ''}})
    assert event.data['response']['skippedQuestions'] == [question]
    assert session.pending_user_input() is None
    assert json.loads(session.derive_messages()[-1].content)['skippedQuestions'] == [question]


def test_mixed_answers_keep_selection_and_mark_only_skipped_question():
    pending = {'questions': [{'question': 'Format?'}, {'question': 'Sections?', 'multiSelect': True}]}
    assert normalize_input_response(pending, {'answers': {'Format?': 'Brief', 'Sections?': []}}) == {
        'answers': {'Format?': 'Brief', 'Sections?': []}, 'skippedQuestions': ['Sections?'],
    }


def test_permission_answer_keeps_exact_rule_and_decision_durable(tmp_path):
    session = waiting_session(tmp_path, permission=True)
    with pytest.raises(ValueError):
        session.answer_user_input('ask-1', {'answers': {'Which format?': 'yes'}})
    event = session.answer_user_input('ask-1', {'decision': 'once'})
    assert event.data['pendingInput']['tool'] == 'Bash'
    assert event.data['pendingInput']['prefix'] == 'python report.py'
    assert event.data['response'] == {'decision': 'once'}
    assert event.data['pendingInput']['action'] == {'tool': 'Bash', 'arguments': {'command': 'python report.py --draft'}}


def test_ask_tool_preserves_multi_question_forms_and_option_descriptions():
    tool = register_ask_user_question(ToolRegistry())
    result = json.loads(tool.execute(questions=[{
        'header': 'Sections', 'question': 'Which sections?', 'multiSelect': True,
        'options': [{'label': 'Summary', 'description': 'Top lines'}, {'label': 'Details'}],
    }]))
    assert result['questions'][0]['options'][0]['description'] == 'Top lines'
    assert result['questions'][0]['multiSelect'] is True


def test_empty_continuation_does_not_add_a_synthetic_user_message():
    assert _first_messages(SimpleNamespace(user_input='', evidence_input=None)) == []


def test_real_loop_question_and_resume_preserve_tool_protocol(tmp_path):
    registry = ToolRegistry()
    register_ask_user_question(registry)
    session = FileSessionStore(tmp_path).create('agent-studio-new-real-loop')
    first = ScriptedBackend([
        ToolCallArrived(call=ToolCall(id='ask-real', name='AskUser', arguments={'question': 'Format?', 'options': ['Brief', 'Detailed']})),
        TurnDone(usage=None, raw_text=None),
    ])
    params = replace(make_params(registry=registry, client=LoopModelClient(first)), session=session)
    _, waiting = asyncio.run(collect(params))
    assert waiting.reason is TransitionReason.AWAITING_USER
    assert session.pending_user_input()['requestId'] == 'ask-real'
    session.answer_user_input('ask-real', {'answers': {'Format?': 'Detailed'}})
    second = ScriptedBackend([TurnDone(usage=None, raw_text='Ready')])
    asyncio.run(collect(replace(params, user_input='', client=LoopModelClient(second))))
    messages = second.received[0][0]
    user_messages = [message for message in messages if message.role is Role.USER and not message.injected]
    assert len(user_messages) == 1
    tool_answer = next(message for message in messages if message.tool_call_id == 'ask-real')
    assert json.loads(tool_answer.content)['answers'] == {'Format?': 'Detailed'}


@pytest.mark.parametrize('crash', [False, True])
def test_bridge_resumes_original_session_and_acknowledges_durable_answer(tmp_path, monkeypatch, crash):
    session = waiting_session(tmp_path)
    calls = []
    def run(user_input, **kwargs):
        calls.append(user_input)
        restored = kwargs['session']
        assert restored.id == session.id
        assert restored.pending_user_input() is None
        assert json.loads(restored.derive_messages()[-1].content)['answers'] == {'Which format?': 'Detailed'}
        if crash:
            raise RuntimeError('provider failed')
        return Terminal(reason=TransitionReason.COMPLETED, message='Report ready', turns=1, results=())
    _install_runtime_service_stubs(monkeypatch, session_store=FileSessionStore(tmp_path),
        registry=ToolRegistry(), compactor=lambda x, **kw: x,
        token_estimator=lambda x: 1, run_impl=run)
    payload = {'requestId': 'ask-1', 'response': {'answers': {'Which format?': 'Detailed'}}}
    result = conversation_bridge.answer_conversation('', [], {}, 'workspace-write',
        agent_session_id=session.id, input_response=payload)
    assert result['accepted'] is True
    assert calls == ['']
    duplicate = conversation_bridge.answer_conversation('', [], {}, 'workspace-write',
        agent_session_id=session.id, input_response=payload)
    assert duplicate['accepted'] is True
    assert duplicate['alreadyAccepted'] is True
    assert calls == ['']
