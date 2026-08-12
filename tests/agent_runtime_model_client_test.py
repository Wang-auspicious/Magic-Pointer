"""Tests for the agent runtime loop model client (plan T2.3).

Covers, per plan and the CC query-loop / Pi agent-loop port notes:
- ModelTurnEvent union: TurnStarted / MessageDelta / ToolCallArrived /
  TurnDone / TurnWithheld / ModelUnsupported
- LoopModelClient.generate_turn consumes the backend generator and returns
  every event untouched; TurnWithheld is passed through as-is with a
  cumulative count (CC withhold-until-recover: withheld is a recovery
  signal, not a failure; the loop layer owns the retry ceiling)
- parse_tool_calls extracts tool calls + final text; malformed arguments
  JSON is recorded into the errors list without raising
- Pi StreamFn truncation guard: text ending with the configurable suffix
  plus tool calls marks truncated=True so the caller can discard the calls
- ModelUnsupported propagates as an event, never as a fake request
- empty tools list is forwarded to the backend as-is
- AiClientBackend real mapping is verified against a stubbed
  app.ai_client.ask_text_model_with_tools (no network): success -> events,
  backend error -> TurnWithheld

All tests inject fake backends; nothing real is touched, no network.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import ai_client as real_ai_client  # noqa: E402
from app.agent_runtime.errors import MAX_OUTPUT_TOKENS_RECOVERY_LIMIT  # noqa: E402
from app.agent_runtime.model_client import (  # noqa: E402
    AiClientBackend,
    LoopModelClient,
    MessageDelta,
    ModelTurnEvent,
    ModelUnsupported,
    ToolCallArrived,
    TurnDone,
    TurnStarted,
    TurnWithheld,
)
from app.agent_runtime.types import AgentMessage, Role, ToolCall  # noqa: E402

USER_MSG = AgentMessage(
    role=Role.USER, content="find the button", tool_call_id=None, name=None
)
TOOLS = [
    {
        "name": "grep",
        "description": "search the screen",
        "parameters": {"type": "object", "properties": {}},
    }
]


class FakeBackend:
    """Injected ModelBackend: replays canned events, records what it saw."""

    def __init__(self, *events: ModelTurnEvent) -> None:
        self._events = events
        self.received: list[tuple] = []

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.received.append((messages, tools, budget_ms, cancel_scope))
        yield from self._events


def make_call(call_id: str = "c1", name: str = "grep", arguments: object = None):
    return ToolCall(id=call_id, name=name, arguments=arguments or {})


def test_generate_turn_collects_events_and_usage():
    call1 = make_call("c1", "grep", {"q": "x"})
    call2 = make_call("c2", "ls", {"path": "/tmp"})
    client = LoopModelClient(
        FakeBackend(
            ToolCallArrived(call1),
            ToolCallArrived(call2),
            TurnDone(usage={"total_tokens": 42}, raw_text="done"),
        )
    )

    events = client.generate_turn([USER_MSG], TOOLS)

    assert events == [
        ToolCallArrived(call1),
        ToolCallArrived(call2),
        TurnDone(usage={"total_tokens": 42}, raw_text="done"),
    ]
    calls, text = client.parse_tool_calls(events)
    assert calls == [call1, call2]
    assert text == "done"
    assert client.last_usage == {"total_tokens": 42}


def test_parse_tool_calls_concatenates_deltas_and_prefers_them_over_raw_text():
    client = LoopModelClient(
        FakeBackend(
            MessageDelta("let me "),
            MessageDelta("check"),
            ToolCallArrived(make_call("c1", "grep", {"q": "x"})),
            TurnDone(usage=None, raw_text="streamed-variant"),
        )
    )

    calls, text = client.parse_tool_calls(client.generate_turn([USER_MSG], TOOLS))

    assert [c.name for c in calls] == ["grep"]
    assert text == "let me check"


def test_parse_tool_calls_parses_json_string_arguments():
    raw_call = ToolCall(id="c1", name="grep", arguments='{"q": "x"}')
    client = LoopModelClient(
        FakeBackend(ToolCallArrived(raw_call), TurnDone(usage=None, raw_text=None))
    )

    calls, text = client.parse_tool_calls(client.generate_turn([USER_MSG], TOOLS))

    assert calls == [ToolCall(id="c1", name="grep", arguments={"q": "x"})]
    assert text is None
    assert client.last_errors == []


def test_malformed_arguments_json_recorded_not_raised():
    good = make_call("c1", "grep", {"q": "x"})
    bad = ToolCall(id="c2", name="ls", arguments="{bad json")
    client = LoopModelClient(
        FakeBackend(ToolCallArrived(good), ToolCallArrived(bad), TurnDone(None, None))
    )

    calls, text = client.parse_tool_calls(client.generate_turn([USER_MSG], TOOLS))

    assert calls == [good]
    assert text is None
    assert len(client.last_errors) == 1
    assert "c2" in client.last_errors[0]
    assert "malformed" in client.last_errors[0]


def test_parse_tool_calls_rejects_non_object_arguments_fail_closed():
    client = LoopModelClient(
        FakeBackend(
            ToolCallArrived(make_call("c1", "grep", [1, 2])),
            TurnDone(None, None),
        )
    )

    calls, _ = client.parse_tool_calls(client.generate_turn([USER_MSG], TOOLS))

    assert calls == []
    assert len(client.last_errors) == 1


def test_withheld_events_pass_through_with_cumulative_count():
    client = LoopModelClient(
        FakeBackend(TurnWithheld("max_output_tokens"), TurnDone(None, None))
    )

    events = client.generate_turn([USER_MSG], TOOLS)

    assert events == [TurnWithheld("max_output_tokens"), TurnDone(None, None)]
    assert client.withheld_count == 1

    client.generate_turn([USER_MSG], TOOLS)
    assert client.withheld_count == 2

    for _ in range(MAX_OUTPUT_TOKENS_RECOVERY_LIMIT):
        client.generate_turn([USER_MSG], TOOLS)
    assert client.withheld_count == 2 + MAX_OUTPUT_TOKENS_RECOVERY_LIMIT


def test_truncation_marker_true_when_suffix_and_tool_calls():
    client = LoopModelClient(
        FakeBackend(
            MessageDelta("let me call the tool…"),
            ToolCallArrived(make_call("c1", "grep")),
            TurnDone(None, "let me call the tool…"),
        )
    )

    client.parse_tool_calls(client.generate_turn([USER_MSG], TOOLS))

    assert client.last_truncated is True


def test_truncation_marker_false_when_no_suffix():
    client = LoopModelClient(
        FakeBackend(
            MessageDelta("done"),
            ToolCallArrived(make_call("c1", "grep")),
            TurnDone(None, "done"),
        )
    )

    client.parse_tool_calls(client.generate_turn([USER_MSG], TOOLS))

    assert client.last_truncated is False


def test_truncation_marker_false_when_no_tool_calls():
    client = LoopModelClient(
        FakeBackend(MessageDelta("ends with the marker…"), TurnDone(None, None))
    )

    client.parse_tool_calls(client.generate_turn([USER_MSG], TOOLS))

    assert client.last_truncated is False


def test_truncation_suffix_is_configurable_and_none_disables_guard():
    text = "output cut[TRUNC]"
    truncated_client = LoopModelClient(
        FakeBackend(
            MessageDelta(text),
            ToolCallArrived(make_call("c1", "grep")),
            TurnDone(None, text),
        ),
        truncation_suffix="[TRUNC]",
    )
    truncated_client.parse_tool_calls(
        truncated_client.generate_turn([USER_MSG], TOOLS)
    )
    assert truncated_client.last_truncated is True

    disabled_client = LoopModelClient(
        FakeBackend(
            MessageDelta(text),
            ToolCallArrived(make_call("c1", "grep")),
            TurnDone(None, text),
        ),
        truncation_suffix=None,
    )
    disabled_client.parse_tool_calls(disabled_client.generate_turn([USER_MSG], TOOLS))
    assert disabled_client.last_truncated is False


def test_model_unsupported_propagates_as_event():
    client = LoopModelClient(
        FakeBackend(ModelUnsupported("backend_lacks_tool_protocol"))
    )

    events = client.generate_turn([USER_MSG], TOOLS)

    assert events == [ModelUnsupported("backend_lacks_tool_protocol")]
    assert client.last_usage is None
    assert client.withheld_count == 0


def test_empty_tools_forwarded_to_backend():
    backend = FakeBackend(TurnStarted(), TurnDone(None, None))
    client = LoopModelClient(backend)

    client.generate_turn([USER_MSG], [])

    _, tools, _, _ = backend.received[-1]
    assert tools == []


def test_ai_client_backend_maps_real_tools_result(monkeypatch):
    def stub(user_prompt, **kwargs):
        assert kwargs["tools"] is not None
        return {
            "text": "found it",
            "toolCalls": [{"name": "grep", "arguments": {"q": "button"}}],
            "error": "",
        }

    monkeypatch.setattr(real_ai_client, "ask_text_model_with_tools", stub)

    events = list(
        AiClientBackend().generate(
            [USER_MSG], TOOLS, budget_ms=5000.0, cancel_scope=None
        )
    )

    assert isinstance(events[0], TurnStarted)
    arrived = [e for e in events if isinstance(e, ToolCallArrived)]
    assert len(arrived) == 1
    assert arrived[0].call.name == "grep"
    assert arrived[0].call.arguments == {"q": "button"}
    done = [e for e in events if isinstance(e, TurnDone)]
    assert len(done) == 1
    assert done[0].raw_text == "found it"
    assert done[0].usage is None


def test_ai_client_backend_error_becomes_withheld(monkeypatch):
    def stub(user_prompt, **kwargs):
        return {"text": "", "toolCalls": [], "error": "model_request_timeout"}

    monkeypatch.setattr(real_ai_client, "ask_text_model_with_tools", stub)

    events = list(AiClientBackend().generate([USER_MSG], TOOLS))

    assert isinstance(events[0], TurnStarted)
    assert events[1] == TurnWithheld("backend_error:model_request_timeout")
    assert isinstance(events[2], TurnDone)
    assert events[2].raw_text is None
