"""Engine loop path back-compat suite (harness batch 1, L1).

``app/fabric/engine.py`` gains an independent agent-loop entry
(``run_agent_turn``) that routes a command to a compiled recipe trajectory
(``route_to_trajectory``, recipe-as-cache) or runs the free loop, then drives
``run_agent_loop`` to ``Terminal``. The legacy ``FabricEngine.plan`` /
``plan_from_model`` / ``execute`` entries and their return shapes must stay
untouched (fabric_bridge and selection_bridge call them today).

Tests:

1. Legacy public entry regression: plan -> execute returns the same
   shape/receipt as before (monkeypatched-free, real engine on tmp root)
2. run_agent_turn free loop (no trajectory) answers directly with the
   default global registry; reason is a natural completion, not max_turns
3. run_agent_turn with a trajectory hit (compiler monkeypatched to a fixed
   trajectory) uses the trajectory first-message template
4. run_agent_turn composite intent: turn 1 calls two tools, turn 2 finishes;
   Terminal.results has length 2 and the message sequence is correct
5. Tool failure is fed back as an is_error tool message
6. max_turns fallback: a backend that always calls a tool terminates with
   Terminal(max_turns)
7. Cancellation: cancel_all_in_flight during the run propagates
   CancelledError out of run_agent_turn
8. Back-compat: run_agent_turn does not change legacy behavior (plan /
   plan_from_model still behave identically after a loop run)
9. objects are forwarded to routing as context, never as a match condition
10. injected clock is honored (budget exhaustion stops the loop without a
    second model call)

All tests inject fake model backends, fake clocks and fake pure-function
tools; nothing real is touched, no network, no desktop.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.errors import ActionFailure, FailureType  # noqa: E402
from app.agent_runtime.model_client import (  # noqa: E402
    LoopModelClient,
    ToolCallArrived,
    TurnDone,
)
from app.agent_runtime.tool_registry import (  # noqa: E402
    GLOBAL_REGISTRY,
    Effect,
    ToolRegistry,
    ToolSpec,
)
from app.agent_runtime.types import (  # noqa: E402
    Role,
    Terminal,
    ToolCall,
    Trajectory,
    TransitionReason,
)
from app.fabric.engine import (  # noqa: E402
    FabricEngine,
    provider_for_recipe,
    run_agent_turn,
)
from app.fabric.intent_router import get_trajectory_compiler  # noqa: E402
from app.governance.cancellation import (  # noqa: E402
    CancelledError,
    cancel_all_in_flight,
)

EMPTY_SCHEMA = {"type": "object", "properties": {}, "required": []}

FREE_LOOP_INPUT = "帮我把这段变成小红书文案"
"""Real no-match command: route_to_trajectory returns [] for it."""


class ScriptedBackend:
    """Injected ModelBackend: replays one canned event scene per turn."""

    def __init__(self, *scenes) -> None:
        self._scenes = list(scenes)
        self.received: list[tuple] = []

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.received.append((list(messages), list(tools), budget_ms, cancel_scope))
        if self._scenes:
            yield from self._scenes.pop(0)
        else:
            yield TurnDone(usage=None, raw_text=None)


class FakeClock:
    """Callable fake clock: manual elapsed-ms advance."""

    def __init__(self) -> None:
        self.elapsed = 0.0

    def __call__(self) -> float:
        return self.elapsed

    def advance(self, ms: float) -> None:
        self.elapsed += ms


def make_tool(
    name,
    value="ok",
    *,
    fail=None,
    on_call=None,
    schema=None,
    concurrency_safe=False,
):
    """ToolSpec with a counter; ``fail`` is a raised exception."""

    state = {"calls": 0}

    def execute(**kwargs):
        state["calls"] += 1
        if on_call is not None:
            on_call()
        if fail is not None:
            raise fail
        return value

    spec = ToolSpec(
        name=name,
        description=f"fake tool {name}",
        input_schema=schema or EMPTY_SCHEMA,
        execute=execute,
        effect=Effect.READ,
        used_backend="fake",
        is_concurrency_safe=concurrency_safe,
    )
    return spec, state


def _object(object_id: str = "obj-1", content: str = "Hello  123  456") -> dict:
    return {
        "id": object_id,
        "kind": "text",
        "label": "selected text",
        "content": content,
        "source": {"app": "test", "title": "Fixture"},
    }


def answering_client(text: str = "hi") -> LoopModelClient:
    return LoopModelClient(ScriptedBackend([TurnDone(usage=None, raw_text=text)]))


# ---------------------------------------------------------------------------
# 1. Legacy public entry regression
# ---------------------------------------------------------------------------


def test_legacy_plan_execute_behavior_unchanged(tmp_path: Path) -> None:
    clipboard = {"value": ""}
    engine = FabricEngine(
        root=tmp_path,
        clipboard_writer=lambda value: clipboard.__setitem__("value", value),
        clipboard_reader=lambda: clipboard["value"],
    )
    planned = engine.plan("把号码空格去掉再复制", objects=[_object()])
    assert planned["ok"] is True
    assert planned["plan"]["recipeId"] == "text.ocr_clean"
    assert planned["plan"]["requiresConfirmation"] is True

    skipped = engine.execute(planned["plan"], confirmed=False)
    assert skipped["status"] == "confirmation_required"

    receipt = engine.execute(planned["plan"], confirmed=True)
    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
    assert clipboard["value"] == "Hello123456"

    assert provider_for_recipe("text.ocr_copy") == "clipboard"


# ---------------------------------------------------------------------------
# 2. run_agent_turn free loop
# ---------------------------------------------------------------------------


def test_run_agent_turn_free_loop_answers_directly() -> None:
    backend = ScriptedBackend([TurnDone(usage=None, raw_text="可以，改好了")])
    client = LoopModelClient(backend)

    terminal = run_agent_turn(FREE_LOOP_INPUT, registry=GLOBAL_REGISTRY, client=client)

    assert isinstance(terminal, Terminal)
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.reason not in {
        TransitionReason.MAX_TURNS,
        TransitionReason.BUDGET_EXHAUSTED,
    }
    assert terminal.turns == 1
    assert terminal.message == "可以，改好了"
    assert terminal.results == ()
    assert len(backend.received) == 1
    first_messages = backend.received[0][0]
    assert [m.role for m in first_messages] == [Role.USER]
    assert first_messages[0].content == FREE_LOOP_INPUT


# ---------------------------------------------------------------------------
# 3. run_agent_turn with a trajectory
# ---------------------------------------------------------------------------


def test_run_agent_turn_trajectory_uses_template_first_message(monkeypatch) -> None:
    compiler = get_trajectory_compiler()
    fixed = Trajectory(
        recipe_id="text.ocr_copy",
        first_user_message="目标：把这段文字复制出来。对象：{input}",
        recommended_tools=(),
        max_turns=3,
        risk="read",
    )
    monkeypatch.setattr(
        compiler,
        "match_keywords",
        lambda text, lang="zh": [("text.ocr_copy", 1.0)],
    )
    monkeypatch.setattr(
        compiler,
        "compile_trajectory",
        lambda recipe_id: fixed if recipe_id == "text.ocr_copy" else None,
    )

    backend = ScriptedBackend([TurnDone(usage=None, raw_text="复制好了")])
    client = LoopModelClient(backend)

    terminal = run_agent_turn(
        "执行固定模板任务", registry=GLOBAL_REGISTRY, client=client
    )

    assert terminal.reason is TransitionReason.COMPLETED
    first_messages = backend.received[0][0]
    assert len(first_messages) == 1
    assert first_messages[0].role is Role.USER
    assert first_messages[0].content == "目标：把这段文字复制出来。对象：执行固定模板任务"


# ---------------------------------------------------------------------------
# 4. Composite intent: two tools then finish
# ---------------------------------------------------------------------------


def test_run_agent_turn_two_tools_then_finish() -> None:
    add, add_state = make_tool("add", value=3)
    mul, mul_state = make_tool("mul", value=12)
    registry = ToolRegistry()
    registry.register(add)
    registry.register(mul)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="add", arguments={})),
            ToolCallArrived(call=ToolCall(id="c2", name="mul", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="计算完成")],
    )
    client = LoopModelClient(backend)

    terminal = run_agent_turn(FREE_LOOP_INPUT, registry=registry, client=client)

    assert add_state["calls"] == 1
    assert mul_state["calls"] == 1
    assert terminal.turns == 2
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "计算完成"
    assert len(terminal.results) == 2
    assert [r.tool_call_id for r in terminal.results] == ["c1", "c2"]
    assert [r.value for r in terminal.results] == ["3", "12"]
    first_messages = backend.received[0][0]
    second_messages = backend.received[1][0]
    assert [m.role for m in first_messages] == [Role.USER]
    assert [m.role for m in second_messages] == [Role.USER, Role.TOOL, Role.TOOL]
    assert [m.name for m in second_messages[1:]] == ["add", "mul"]


# ---------------------------------------------------------------------------
# 5. Tool failure feeds back an is_error message
# ---------------------------------------------------------------------------


def test_run_agent_turn_tool_failure_is_error_fed_back() -> None:
    flaky, state = make_tool(
        "flaky",
        fail=ActionFailure(FailureType.TIMEOUT, "worker busy", recovery_hint="retry"),
    )
    registry = ToolRegistry()
    registry.register(flaky)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="flaky", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="重试成功")],
    )
    client = LoopModelClient(backend)

    terminal = run_agent_turn(FREE_LOOP_INPUT, registry=registry, client=client)

    assert state["calls"] == 1
    second_messages = backend.received[1][0]
    assert second_messages[1].role is Role.TOOL
    assert second_messages[1].is_error is True
    assert "worker busy" in second_messages[1].content
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.TIMEOUT
    assert terminal.reason is TransitionReason.COMPLETED


# ---------------------------------------------------------------------------
# 6. max_turns fallback
# ---------------------------------------------------------------------------


def test_run_agent_turn_max_turns_ceiling() -> None:
    tool, _ = make_tool("loop_tool", value="x")
    registry = ToolRegistry()
    registry.register(tool)
    scenes = [
        [ToolCallArrived(call=ToolCall(id=f"c{i}", name="loop_tool", arguments={})), TurnDone(usage=None, raw_text=None)]
        for i in range(1, 7)
    ]
    client = LoopModelClient(ScriptedBackend(*scenes))

    terminal = run_agent_turn(FREE_LOOP_INPUT, registry=registry, client=client)

    assert terminal.reason is TransitionReason.MAX_TURNS
    assert terminal.turns == 6
    assert len(terminal.results) == 6
    assert [r.tool_call_id for r in terminal.results] == [f"c{i}" for i in range(1, 7)]


# ---------------------------------------------------------------------------
# 7. Cancellation propagates CancelledError
# ---------------------------------------------------------------------------


def test_run_agent_turn_cancel_all_in_flight_propagates() -> None:
    cancelling, state = make_tool(
        "cancel_me", value="x", on_call=cancel_all_in_flight
    )
    registry = ToolRegistry()
    registry.register(cancelling)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="cancel_me", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="never reached")],
    )
    client = LoopModelClient(backend)

    with pytest.raises(CancelledError):
        run_agent_turn(FREE_LOOP_INPUT, registry=registry, client=client)

    assert state["calls"] == 1
    assert len(backend.received) == 1


# ---------------------------------------------------------------------------
# 8. Back-compat: run_agent_turn leaves legacy behavior untouched
# ---------------------------------------------------------------------------


def test_run_agent_turn_does_not_alter_legacy_behavior(tmp_path: Path) -> None:
    terminal = run_agent_turn(
        FREE_LOOP_INPUT, registry=GLOBAL_REGISTRY, client=answering_client()
    )
    assert terminal.turns == 1

    clipboard = {"value": ""}
    engine = FabricEngine(
        root=tmp_path,
        clipboard_writer=lambda value: clipboard.__setitem__("value", value),
        clipboard_reader=lambda: clipboard["value"],
    )
    planned = engine.plan("把号码空格去掉再复制", objects=[_object()])
    assert planned["ok"] is True
    assert planned["plan"]["recipeId"] == "text.ocr_clean"
    receipt = engine.execute(planned["plan"], confirmed=True)
    assert receipt["status"] == "succeeded"
    assert clipboard["value"] == "Hello123456"

    multi_tool = engine.plan_from_model(
        {
            "intent": "复制并整理",
            "targetObjectIds": ["obj-1"],
            "requestedResult": "",
            "toolCalls": [
                {"tool": "copy_text", "arguments": {}},
                {"tool": "clean_ocr_text", "arguments": {}},
            ],
            "riskLevel": "local_write",
            "needsConfirmation": False,
            "expectedVerification": "",
        },
        objects=[_object()],
    )
    assert multi_tool["ok"] is False
    assert multi_tool["error"] == "multi_tool_plan_not_supported"
    assert multi_tool["toolCount"] == 2


def test_run_agent_turn_default_registry_is_populated_with_fabric_tools() -> None:
    terminal = run_agent_turn(FREE_LOOP_INPUT, client=answering_client())

    assert terminal.turns == 1
    assert terminal.reason is TransitionReason.COMPLETED
    assert len(GLOBAL_REGISTRY.list()) >= 18
    names = {spec.name for spec in GLOBAL_REGISTRY.list()}
    assert "clipboard_history" in names
    assert "agent_handoff" in names
    assert "memory_recall" in names


# ---------------------------------------------------------------------------
# 9. objects are routing context
# ---------------------------------------------------------------------------


def test_run_agent_turn_forwards_objects_to_routing(monkeypatch) -> None:
    recorded: list[tuple] = []

    def fake_route(text, objects=None, lang="zh"):
        recorded.append((text, objects, lang))
        return []

    monkeypatch.setattr("app.fabric.engine.route_to_trajectory", fake_route)
    objects = [{"id": "obj-9", "kind": "text"}]

    terminal = run_agent_turn(
        "带对象的问题", objects=objects, registry=GLOBAL_REGISTRY, client=answering_client()
    )

    assert recorded == [("带对象的问题", objects, "zh")]
    assert terminal.turns == 1


# ---------------------------------------------------------------------------
# 10. injected clock is honored
# ---------------------------------------------------------------------------


def test_run_agent_turn_injected_clock_stops_on_budget() -> None:
    clock = FakeClock()
    slow, _ = make_tool(
        "slow_tool", value="x", on_call=lambda: clock.advance(10_000)
    )
    registry = ToolRegistry()
    registry.register(slow)
    backend = ScriptedBackend(
        [
            ToolCallArrived(call=ToolCall(id="c1", name="slow_tool", arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="too late")],
    )
    client = LoopModelClient(backend)

    terminal = run_agent_turn(
        FREE_LOOP_INPUT, registry=registry, client=client, clock=clock
    )

    assert len(backend.received) == 1
    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED
    assert terminal.turns == 1
    assert len(terminal.results) == 1
