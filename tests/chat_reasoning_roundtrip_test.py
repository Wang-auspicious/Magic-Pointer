import json

from app.agent_runtime.model_client import _parse_sse, _provider_items, _messages_payload, TurnDone
from app.agent_runtime.types import AgentMessage, Role


def test_chat_thinking_survives_stream_fragments_and_tool_roundtrip():
    frames = [
        {'choices': [{'delta': {'reasoning_content': 'First '}}]},
        {'choices': [{'delta': {'reasoning_content': 'inspect.'}}]},
        {'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'r', 'function': {'name': 'Read', 'arguments': '{}'}}]}}]},
        {'choices': [{'delta': {}, 'finish_reason': 'tool_calls'}]},
    ]
    done = next(e for e in _parse_sse(['data: ' + json.dumps(f) for f in frames]) if isinstance(e, TurnDone))
    assert done.provider_items == ({'type': 'chat_reasoning', 'reasoning_content': 'First inspect.'},)
    message = AgentMessage(role=Role.ASSISTANT, content='', tool_call_id=None, name=None,
        tool_calls=({'id': 'r', 'name': 'Read', 'arguments': {}},), provider_items=done.provider_items)
    restored = AgentMessage.from_dict(message.to_dict())
    outgoing = _messages_payload('deepseek-v4.1-flash', [restored], [], 1000, 'chat-completions')
    assert outgoing['messages'][0]['reasoning_content'] == 'First inspect.'
    assert 'chat_reasoning' not in json.dumps(_messages_payload('claude-opus-4-6', [restored], [], 1000, 'messages'))
    assert 'chat_reasoning' not in json.dumps(_messages_payload('gpt', [restored], [], 1000, 'responses'))


def test_nonstream_chat_keeps_the_same_provider_reasoning_field():
    items = _provider_items({'choices': [{'message': {'role': 'assistant', 'reasoning_content': 'Inspect before writing.'}}]}, 'chat-completions')
    assert items == ({'type': 'chat_reasoning', 'reasoning_content': 'Inspect before writing.'},)
