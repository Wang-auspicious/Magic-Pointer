"""End-to-end integration tests: agent loop + fabric tool registry (T5.2).

Simulates the composite task "圈选段落 → 扩写 → 翻译 → 写回" over the real
loop interpreter (:func:`app.agent_runtime.loop.run_agent_loop`) and the real
engine entry (:func:`app.fabric.engine.run_agent_turn`), proving the loop
feeds tool results back to the model, converges over multiple rounds and
delivers the right artifacts.

Scenarios:

1. Four-step tool chain: Around -> selection_expand -> translate_in_place
   -> final text. The fake model verifies each tool result's content before
   deciding the next step (a missed result fails the test).
2. Trajectory-driven: ``route_to_trajectory`` is monkeypatched to a fixed
   ``text.rewrite_in_place`` trajectory; ``run_agent_turn`` seeds the first
   round with the trajectory template and recommends its tools first.
3. Failure recovery: ``Around`` raises ActionFailure(TIMEOUT) once; the
   model sees the is_error tool message and retries successfully; the loop
   survives.
4. Honest write-back failure: ``translate_in_place`` fails with
   content_changed; the Terminal carries the failure and the loop does not
   pretend success.
5. Budget-truncated delivery: the fake clock blows the FULL_ANSWER budget
   mid-run; Terminal(budget_exhausted) still preserves completed results.
6. Cancellation generation: cancel_all_in_flight during round 2 raises
   CancelledError and no further model calls happen.
7. Registry coexistence: perception tools (register_all) and fabric tools
   (register_fabric_tools) register side by side without conflicts.

Everything is fake: fake model backends, fake clock, in-memory document
store tools; no network, clipboard, model, or file writes.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.errors import ActionFailure, FailureType  # noqa: E402
from app.agent_runtime.loop import (  # noqa: E402
    LoopParams,
    LoopStopped,
    ToolCallFinished,
    ToolCallStarted,
    TurnFinished,
    run_agent_loop,
)
from app.agent_runtime.model_client import (  # noqa: E402
    LoopModelClient,
    ToolCallArrived,
    TurnDone,
)
from app.agent_runtime.perception_tools import PerceptionTools  # noqa: E402
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec  # noqa: E402
from app.agent_runtime.types import (  # noqa: E402
    Role,
    Terminal,
    ToolCall,
    TransitionReason,
)
from app.fabric.engine import run_agent_turn  # noqa: E402
from app.fabric.executors import register_fabric_tools  # noqa: E402
from app.governance.cancellation import (  # noqa: E402
    CancelledError,
    cancel_all_in_flight,
)
from app.governance.latency_budget import Stage  # noqa: E402

PARAGRAPH = "The quick brown fox jumps over the lazy dog."
FINAL_TEXT = "已翻译并写回：一只敏捷的棕色狐狸跳过了懒狗。"


class FakeDocumentStore:
    """In-memory document the fake tools operate on; no files, no clipboard.

    Tool methods double as ToolSpec.execute callables (they accept the
    harness's injected ``scope`` keyword). ``on_tool`` is an optional hook
    fired before every call, used by the budget/cancellation scenarios.
    """

    def __init__(self, text: str) -> None:
        self.text = text
        self.calls = {
            "Around": 0,
            "selection_expand": 0,
            "translate_in_place": 0,
            "deliver_text": 0,
        }
        self.first_read_fails = False
        self.translate_fails = False
        self.on_tool = None
        self.deliveries: list[str] = []

    def _hit(self, name: str) -> None:
        self.calls[name] += 1
        if self.on_tool is not None:
            self.on_tool(name)

    def Around(self, scope=None, anchor: str = "", radius: int = 3) -> str:
        self._hit("Around")
        if self.first_read_fails and self.calls["Around"] == 1:
            raise ActionFailure(
                FailureType.TIMEOUT, "read worker busy", recovery_hint="retry"
            )
        return f"read[{anchor}:{radius}] {self.text}"

    def selection_expand(self, scope=None, text: str = "", target_length: int = 300) -> str:
        self._hit("selection_expand")
        return f"[expanded] {text} ...更多细节({target_length})"

    def translate_in_place(self, scope=None, text: str = "", target_language: str = "中文") -> str:
        self._hit("translate_in_place")
        if self.translate_fails:
            raise ActionFailure(
                FailureType.CONTENT_CHANGED,
                "目标文档在读取后被修改，无法写回",
                recovery_hint="重新圈选目标段落",
            )
        return f"[translated:{target_language}] {text}"

    def deliver_text(self, scope=None, text: str = "") -> str:
        self._hit("deliver_text")
        self.deliveries.append(text)
        self.text = text
        return "delivered:ok"


def _ms_budget(ms: int) -> Any:
    """A single FULL_ANSWER budget policy with a millisecond cap."""
    from app.governance.latency_budget import BudgetPolicy, TimeoutAction

    return BudgetPolicy(
        stage=Stage.FULL_ANSWER,
        budget_ms=ms,
        on_timeout=TimeoutAction.STASH_BACKGROUND,
    )


def _register_fake_tools(registry: ToolRegistry, doc: FakeDocumentStore) -> ToolRegistry:
    """Register the four fake chain tools (read/expand/translate/deliver)."""
    registry.register(
        ToolSpec(
            name="Around",
            description="fake perception read around an anchor",
            input_schema={
                "type": "object",
                "properties": {
                    "anchor": {"type": "string"},
                    "radius": {"type": "integer"},
                },
                "required": ["anchor"],
            },
            execute=doc.Around,
            effect=Effect.READ,
            is_concurrency_safe=False,
            used_backend="fake_uia",
        )
    )
    registry.register(
        ToolSpec(
            name="selection_expand",
            description="fake in-place expand of the selected text",
            input_schema={
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "target_length": {"type": "integer"},
                },
                "required": ["text"],
            },
            execute=doc.selection_expand,
            effect=Effect.REVERSIBLE_WRITE,
            is_concurrency_safe=False,
            used_backend="fake_model",
        )
    )
    registry.register(
        ToolSpec(
            name="translate_in_place",
            description="fake in-place translation of the selected text",
            input_schema={
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "target_language": {"type": "string"},
                },
                "required": ["text"],
            },
            execute=doc.translate_in_place,
            effect=Effect.REVERSIBLE_WRITE,
            is_concurrency_safe=False,
            used_backend="fake_model",
        )
    )
    registry.register(
        ToolSpec(
            name="deliver_text",
            description="fake write-back of the replacement text",
            input_schema={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
            execute=doc.deliver_text,
            effect=Effect.REVERSIBLE_WRITE,
            is_concurrency_safe=False,
            used_backend="fake_write",
        )
    )
    return registry


class ChainBackend:
    """Fake model that replays a plan of tool-call rounds, verifying results.

    Each round is a list of ``(name, arguments, expect, call_id)`` steps
    emitted in one model turn. Before every tool step it checks that the
    previous tool result's content actually reached the model; a mismatch
    fails the test loudly. The last turn answers with ``final_text``.
    """

    def __init__(self, rounds: list[list[tuple]], final_text: str) -> None:
        self._rounds = [list(round_) for round_ in rounds]
        self.final_text = final_text
        self.received: list[tuple] = []

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        self.received.append((list(messages), list(tools)))
        if self._rounds:
            tool_messages = [m for m in messages if m.role is Role.TOOL]
            for name, arguments, expect, call_id in self._rounds.pop(0):
                if expect is not None:
                    last = tool_messages[-1].content if tool_messages else ""
                    assert expect in last, (
                        f"model did not see the prior tool result: {expect!r} "
                        f"not in {last!r}"
                    )
                yield ToolCallArrived(
                    call=ToolCall(id=call_id, name=name, arguments=arguments)
                )
            yield TurnDone(usage=None, raw_text=None)
        else:
            yield TurnDone(usage=None, raw_text=self.final_text)


class FakeClock:
    """Callable fake clock: manual elapsed-ms advance."""

    def __init__(self) -> None:
        self.elapsed = 0.0

    def __call__(self) -> float:
        return self.elapsed

    def advance(self, ms: float) -> None:
        self.elapsed += ms


async def _collect(params: LoopParams) -> tuple[list, Terminal]:
    """Consume the loop async generator; return (events, terminal)."""
    events = []
    generator = run_agent_loop(params)
    while True:
        try:
            events.append(await generator.__anext__())
        except StopAsyncIteration:
            break
    assert isinstance(events[-1], LoopStopped), "loop must end with LoopStopped"
    return events, events[-1].terminal


# ---------------------------------------------------------------------------
# 1. Four-step tool chain: results are fed back, loop converges
# ---------------------------------------------------------------------------


def test_four_step_tool_chain_feedback_and_convergence() -> None:
    doc = FakeDocumentStore(PARAGRAPH)
    registry = _register_fake_tools(ToolRegistry(), doc)
    backend = ChainBackend(
        rounds=[
            [("Around", {"anchor": "p1", "radius": 3}, None, "c1")],
            [("selection_expand", {"text": "s", "target_length": 400}, PARAGRAPH, "c2")],
            [
                (
                    "translate_in_place",
                    {"text": "s", "target_language": "中文"},
                    "[expanded]",
                    "c3",
                )
            ],
        ],
        final_text=FINAL_TEXT,
    )
    client = LoopModelClient(backend)
    params = LoopParams(
        user_input="扩写并翻译这个段落",
        registry=registry,
        client=client,
        emergency_turn_fuse=6,
    )

    events, terminal = asyncio.run(_collect(params))

    assert terminal.reason is TransitionReason.COMPLETED
    # translate_in_place 是无验证回执的写入 → 验证门 nudge 一轮再收工（turn 4→5）
    assert [e for e in events if type(e).__name__ == "VerificationNudged"]
    assert terminal.turns == 5
    assert terminal.message == FINAL_TEXT
    assert len(terminal.results) == 3
    assert [r.tool_call_id for r in terminal.results] == ["c1", "c2", "c3"]
    assert all(not r.is_error for r in terminal.results)

    tool_starts = [e for e in events if isinstance(e, ToolCallStarted)]
    tool_finishes = [e for e in events if isinstance(e, ToolCallFinished)]
    assert [e.name for e in tool_starts] == [
        "Around",
        "selection_expand",
        "translate_in_place",
    ]
    assert len(tool_finishes) == 3

    roles_seen = [[m.role for m in messages] for messages, _ in backend.received]
    assert roles_seen == [
        [Role.USER],
        [Role.USER, Role.ASSISTANT, Role.TOOL],
        [Role.USER, Role.ASSISTANT, Role.TOOL, Role.ASSISTANT, Role.TOOL],
        [Role.USER, Role.ASSISTANT, Role.TOOL, Role.ASSISTANT, Role.TOOL, Role.ASSISTANT, Role.TOOL],
        # 第 5 轮：模型第 4 轮的最终回答已入列，验证门在其后注入 nudge（USER）
        [Role.USER, Role.ASSISTANT, Role.TOOL, Role.ASSISTANT, Role.TOOL, Role.ASSISTANT, Role.TOOL, Role.ASSISTANT, Role.USER],
    ]
    assert "The quick brown fox" in backend.received[1][0][2].content
    assert "[expanded]" in backend.received[2][0][-1].content
    assert "[translated:中文]" in backend.received[3][0][-1].content

    finished = [e for e in events if isinstance(e, TurnFinished)]
    assert finished[-1].state.messages[-1].role is Role.ASSISTANT
    assert finished[-1].state.messages[-1].content == FINAL_TEXT
    assert [e.state.transition for e in finished] == [
        TransitionReason.TOOL_RESULT,
        TransitionReason.TOOL_RESULT,
        TransitionReason.TOOL_RESULT,
        TransitionReason.STOP_HOOK,      # 验证门 nudge（复用 stop_hook 转移语义）
        TransitionReason.COMPLETED,
    ]


# ---------------------------------------------------------------------------
# 2. Trajectory-driven: fixed trajectory seeds the first-round template
# ---------------------------------------------------------------------------


def test_run_agent_turn_forwards_keepalive_to_the_loop() -> None:
    """The bridge passes ``keepalive`` to keep the IPC idle deadline alive
    during long model calls/tools; the loop entry must forward it, otherwise
    the first message dies with TypeError in production (2026-08-23 bug)."""
    doc = FakeDocumentStore(PARAGRAPH)
    registry = _register_fake_tools(ToolRegistry(), doc)
    beats: list[str] = []
    backend = ChainBackend(rounds=[], final_text="已改写")

    terminal = run_agent_turn(
        "扩写第二段",
        objects=[{"id": "o1", "kind": "text", "content": PARAGRAPH}],
        registry=registry,
        client=LoopModelClient(backend),
        keepalive=beats.append,
    )

    assert terminal.reason is TransitionReason.COMPLETED
    assert len(beats) >= 1, beats  # at least the turn-start beat
    assert all(isinstance(b, str) and b for b in beats)


def test_run_agent_turn_forwards_todo_store_for_partial_delivery() -> None:
    """BUDGET_EXHAUSTED must list pending todos; ``run_agent_turn`` must
    forward the bridge's todo_store into the loop (roadmap §12.1)."""
    class _Todo:
        def read(self):
            return [
                {"status": "in_progress", "content": "修复 keepalive 接线"},
                {"status": "pending", "content": "交付 sync"},
            ]

    doc = FakeDocumentStore(PARAGRAPH)
    registry = _register_fake_tools(ToolRegistry(), doc)
    backend = ChainBackend(rounds=[], final_text="x")

    # Budget 1 ms + no progress yet → BUDGET_EXHAUSTED on the first check.
    # (first clock call = loop start, later calls = past deadline)
    _clock_state = {"calls": 0}

    def _past_deadline_clock() -> float:
        _clock_state["calls"] += 1
        return 6_000.0 if _clock_state["calls"] > 1 else 0.0

    terminal = run_agent_turn(
        "干活",
        objects=[{"id": "o1", "kind": "text", "content": PARAGRAPH}],
        registry=registry,
        client=LoopModelClient(backend),
        todo_store=_Todo(),
        budgets={
            Stage.FULL_ANSWER: _ms_budget(1),
        },
        clock=_past_deadline_clock,
    )

    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED
    assert "修复 keepalive 接线" in terminal.message
    assert "待办" in terminal.message or "pending" in terminal.message


def test_run_agent_turn_keeps_raw_instruction_and_does_not_route_via_recipe(monkeypatch) -> None:
    doc = FakeDocumentStore(PARAGRAPH)
    registry = _register_fake_tools(ToolRegistry(), doc)
    monkeypatch.setattr(
        "app.fabric.intent_router.get_trajectory_compiler",
        lambda: (_ for _ in ()).throw(AssertionError("recipe router entered")),
    )

    backend = ChainBackend(rounds=[], final_text="已改写")
    client = LoopModelClient(backend)

    terminal = run_agent_turn(
        "扩写第二段",
        objects=[{"id": "o1", "kind": "text", "content": PARAGRAPH}],
        registry=registry,
        client=client,
    )

    first_messages, schemas = backend.received[0]
    assert len(first_messages) == 1
    assert first_messages[0].role is Role.USER
    assert first_messages[0].content == "扩写第二段"
    assert schemas[0]["name"] == "Around"
    assert schemas[1]["name"] == "selection_expand"
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "已改写"
    assert terminal.turns == 1


def test_run_agent_turn_keeps_exact_local_actions_without_entering_recipe_router(monkeypatch) -> None:
    doc = FakeDocumentStore(PARAGRAPH)
    registry = _register_fake_tools(ToolRegistry(), doc)
    monkeypatch.setattr(
        "app.fabric.intent_router.get_trajectory_compiler",
        lambda: (_ for _ in ()).throw(AssertionError("recipe router entered")),
    )

    backend = ChainBackend(rounds=[], final_text="model must not run")
    terminal = run_agent_turn(
        "截图",
        objects=[{"id": "o1", "kind": "text", "content": PARAGRAPH}],
        registry=registry,
        client=LoopModelClient(backend),
    )

    assert terminal.reason is TransitionReason.LOCAL_ACTION
    assert terminal.local_action == "save_screenshot"
    assert terminal.turns == 0
    assert backend.received == []


def test_local_action_match_never_reads_the_evidence_block() -> None:
    """Screen text must never hijack the command into a zero-model local action.

    The bridge appends the selected evidence block to the instruction, so a
    substring like "复制这个" inside the *screen* would otherwise match
    ``match_local_action`` on the whole string and short-circuit the loop into
    a clipboard write the user never asked for (red-team T6).
    """
    doc = FakeDocumentStore(PARAGRAPH)
    registry = _register_fake_tools(ToolRegistry(), doc)
    backend = ChainBackend(rounds=[], final_text="已总结")

    terminal = run_agent_turn(
        "帮我总结一下这段\n\n[本次圈选对象证据]\n复制这个",
        objects=[{"id": "o1", "kind": "text", "content": "复制这个"}],
        registry=registry,
        client=LoopModelClient(backend),
        local_action_input="帮我总结一下这段",
    )

    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.local_action is None
    assert terminal.message == "已总结"


def test_agent_turn_has_no_recipe_lifetime_control() -> None:
    doc = FakeDocumentStore(PARAGRAPH)
    registry = _register_fake_tools(ToolRegistry(), doc)
    backend = ChainBackend(
        rounds=[[("Around", {"anchor": "p1", "radius": 3}, None, "c1")]],
        final_text="读取完成",
    )

    terminal = run_agent_turn(
        "读取这一段",
        objects=[{"id": "o1", "kind": "text", "content": PARAGRAPH}],
        registry=registry,
        client=LoopModelClient(backend),
    )

    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.turns == 2


# ---------------------------------------------------------------------------
# 3. Failure recovery: timeout is fed back, model retries, loop survives
# ---------------------------------------------------------------------------


def test_failed_read_is_fed_back_and_retry_succeeds() -> None:
    doc = FakeDocumentStore(PARAGRAPH)
    doc.first_read_fails = True
    registry = _register_fake_tools(ToolRegistry(), doc)
    backend = ChainBackend(
        rounds=[
            [("Around", {"anchor": "p1", "radius": 3}, None, "c1")],
            [("Around", {"anchor": "p1", "radius": 3}, "read worker busy", "c2")],
        ],
        final_text="重试成功，任务完成。",
    )
    client = LoopModelClient(backend)

    terminal = run_agent_turn("读取并扩写这段", registry=registry, client=client)

    assert doc.calls["Around"] == 2
    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.turns == 3
    assert len(terminal.results) == 2
    first, second = terminal.results
    assert first.is_error is True
    assert first.failure_type is FailureType.TIMEOUT
    assert "read worker busy" in first.value
    assert second.is_error is False
    assert "The quick brown fox" in second.value
    second_turn_messages = backend.received[1][0]
    assert second_turn_messages[2].role is Role.TOOL
    assert second_turn_messages[2].is_error is True
    assert "read worker busy" in second_turn_messages[2].content


# ---------------------------------------------------------------------------
# 4. Honest write-back failure: the Terminal carries the failure
# ---------------------------------------------------------------------------


def test_write_back_failure_is_not_disguised_as_success() -> None:
    doc = FakeDocumentStore(PARAGRAPH)
    doc.translate_fails = True
    registry = _register_fake_tools(ToolRegistry(), doc)
    backend = ChainBackend(
        rounds=[
            [
                (
                    "translate_in_place",
                    {"text": "s", "target_language": "中文"},
                    None,
                    "c1",
                )
            ]
        ],
        final_text="翻译失败，无法写回，请重新圈选段落。",
    )
    client = LoopModelClient(backend)

    terminal = run_agent_turn("把这段翻译成中文", registry=registry, client=client)

    assert terminal.reason is TransitionReason.COMPLETED
    assert terminal.message == "翻译失败，无法写回，请重新圈选段落。"
    assert terminal.turns == 2
    assert len(terminal.results) == 1
    result = terminal.results[0]
    assert result.is_error is True
    assert result.failure_type is FailureType.CONTENT_CHANGED
    assert "目标文档在读取后被修改" in result.value
    second_turn_messages = backend.received[1][0]
    assert second_turn_messages[2].is_error is True
    assert "目标文档在读取后被修改" in second_turn_messages[2].content
    assert doc.deliveries == []


# ---------------------------------------------------------------------------
# 5. Budget limit: truncated delivery keeps completed results
# ---------------------------------------------------------------------------


def test_budget_exhaustion_keeps_completed_results() -> None:
    clock = FakeClock()
    doc = FakeDocumentStore(PARAGRAPH)
    doc.on_tool = lambda name: clock.advance(10_000) if name == "selection_expand" else None
    registry = _register_fake_tools(ToolRegistry(), doc)
    backend = ChainBackend(
        rounds=[
            [
                ("Around", {"anchor": "p1", "radius": 3}, None, "c1"),
                ("selection_expand", {"text": "s", "target_length": 400}, None, "c2"),
            ]
        ],
        final_text="too late",
    )
    client = LoopModelClient(backend)

    terminal = run_agent_turn(
        "扩写这个段落",
        registry=registry,
        client=client,
        clock=clock,
        budget_renewals=0,
    )

    assert len(backend.received) == 1
    assert terminal.reason is TransitionReason.BUDGET_EXHAUSTED
    # 12.1/§B1: the terminal message is now an honest partial delivery
    # listing completed steps, not a bare "budget exhausted" stub.
    assert terminal.message.startswith("full answer budget exhausted")
    assert "completed steps:" in terminal.message
    assert "/resume" in terminal.message
    assert terminal.turns == 1
    assert len(terminal.results) == 2
    assert [r.tool_call_id for r in terminal.results] == ["c1", "c2"]
    assert all(not r.is_error for r in terminal.results)
    assert doc.calls["Around"] == 1
    assert doc.calls["selection_expand"] == 1
    assert doc.calls["translate_in_place"] == 0


# ---------------------------------------------------------------------------
# 6. Cancellation generation: no further model calls after cancel
# ---------------------------------------------------------------------------


def test_cancel_in_round_two_raises_and_stops_model_calls() -> None:
    doc = FakeDocumentStore(PARAGRAPH)
    doc.on_tool = (
        lambda name: cancel_all_in_flight() if name == "selection_expand" else None
    )
    registry = _register_fake_tools(ToolRegistry(), doc)
    backend = ChainBackend(
        rounds=[
            [("Around", {"anchor": "p1", "radius": 3}, None, "c1")],
            [("selection_expand", {"text": "s", "target_length": 400}, None, "c2")],
        ],
        final_text="never reached",
    )
    client = LoopModelClient(backend)

    with pytest.raises(CancelledError):
        run_agent_turn("扩写这个段落", registry=registry, client=client)

    assert len(backend.received) == 2
    assert doc.calls["Around"] == 1
    assert doc.calls["selection_expand"] == 1
    assert doc.calls["translate_in_place"] == 0


# ---------------------------------------------------------------------------
# 7. Registry coexistence: perception + fabric tools side by side
# ---------------------------------------------------------------------------


class FakePerceptionBackend:
    def Around(self, anchor: str, radius: int) -> list[dict]:
        return [{"text": "one"}]

    def Tree(self, anchor: str, depth: int) -> dict | None:
        return {"name": "root"}

    def Find(self, pattern: str) -> list[dict]:
        return [{"text": "hit"}]

    def ListWindows(self) -> list[dict]:
        return [{"hwnd": 1, "title": "t", "process_name": "p", "pid": 1}]

    def GetFocus(self) -> dict | None:
        return {"hwnd": 1, "title": "t", "process_name": "p", "pid": 1}


def test_fabric_and_perception_tools_coexist_in_one_registry() -> None:
    registry = ToolRegistry()
    PerceptionTools(FakePerceptionBackend()).register_all(registry)
    register_fabric_tools(registry)

    names = [spec.name for spec in registry.list()]
    assert len(names) == 23
    assert len(set(names)) == len(names)
    assert "Around" in names
    assert "rewrite_in_place" in names
    assert "deliver_text" not in names

    parallel, sequential = registry.concurrency_partition(
        ["Around", "rewrite_in_place", "screen_translate"]
    )
    assert set(parallel) == {"Around", "screen_translate"}
    assert sequential == ["rewrite_in_place"]

    assert registry.resource_keys_for("ocr_copy", {"objects": []}) == (
        "clipboard",
    )
    assert registry.resource_keys_for("rewrite_in_place", {"objects": []}) == (
        "artifact-store",
    )
    assert registry.resource_keys_for("task_route", {"objects": []}) == (
        "task-store",
    )

    register_fabric_tools(registry)
    assert len(registry.list()) == 23


def test_fabric_unverified_receipt_is_not_reported_as_tool_success() -> None:
    registry = ToolRegistry()
    register_fabric_tools(registry)

    result = registry.execute_tool("ocr_copy", {"objects": []})

    assert result.is_error is True
    assert "clipboard_writer_not_configured" in (result.error_message or "")
