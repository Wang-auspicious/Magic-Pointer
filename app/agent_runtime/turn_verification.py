"""turn 端验证门：改了却没验证就想收工时，拦一次。

Hermes ``agent/verification_stop.py`` 的 MP 最小版（policy-only，自己不跑
任何检查）：本回合执行过写入类效果（REVERSIBLE_WRITE 及更强）、又没有
任何新鲜验证证据（一次通过 ``verify_result`` 的成功回执）时，模型试图以
completed 收尾 → 拒绝一次并注入 nudge（"先验证再收工"）；已经 nudge 过
一次就放行，防死循环。纯读回合永远不拦。
"""

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
    """一回合的验证证据账。loop 在工具回执处 ``record_executed``。"""

    def __init__(self) -> None:
        self._wrote = False
        self._verified = False
        self._nudged = False

    def record_executed(self, *, effect: Effect, verified: bool) -> None:
        """记录一次成功执行的工具调用（``verified`` = 该调用带 verify 且通过）。"""
        if effect in _GATED_EFFECTS:
            self._wrote = True
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
    """模型想收工时问一次：要 nudge 就返回注入文本，否则 None。"""
    if gate._nudged or not gate._wrote or gate._verified:
        return None
    return _NUDGE_MESSAGE
