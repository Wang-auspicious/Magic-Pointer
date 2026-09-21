from __future__ import annotations

from app.agent_runtime.effort import EFFORT_LEVELS, effort_instruction, normalize_effort


def test_effort_catalog_and_fallback() -> None:
    assert EFFORT_LEVELS == ("low", "medium", "high", "xhigh", "max")
    assert normalize_effort("xhigh") == "xhigh"
    assert normalize_effort(" XHIGH ") == "xhigh"
    assert normalize_effort("bogus") == "high"
    assert normalize_effort(None) == "high"


def test_each_effort_level_has_a_semantic_runtime_directive() -> None:
    directives = {level: effort_instruction(level) for level in EFFORT_LEVELS}

    assert all(directives.values())
    assert len(set(directives.values())) == len(EFFORT_LEVELS)
    assert "quick" in directives["low"].casefold()
    assert "balanced" in directives["high"].casefold()
    assert "thorough" in directives["xhigh"].casefold()
    assert "deepest available analysis" in directives["max"].casefold()


def test_messages_effort_uses_claude_model_capabilities():
    from app.agent_runtime.model_client import _messages_payload
    opus = _messages_payload('anthropic/claude-opus-4-6', [], [], 4096, 'messages', effort='max')
    assert opus['output_config'] == {'effort': 'max'}
    assert opus['thinking'] == {'type': 'adaptive'}
    sonnet = _messages_payload('claude-sonnet-4-6', [], [], 4096, 'messages', effort='max')
    assert sonnet['output_config'] == {'effort': 'high'}
    assert _messages_payload('claude-opus-4-6', [], [], 4096, 'messages', effort='xhigh')['output_config'] == {'effort': 'high'}
    assert 'output_config' not in _messages_payload('deepseek-v4.1-flash', [], [], 4096, 'messages', effort='max')


def test_messages_reasoning_signature_roundtrips_into_tool_history():
    import json
    from app.agent_runtime.model_client import _parse_messages_sse, _messages_payload, TurnDone
    from app.agent_runtime.types import AgentMessage, Role
    frames = [
        {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'thinking', 'thinking': ''}},
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'inspect first'}},
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'signature_delta', 'signature': 'signed-block'}},
        {'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'tool_use', 'id': 'read', 'name': 'Read', 'input': {}}},
        {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}},
    ]
    done = next(event for event in _parse_messages_sse(['data: ' + json.dumps(frame) for frame in frames]) if isinstance(event, TurnDone))
    assert done.provider_items == ({'type': 'thinking', 'thinking': 'inspect first', 'signature': 'signed-block'},)
    message = AgentMessage(role=Role.ASSISTANT, content='', tool_call_id=None, name=None, provider_items=done.provider_items,
        tool_calls=({'id': 'read', 'name': 'Read', 'arguments': {}},))
    payload = _messages_payload('claude-opus-4-6', [message], [], 4096, 'messages', effort='high')
    assert payload['messages'][0]['content'][0] == done.provider_items[0]
    assert payload['messages'][0]['content'][1]['type'] == 'tool_use'
