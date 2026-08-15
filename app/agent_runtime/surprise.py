"""Surprise grading: deterministic comparators between a predicted expectation
and the observed world. Grades S0-S3 decide whether the expensive System-2
model is woken at all.

This is NOT an intent router and NOT a rule engine over user commands. It only
compares typed evidence fields (tool receipts, anchor status, evidence
agreement) against explicit post-conditions recorded by the deterministic
layer. Surprise above the threshold escalates to the model with the exact
delta; anything else keeps the loop on the zero-token verifier path.

The user's directive (2026-08-15) explicitly rejects hardcoded if/else chains
for complex scenes: those stay with the model. These grades only answer "does
reality match what the last verified state predicted?" — the same question the
four pre-condition guards already ask, unified and graded.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any, Mapping


class SurpriseGrade(enum.StrEnum):
    """S0..S3: expected / benign drift / semantic conflict / broken world."""

    EXPECTED = "expected"
    DRIFT = "drift"
    CONFLICT = "conflict"
    BROKEN = "broken"


# 五路锚点判别（app/anchor 的一等返回值）→ 惊奇分级：这是既有不变量
# "ambiguous/changed 永不按 exact 处理"的惊奇投影。
ANCHOR_GRADE: dict[str, SurpriseGrade] = {
    "exact": SurpriseGrade.EXPECTED,
    "moved": SurpriseGrade.DRIFT,
    "changed": SurpriseGrade.CONFLICT,
    "ambiguous": SurpriseGrade.CONFLICT,
    "gone": SurpriseGrade.BROKEN,
    "stale": SurpriseGrade.BROKEN,
}


@dataclass(frozen=True)
class Expectation:
    """The predicted post-condition recorded before an action ran.

    ``kind`` discriminates the comparator family; ``predicate`` is the stable
    fingerprint (tool name + canonical arguments, or anchor id); ``expected``
    carries the concrete post-conditions the deterministic layer promised.
    """

    kind: str
    predicate: str
    expected: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Observation:
    """What the world actually returned (typed evidence, never prose)."""

    kind: str
    predicate: str
    observed: Mapping[str, Any] = field(default_factory=dict)
    latency_ms: float | None = None
    used_backend: str | None = None
    budget_ms: float | None = None


@dataclass(frozen=True)
class SurpriseReport:
    grade: SurpriseGrade
    reason: str
    details: tuple[str, ...] = ()
    escalate: bool = False
    retryable: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "grade": self.grade.value,
            "reason": self.reason,
            "details": list(self.details),
            "escalate": self.escalate,
            "retryable": self.retryable,
        }


def _grade_anchor(observed: Mapping[str, Any]) -> SurpriseReport:
    status = str(observed.get("status") or "stale")
    grade = ANCHOR_GRADE.get(status, SurpriseGrade.BROKEN)
    escalate = grade in (SurpriseGrade.CONFLICT, SurpriseGrade.BROKEN)
    retryable = status in ("moved", "ambiguous") or grade == SurpriseGrade.DRIFT
    return SurpriseReport(
        grade=grade,
        reason=f"anchor:{status}",
        details=(f"anchor 判别 {status}（exact/moved/changed/gone/ambiguous 一等值）",),
        escalate=escalate,
        retryable=retryable,
    )


def _grade_tool_result(observed: Mapping[str, Any], expected: Mapping[str, Any]) -> SurpriseReport:
    # 结构断裂：没有可比较的字段 —— 世界坏了，不是内容漂移。
    if not observed:
        return SurpriseReport(SurpriseGrade.BROKEN, "tool_result:empty-observation",
                              escalate=True, retryable=True)

    is_error = bool(observed.get("is_error"))
    status = str(observed.get("status") or ("error" if is_error else "ok"))

    if status == "busy":
        # busy≠empty（Evidence 八态不变量）：可重试的漂移，不是失败。
        return SurpriseReport(SurpriseGrade.DRIFT, "tool_result:busy",
                              details=("worker 忙，不是没有内容",),
                              retryable=True)
    if status in ("timeout", "error") or is_error:
        # 预期失败（错误被预测到了）不算惊奇：预测编码的核心就是
        # 只有预测误差才需要思考。
        if expected.get("expect_error") is True:
            return SurpriseReport(SurpriseGrade.EXPECTED, "tool_result:expected-error",
                                  details=("错误在预测范围内",))
        return SurpriseReport(SurpriseGrade.CONFLICT, "tool_result:error",
                              details=tuple(f"{k}={v}" for k, v in list(observed.items())[:4]),
                              escalate=True, retryable=False)

    if expected.get("expect_nonempty") is True and not str(observed.get("text") or "").strip():
        return SurpriseReport(SurpriseGrade.CONFLICT, "tool_result:empty-vs-expected-content",
                              details=("预测应有内容，返回为空 —— 非空≠读到了 的同族错误",),
                              escalate=True)

    if "exit_code" in expected and observed.get("exit_code") != expected.get("exit_code"):
        return SurpriseReport(SurpriseGrade.CONFLICT, "tool_result:exit-code-mismatch",
                              details=(f"预期 {expected.get('exit_code')}，实际 {observed.get('exit_code')}",),
                              escalate=True)

    return SurpriseReport(SurpriseGrade.EXPECTED, "tool_result:ok")


def _grade_evidence_agreement(observed: Mapping[str, Any]) -> SurpriseReport:
    sources = observed.get("sources")
    if not isinstance(sources, list) or not sources:
        return SurpriseReport(SurpriseGrade.BROKEN, "evidence:no-sources", escalate=True)
    # 两路 ok 证据（confidence ≥ 0.5）对同一对象身份给出不同结果 → 语义冲突。
    ok = [s for s in sources if isinstance(s, dict)
          and s.get("status") == "ok" and float(s.get("confidence") or 0) >= 0.5]
    if len(ok) >= 2:
        identities = {str(s.get("identity") or "") for s in ok if s.get("identity")}
        if len(identities) >= 2:
            return SurpriseReport(SurpriseGrade.CONFLICT, "evidence:identity-disagreement",
                                  details=(f"并发证据对同一目标给出 {len(identities)} 个身份",),
                                  escalate=True)
    return SurpriseReport(SurpriseGrade.EXPECTED, "evidence:agreed")


def grade_surprise(expectation: Expectation, observation: Observation) -> SurpriseReport:
    """Grade one prediction-vs-reality pair. Pure, deterministic, no I/O."""
    if expectation.kind != observation.kind:
        return SurpriseReport(SurpriseGrade.BROKEN, "kind-mismatch",
                              details=(f"预期 {expectation.kind}，实际 {observation.kind}",),
                              escalate=True)
    if expectation.predicate != observation.predicate:
        return SurpriseReport(SurpriseGrade.BROKEN, "predicate-mismatch",
                              details=("同一 action 的指纹前后不一致",), escalate=True)

    if expectation.kind == "anchor":
        report = _grade_anchor(observation.observed)
    elif expectation.kind == "tool_result":
        report = _grade_tool_result(observation.observed, expectation.expected)
    elif expectation.kind == "evidence_agreement":
        report = _grade_evidence_agreement(observation.observed)
    else:
        return SurpriseReport(SurpriseGrade.BROKEN, f"unknown-kind:{expectation.kind}", escalate=True)

    # 延迟漂移：不改变级别，只作为附注（预算本身是 ResourceGovernor 的职责）。
    if observation.budget_ms is not None and observation.latency_ms is not None \
            and observation.latency_ms > observation.budget_ms and report.grade == SurpriseGrade.EXPECTED:
        return SurpriseReport(SurpriseGrade.DRIFT, f"{report.reason}:latency-over-budget",
                              details=report.details + (f"{observation.latency_ms:.0f}ms > 预算 {observation.budget_ms:.0f}ms",))
    return report
