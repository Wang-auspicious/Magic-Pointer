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
                tool_name="pwsh",
                arguments={"command": "Get-Process"},
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
    assert receipts[0]["toolName"] == "pwsh"
    assert receipts[0]["arguments"] == {"command": "Get-Process"}


def test_events_projection_carries_tool_chain_for_gui() -> None:
    from app.agent_runtime.types import ToolResult

    terminal = Terminal(
        reason=TransitionReason.COMPLETED,
        message="done",
        turns=2,
        results=(
            ToolResult(
                tool_call_id="c1",
                value="stdout line",
                is_error=False,
                failure_type=None,
                used_backend="fake",
                latency_ms=5.0,
                tool_name="pwsh",
                arguments={"command": "Get-Process"},
            ),
            ToolResult(
                tool_call_id="c2",
                value="boom",
                is_error=True,
                failure_type="exec_error",
                used_backend="fake",
                latency_ms=1.0,
                tool_name="read",
                arguments={"path": "x.txt"},
            ),
            ToolResult(
                tool_call_id="c3",
                value="no-name",
                is_error=False,
                failure_type=None,
                used_backend="fake",
                latency_ms=1.0,
            ),
        ),
    )
    events = terminal_to_answer(terminal, "cmd")["events"]

    assert len(events) == 2, "results without tool_name must not appear in the chain"
    assert events[0] == {
        "name": "pwsh",
        "arguments": {"command": "Get-Process"},
        "result": "stdout line",
        "isError": False,
        "usedBackend": "fake",
        "latencyMs": 5.0,
    }
    assert events[1]["name"] == "read"
    assert events[1]["isError"] is True


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


def test_permission_gate_keeps_its_kind_and_tool_across_the_bridge() -> None:
    """权限门和普通澄清共用 AWAITING_USER，但回答的语义不同。

    澄清的选项就是用户要说的话；权限门的选项必须变成 grant/once/deny 回到
    loop 里。裁掉 kind/tool 会把前者退化成后者：Studio 画出普通选项按钮，
    点下去发出一条普通消息，授权到不了运行时，工具被再拦一次、再问一遍——
    实测里这就是同一个 curl 连问五轮、审批卡「不消失」的原因。
    conversation_store.recordPermissionDecision 也按 pendingInput.kind 判断
    要不要清掉那道门，所以这两个字段是两端共同的契约。"""
    terminal = Terminal(
        reason=TransitionReason.AWAITING_USER,
        message="需要下载这篇论文的 PDF，可以吗？",
        turns=1,
        results=(),
        pending_input={
            "question": "需要下载这篇论文的 PDF，可以吗？",
            "options": ["仅这一次允许", "本会话总是允许 Bash", "拒绝"],
            "kind": "permission",
            "tool": "Bash",
            "prefix": "curl -L",
        },
    )

    pending = terminal_to_answer(terminal, "下载它")["pendingInput"]

    assert pending["kind"] == "permission"
    assert pending["tool"] == "Bash"
    assert pending["prefix"] == "curl -L"
    assert pending["options"] == ["仅这一次允许", "本会话总是允许 Bash", "拒绝"]


def test_a_clarification_never_grows_a_permission_decision() -> None:
    """反方向也要成立：普通提问不带决定，否则显示层会把它画成审批卡。"""
    terminal = Terminal(
        reason=TransitionReason.AWAITING_USER,
        message="要哪个？",
        turns=1,
        results=(),
        pending_input={"question": "要哪个？", "options": ["A", "B"], "kind": "clarification"},
    )

    pending = terminal_to_answer(terminal, "要哪个")["pendingInput"]

    assert "kind" not in pending
    assert "tool" not in pending


def _terminal(reason, results=(), message=""):
    from app.agent_runtime.types import Terminal, TransitionReason

    return Terminal(
        reason=reason,
        message=message,
        turns=3,
        results=results,
    )


def test_provider_failure_after_work_delivers_partial_receipts():
    """真机事故（notepad-edit）：10 轮成功工作（文档真的改对了）之后一个
    瞬时后端错误把 turn 报废，answer 为空、ok=False——用户看到「Agent 未
    完成」却不知道活已经干完。有成功工具回执的终止 turn 必须交付部分结
    果：已完成步骤 + 诚实缺口，而不是一句报错。"""
    from app.agent_runtime.types import ToolResult, TransitionReason

    results = (
        ToolResult(
            tool_call_id="c1", value="ok", is_error=False,
            failure_type=None, used_backend="desktop", latency_ms=12.0,
            tool_name="get_app_state", arguments={},
        ),
        ToolResult(
            tool_call_id="c2", value="ok", is_error=False,
            failure_type=None, used_backend="desktop", latency_ms=8.0,
            tool_name="click", arguments={},
        ),
        ToolResult(
            tool_call_id="c3", value="ok", is_error=False,
            failure_type=None, used_backend="desktop", latency_ms=30.0,
            tool_name="type_text", arguments={},
        ),
    )
    mapped = terminal_to_answer(
        _terminal(TransitionReason.PROVIDER_UNAVAILABLE, results),
        "改文档",
    )

    assert mapped["ok"] is True, "有实质完成的工作时不得伪装成纯失败"
    assert "type_text" in mapped["answer"] and "get_app_state" in mapped["answer"]
    assert "中断" in mapped["answer"] or "未能" in mapped["answer"], "缺口必须诚实说明"
    assert mapped["loopTerminated"] is True
    assert mapped["loopTerminatedReason"] == "provider_unavailable"


def test_provider_failure_without_work_stays_a_failure():
    """零进展的终止仍然是失败，不编造「已完成 0 步」的答案。"""
    from app.agent_runtime.types import TransitionReason

    mapped = terminal_to_answer(
        _terminal(TransitionReason.PROVIDER_UNAVAILABLE),
        "改文档",
    )
    assert mapped["ok"] is False
    assert mapped["loopTerminated"] is True


def test_budget_exhausted_after_work_delivers_partial_receipts():
    from app.agent_runtime.types import ToolResult, TransitionReason

    results = (
        ToolResult(
            tool_call_id="c1", value="ok", is_error=False,
            failure_type=None, used_backend="desktop", latency_ms=12.0,
            tool_name="click", arguments={},
        ),
    )
    mapped = terminal_to_answer(
        _terminal(TransitionReason.BUDGET_EXHAUSTED, results),
        "任务",
    )
    assert mapped["ok"] is True
    assert "click" in mapped["answer"]
    assert "预算" in mapped["answer"] or "未能" in mapped["answer"]


def test_stalled_after_work_delivers_partial_receipts():
    """真机 notepad-edit：写入成功后验证阶段被重复证据守卫 halt，
    answer 为空——活干完了必须交付已完成步骤。"""
    from app.agent_runtime.types import ToolResult, TransitionReason

    results = (
        ToolResult(
            tool_call_id="c1", value="ok", is_error=False,
            failure_type=None, used_backend="desktop", latency_ms=12.0,
            tool_name="type_text", arguments={},
        ),
        ToolResult(
            tool_call_id="c2", value="ok", is_error=False,
            failure_type=None, used_backend="desktop", latency_ms=8.0,
            tool_name="get_app_state", arguments={},
        ),
    )
    mapped = terminal_to_answer(
        _terminal(TransitionReason.STALLED, results),
        "改文档",
    )
    assert mapped["ok"] is True
    assert "type_text" in mapped["answer"]
    assert mapped["loopTerminatedReason"] == "stalled"


def test_backend_error_code_becomes_human_guidance():
    """原始代码（backend_error:http_500）不得当答案渲染。

    真机 8·29：GUI 第一条消息撞上网关 500，气泡里出现斜体的
    「backenderror:http500」——用户看到的应该是人话和下一步建议，
    原始码留在 error 字段里供日志和诊断。
    """
    from app.agent_runtime.types import TransitionReason

    mapped = terminal_to_answer(
        _terminal(TransitionReason.PROVIDER_UNAVAILABLE, message="backend_error:http_500"),
        "你好",
    )
    assert mapped["ok"] is False
    assert "500" in mapped["answer"] and "重" in mapped["answer"], (
        "答案必须是人话：说清发生了什么 + 下一步（重试）"
    )
    assert "backend_error" not in mapped["answer"], "原始码不进答案正文"
    assert mapped["error"] == "provider_unavailable"
