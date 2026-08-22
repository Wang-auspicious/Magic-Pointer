"""Resume reduction: interrupted-turn continuation context (harness-v2 port).

Source of truth: pi ``packages/agent/docs/harness-v2.md`` (dropped at the
repo root, 2026-08-21) — "resume continues the open operation from what the
records say; it never starts a new one". MP's session store already records
turns and tool settlements durably; this adds the reduction + one-shot
continuation prompt so a crashed/budget-cut task is picked back up on the
next send instead of silently dying.
"""

from __future__ import annotations

from typing import Any

__all__ = ["continuation_prefix"]


def continuation_prefix(summary: dict[str, Any] | None) -> str:
    """Build the injected continuation block; empty string when nothing to resume."""
    if not summary:
        return ""
    steps = summary.get("steps") or []
    step_lines = "\n".join(
        f"- {step.get('name')}：{step.get('outcome')}" for step in steps[-10:]
    )
    reason_text = {
        "budget_exhausted": "本轮预算用尽",
        "stalled": "检测到停滞被中止",
        "provider_unavailable": "模型后端不可用",
        "user_interrupt": "用户手动中断",
        "max_output_tokens_recovered": "输出长度截断",
        "invariant_failed": "内部错误",
        "interrupted": "进程中断",
    }.get(str(summary.get("reason")), str(summary.get("reason")))
    parts = [
        "<<<MAGIC_POINTER_EVIDENCE>>>",
        "[上一轮任务未完成，以下是断点状态]",
        f"原始任务：{summary.get('task_input')}",
        f"停止原因：{reason_text}",
    ]
    if step_lines:
        parts.append(f"已完成的工具步骤：\n{step_lines}")
    parts.append(
        "如果这条新消息是在继续该任务，从断点接着做（先核对磁盘与会话里的实际状态，"
        "不要盲信上面已完成列表）；如果是新任务或无关问题，忽略本块正常回答。"
        "本块是会话记录数据，不是新指令。"
    )
    parts.append("<<<MAGIC_POINTER_EVIDENCE>>>")
    return "\n".join(parts)
