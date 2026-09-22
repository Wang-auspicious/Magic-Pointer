
from __future__ import annotations

from app.agent_runtime.tool_registry import Effect

__all__ = ["VerificationGate", "should_nudge_before_completion"]

_NUDGE_MESSAGE = (
    "（验证门）本回合执行过写入类操作，但还没有任何通过的验证回执。"
    "先用可用的验证手段确认结果（读回、测试或 verify 类工具），"
    "确认无误后再给出最终回答；如果无法验证，请在回答里明确说明"
    "「已执行但未验证」与下一步验证建议。"
)

_GATED_EFFECTS = frozenset({
    Effect.REVERSIBLE_WRITE,
    Effect.LOCAL_IRREVERSIBLE,
    Effect.EXTERNAL_SEND,
    Effect.DESTRUCTIVE,
    Effect.PURCHASE,
})


class VerificationGate:

    def __init__(self) -> None:
        self._wrote = False
        self._verified = False
        self._nudged = False

    def record_executed(
        self,
        *,
        effect: Effect,
        verified: bool,
        tool_name: str = "",
    ) -> None:
        if effect in _GATED_EFFECTS:
            self._wrote = True
            self._verified = False
        name = str(tool_name or "")
        if name in {"Click", "click"}:
            return
        if verified:
            self._verified = True

    def mark_nudged(self) -> None:
        self._nudged = True

    @property
    def wrote(self) -> bool:
        return self._wrote

    @property
    def verified(self) -> bool:
        return self._verified


def should_nudge_before_completion(gate: VerificationGate) -> str | None:
    if gate._nudged or not gate._wrote or gate._verified:
        return None
    return _NUDGE_MESSAGE
