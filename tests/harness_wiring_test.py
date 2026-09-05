"""Wiring-batch integration tests (review 2026-08-13 Q9).

Covers the seams the review called out:
(a) loop x guard factory (fail-closed + passing chain),
(b) loop x permission mode (already partly in loop tests; here the
    capability in-loop write path end to end),
(c) streaming backend auto-fallback (HTTP failure + empty SSE),
(d) evidence hard fence + explicit truncation + gesture-centered window,
(e) a scripted fake model running the full loop chain over the real
    capability registry, asserting final answer + proposal shape.

Nothing real is called: no network, no desktop, no probe.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import ai_client  # noqa: E402
from app.action_guard.guard_factory import (  # noqa: E402
    anchor_from_arguments,
    build_context_factory,
)
from app.action_guard.preconditions import (  # noqa: E402
    ContentUnchanged,
    PreconditionContext,
    ResolvedExact,
    TargetFocused,
)
from app.agent_runtime.loop import LoopParams, run_agent_loop  # noqa: E402
from app.agent_runtime.model_client import (  # noqa: E402
    LoopModelClient,
    MessageDelta,
    StreamingMessagesBackend,
    ToolCallArrived,
    TurnDone,
    TurnWithheld,
)
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec  # noqa: E402
from app.agent_runtime.types import Role, Terminal, ToolCall  # noqa: E402
from app.anchor import AppIdentity, ResolutionExact, ResolutionGone  # noqa: E402
from app.anchor.anchor import Anchor  # noqa: E402

EMPTY_SCHEMA = {"type": "object", "properties": {}, "required": []}


class ScriptedBackend:
    def __init__(self, *scenes) -> None:
        self._scenes = list(scenes)
        self.received: list[tuple] = []

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.received.append((list(messages), list(tools), budget_ms, cancel_scope))
        if self._scenes:
            yield from self._scenes.pop(0)
        else:
            yield TurnDone(usage=None, raw_text=None)


async def _collect(params: LoopParams):
    events = []
    generator = run_agent_loop(params)
    while True:
        try:
            events.append(await generator.__anext__())
        except StopAsyncIteration:
            break
    return events, events[-1].terminal


def _anchor() -> Anchor:
    return Anchor(
        anchor_id="a1",
        app_identity=AppIdentity(process_name="notepad.exe"),
        content_hash="h1",
        captured_at_utc="2026-08-13T00:00:00Z",
    )


class FakeProbe:
    """Guard probe over a fixed scene."""

    def __init__(self, *, exact: bool = True, focused: bool = True, hash_match: bool = True) -> None:
        self.exact = exact
        self.focused = focused
        self.hash_match = hash_match

    def resolve_anchor(self, anchor):
        if not self.exact:
            return ResolutionGone(anchor=anchor, reason="window_not_visible")
        return ResolutionExact(anchor=anchor, evidence=("hwnd=1",))

    def is_focused(self, anchor):
        return self.focused

    def content_hash_at(self, anchor):
        return "h1" if self.hash_match else "changed"

    def modal_seen_since(self, anchor):
        return None


def _guarded_tool(factory) -> ToolSpec:
    state = {"calls": 0}

    def execute(**kwargs):
        state["calls"] += 1
        return "done"

    return ToolSpec(
        name="guarded_write",
        description="guarded write tool",
        input_schema=EMPTY_SCHEMA,
        execute=execute,
        effect=Effect.REVERSIBLE_WRITE,
        used_backend="fake",
        preconditions=(ResolvedExact(), TargetFocused(), ContentUnchanged()),
    ), state


def _params(registry, client, factory=None) -> LoopParams:
    return LoopParams(
        user_input="写",
        registry=registry,
        client=client,
        precondition_context_factory=factory,
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE),
    )


def test_guard_chain_executes_when_all_guards_pass():
    import asyncio

    factory = build_context_factory(
        FakeProbe(), lambda args: anchor_from_arguments(args, fallback_anchor=_anchor())
    )
    spec, state = _guarded_tool(factory)
    registry = ToolRegistry()
    registry.register(spec)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="guarded_write", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="ok")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(_collect(_params(registry, client, factory)))

    assert state["calls"] == 1
    assert terminal.results[0].is_error is False
    assert terminal.reason.value == "completed"


def test_guard_chain_fails_closed_when_anchor_missing():
    import asyncio

    factory = build_context_factory(
        FakeProbe(), lambda args: None  # no fallback anchor extractable
    )
    spec, state = _guarded_tool(factory)
    registry = ToolRegistry()
    registry.register(spec)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="guarded_write", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="ok")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(_collect(_params(registry, client, factory)))

    assert state["calls"] == 0
    assert terminal.results[0].is_error is True
    assert terminal.results[0].failure_type == "permission_denied"
    assert "fail closed" in terminal.results[0].value


def test_guarded_tool_fails_closed_when_context_factory_is_not_wired():
    import asyncio

    spec, state = _guarded_tool(None)
    registry = ToolRegistry()
    registry.register(spec)
    backend = ScriptedBackend(
        [
            ToolCallArrived(
                call=ToolCall(id="c1", name="guarded_write", arguments={})
            ),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="ok")],
    )

    _events, terminal = asyncio.run(
        _collect(_params(registry, LoopModelClient(backend), factory=None))
    )

    assert state["calls"] == 0
    assert terminal.results[0].is_error is True
    assert terminal.results[0].failure_type == "permission_denied"
    assert "not configured" in terminal.results[0].value


def test_guard_chain_blocks_when_content_changed():
    import asyncio

    factory = build_context_factory(
        FakeProbe(hash_match=False),
        lambda args: anchor_from_arguments(args, fallback_anchor=_anchor()),
    )
    spec, state = _guarded_tool(factory)
    registry = ToolRegistry()
    registry.register(spec)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="guarded_write", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="ok")],
    )
    client = LoopModelClient(backend)

    events, terminal = asyncio.run(_collect(_params(registry, client, factory)))

    assert state["calls"] == 0
    assert terminal.results[0].failure_type == "content_changed"


class FakeStreamResponse:
    def __init__(self, status_code: int, lines: list[str]) -> None:
        self.status_code = status_code
        self._lines = lines

    def iter_lines(self):
        return iter(self._lines)


class FakeStreamClient:
    """Stubbed httpx client factory: first call streams, later calls post."""

    def __init__(self, calls: list, stream_response: FakeStreamResponse) -> None:
        self._calls = calls
        self._stream_response = stream_response

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def stream(self, method, url, *, headers, json):
        self._calls.append({"method": "stream", "url": url, "json": json})
        return _StreamContext(self._stream_response)

    def post(self, url, *, headers, json):
        self._calls.append({"method": "post", "url": url, "json": json})
        return FakePostResponse(200, {
            "choices": [{"message": {"content": "fallback answer"}}]
        })


class _StreamContext:
    def __init__(self, response: FakeStreamResponse) -> None:
        self._response = response

    def __enter__(self):
        return self._response

    def __exit__(self, *_args):
        return None


class FakePostResponse:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = "fake"

    def json(self):
        return self._payload


def _streaming_backend(calls, stream_response) -> StreamingMessagesBackend:
    backend = StreamingMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._client_factory = (  # type: ignore[attr-defined]
        lambda timeout: FakeStreamClient(calls, stream_response)
    )
    return backend


def _stream_config(monkeypatch):
    monkeypatch.setattr(
        ai_client,
        "get_ai_config",
        lambda: ("key", "https://gateway.example/v1", "text-model"),
    )
    monkeypatch.setattr(ai_client, "short_circuit_message", lambda _base_url=None: None)


def _user(content: str):
    return __import__("app.agent_runtime.types", fromlist=["AgentMessage"]).AgentMessage(
        role=Role.USER, content=content, tool_call_id=None, name=None
    )


def test_streaming_backend_falls_back_on_http_error(monkeypatch):
    _stream_config(monkeypatch)
    calls: list = []
    backend = _streaming_backend(calls, FakeStreamResponse(400, []))

    events = list(backend.generate([_user("hi")], [], budget_ms=3000))

    assert [call["method"] for call in calls] == ["stream", "stream", "post"]
    assert calls[0]["json"]["reasoning_effort"] == "high"
    assert "reasoning_effort" not in calls[1]["json"]
    text = "".join(e.text for e in events if isinstance(e, MessageDelta))
    assert text == "fallback answer"


def test_streaming_backend_falls_back_on_empty_sse(monkeypatch):
    """A gateway that ignores stream:true returns plain JSON -> fallback."""
    _stream_config(monkeypatch)
    calls: list = []
    lines = ['data: {"choices":[]}']  # no delta frames at all
    backend = _streaming_backend(calls, FakeStreamResponse(200, lines))

    events = list(backend.generate([_user("hi")], [], budget_ms=3000))

    assert [call["method"] for call in calls] == ["stream", "post"]
    text = "".join(e.text for e in events if isinstance(e, MessageDelta))
    assert text == "fallback answer"


def test_streaming_fallback_uses_only_remaining_request_budget(monkeypatch):
    _stream_config(monkeypatch)
    calls: list = []
    timeouts: list[float] = []
    ticks = iter((100.0, 102.0))
    monkeypatch.setattr(
        "app.agent_runtime.model_client.time.monotonic",
        lambda: next(ticks),
    )
    backend = StreamingMessagesBackend(timeout_s=5.0, max_tokens=120)

    def client_factory(timeout):
        timeouts.append(timeout)
        return FakeStreamClient(calls, FakeStreamResponse(400, []))

    backend._client_factory = client_factory  # type: ignore[attr-defined]

    events = list(backend.generate([_user("hi")], [], budget_ms=3000))

    assert [call["method"] for call in calls] == ["stream", "stream", "post"]
    assert timeouts == [3.0, 3.0, 1.0]
    assert any(isinstance(event, MessageDelta) for event in events)


def test_streaming_backend_keeps_streamed_text(monkeypatch):
    _stream_config(monkeypatch)
    calls: list = []
    successes: list[tuple[str, str]] = []
    monkeypatch.setattr(
        ai_client,
        "record_success",
        lambda *, model, base_url: successes.append((model, base_url)),
    )
    lines = [
        'data: {"choices":[{"delta":{"content":"你"}, "finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"好"}, "finish_reason":"stop"}]}',
        "data: [DONE]",
    ]
    backend = _streaming_backend(calls, FakeStreamResponse(200, lines))

    events = list(backend.generate([_user("hi")], [], budget_ms=3000))

    assert [call["method"] for call in calls] == ["stream"]
    text = "".join(e.text for e in events if isinstance(e, MessageDelta))
    assert text == "你好"
    assert successes == [("text-model", "https://gateway.example/v1")]


def test_streaming_backend_never_replays_after_committed_text(monkeypatch):
    _stream_config(monkeypatch)
    calls: list = []

    class BreakingStreamResponse:
        status_code = 200

        def iter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"first"}}]}'
            raise OSError("socket broke after first token")

    backend = _streaming_backend(calls, BreakingStreamResponse())
    events = list(backend.generate([_user("hi")], [], budget_ms=3000))

    assert [call["method"] for call in calls] == ["stream"]
    assert "".join(
        event.text for event in events if isinstance(event, MessageDelta)
    ) == "first"
    assert [
        event.reason for event in events if type(event).__name__ == "TurnWithheld"
    ] == ["backend_error:OSError"]
    assert isinstance(events[-1], TurnDone)


def test_committed_stream_error_is_not_recorded_as_endpoint_success(monkeypatch):
    _stream_config(monkeypatch)
    successes: list[tuple[str, str]] = []
    monkeypatch.setattr(
        ai_client,
        "record_success",
        lambda *, model, base_url: successes.append((model, base_url)),
    )
    backend = StreamingMessagesBackend(timeout_s=5.0, max_tokens=120)
    backend._post_streaming = lambda *args, **kwargs: iter((  # type: ignore[method-assign]
        MessageDelta("first"),
        TurnWithheld(reason="backend_error:stream_error"),
        TurnDone(usage=None, raw_text="first"),
    ))

    events = list(backend.generate([_user("hi")], [], budget_ms=3000))

    assert any(type(event).__name__ == "TurnWithheld" for event in events)
    assert successes == []


def test_streaming_token_limit_reaches_agent_recovery_without_http_fallback(
    monkeypatch,
):
    _stream_config(monkeypatch)
    calls: list = []
    lines = [
        'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        "data: [DONE]",
    ]
    backend = _streaming_backend(calls, FakeStreamResponse(200, lines))

    events = list(backend.generate([_user("hi")], [], budget_ms=3000))

    assert [call["method"] for call in calls] == ["stream"]
    assert [
        event.reason for event in events if type(event).__name__ == "TurnWithheld"
    ] == ["max_output_tokens"]


def test_scripted_model_end_to_end_over_real_capability_registry():
    """Golden path: a scripted fake model runs the full loop over the real
    capability registry, proposes translate, then answers (review Q9b)."""
    import asyncio

    from app.fabric.capability_tools import register_capability_tools

    proposals: list = []

    def propose(recipe_id, args):
        proposals.append((recipe_id, args))
        return {
            "ok": True,
            "recipeId": recipe_id,
            "requiresConfirmation": True,
            "plan": {
                "id": "plan-1",
                "recipeId": recipe_id,
                "command": "翻译",
                "risk": "local_write",
                "provider": "model.text",
                "objectIds": ["o1"],
                "parameters": dict(args or {}),
                "preview": {"title": "原位翻译"},
                "requiresConfirmation": True,
                "idempotencyKey": "k1",
                "integrityToken": "t1",
            },
        }

    registry = ToolRegistry()
    register_capability_tools(registry, propose)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(
                id="c1",
                name="text_transform",
                arguments={"operation": "translate", "language": "英文"},
            )),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="已生成翻译方案。")],
    )
    client = LoopModelClient(backend)
    params = LoopParams(
        user_input="把这段翻译成英文",
        registry=registry,
        client=client,
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE),
    )

    events, terminal = asyncio.run(_collect(params))

    assert terminal.reason.value == "completed"
    assert terminal.message == "已生成翻译方案。"
    assert len(terminal.results) == 1
    payload = json.loads(terminal.results[0].value)
    assert payload["ok"] is True
    assert payload["recipeId"] == "text.translate_in_place"
    assert payload["plan"]["id"] == "plan-1"
    assert proposals == [("text.translate_in_place", {"language": "英文"})]


def test_inloop_reversible_executes_via_execute_plan_under_guards():
    """In-loop write path: REVERSIBLE_WRITE tool + passing guards -> execute_plan."""
    import asyncio

    from app.fabric.capability_tools import register_capability_tools

    receipts: list = []

    def execute_plan(recipe_id, args):
        receipts.append((recipe_id, args))
        return {"status": "executed", "verified": True, "recipeId": recipe_id}

    registry = ToolRegistry()
    register_capability_tools(
        registry,
        lambda *a: {"ok": True},
        execute_plan=execute_plan,
        inloop_reversible=True,
    )
    factory = build_context_factory(
        FakeProbe(), lambda args: anchor_from_arguments(args, fallback_anchor=_anchor())
    )
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(
                id="c1",
                name="text_transform",
                arguments={"operation": "rewrite", "style": "更简洁"},
            )),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )
    client = LoopModelClient(backend)
    params = LoopParams(
        user_input="改写",
        registry=registry,
        client=client,
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE),
        precondition_context_factory=factory,
    )

    events, terminal = asyncio.run(_collect(params))

    assert terminal.results[0].is_error is False
    payload = json.loads(terminal.results[0].value)
    assert payload["status"] == "executed"
    assert receipts == [("text.rewrite_in_place", {"style": "更简洁"})]
