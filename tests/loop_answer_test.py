"""Terminal-to-answer mapping tests (batch 4 loop answer path)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.types import Terminal, TransitionReason  # noqa: E402
from app.fabric.loop_answer import terminal_to_answer  # noqa: E402


def test_completed_terminal_maps_to_answer_shape() -> None:
    terminal = Terminal(
        reason=TransitionReason.COMPLETED,
        message="这就是答案",
        turns=2,
        results=(),
        model_usage={"inputTokens": 12, "outputTokens": 4, "totalTokens": 16},
    )
    answer = terminal_to_answer(terminal, "帮我看看")

    assert answer["ok"] is True
    assert answer["prompt"] == "帮我看看"
    assert answer["answer"] == "这就是答案"
    assert answer["answerShape"] == "answer"
    assert answer["loopTerminated"] is False
    assert answer["loopTerminatedReason"] is None
    assert answer["route"]["tier"] == "L2"
    assert answer["route"]["turns"] == 2
    assert answer["modelUsage"]["totalTokens"] == 16


def test_terminated_terminal_keeps_partial_answer_and_reason() -> None:
    terminal = Terminal(
        reason=TransitionReason.BUDGET_EXHAUSTED,
        message="full answer budget exhausted",
        turns=3,
        results=(),
    )
    answer = terminal_to_answer(terminal, "长任务")

    assert answer["ok"] is False
    assert answer["error"] == "budget_exhausted"
    assert answer["loopTerminated"] is True
    assert answer["loopTerminatedReason"] == "budget_exhausted"


def test_local_action_terminal_returns_action_not_answer() -> None:
    terminal = Terminal(
        reason=TransitionReason.LOCAL_ACTION,
        message="save_screenshot",
        turns=0,
        results=(),
        local_action="save_screenshot",
    )
    answer = terminal_to_answer(terminal, "截图")

    assert answer["localAction"] == "save_screenshot"
    assert answer["route"]["tier"] == "L0"
    assert answer["answer"] == ""


def test_tool_receipts_are_audit_metadata() -> None:
    from app.agent_runtime.types import ToolResult

    terminal = Terminal(
        reason=TransitionReason.COMPLETED,
        message="done",
        turns=1,
        results=(
            ToolResult(
                tool_call_id="c1",
                value="ok-value",
                is_error=False,
                failure_type=None,
                used_backend="fake",
                latency_ms=12.5,
            ),
        ),
    )
    answer = terminal_to_answer(terminal, "cmd")

    assert answer["answer"] == "done"
    receipts = answer["loopReceipts"]
    assert len(receipts) == 1
    assert receipts[0]["usedBackend"] == "fake"
    assert receipts[0]["latencyMs"] == 12.5
    assert receipts[0]["valuePreview"] == "ok-value"


def test_awaiting_user_terminal_maps_to_resumable_question() -> None:
    terminal = Terminal(
        reason=TransitionReason.AWAITING_USER,
        message="选 A 还是 B？",
        turns=1,
        results=(),
        pending_input={"question": "选 A 还是 B？", "options": ["A", "B"]},
    )

    answer = terminal_to_answer(terminal, "替我选择")

    assert answer["ok"] is True
    assert answer["awaitingUserInput"] is True
    assert answer["pendingInput"]["options"] == ["A", "B"]
    assert answer["loopTerminated"] is False
