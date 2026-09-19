"""探针的每一道预算都要装得下它要等的东西。

2026-09-19 实机复现的核心事实：**同一个微信窗口，带 point 探针 1215ms 撞满上限报成
读取失败，不带 point 320ms 就诚实答完。** phase trace 显示 `document_scan at=126`
之后 `point_element` 这一相永远打不出来——点探测里的 `ElementFromPoint` 和逐层下探
都是跨进程 UI Automation 调用，在自绘窗口上不返回。

修法不是把上限调大，而是让那一相自己认输，并且别把它后面能给出答案的相挡住。

预算之间的关系同样是判据：**截止时间短于它要容纳的预算，就是把一个正在正常作答的
探针杀掉**，然后报成"读不到"。
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "scripts" / "uia_selection_probe.cs").read_text(encoding="utf-8")
BRIDGE = (ROOT / "scripts" / "element_probe_bridge.py").read_text(encoding="utf-8")


def _const(name: str) -> int:
    match = re.search(rf"{name}\s*=\s*(\d+)\s*;", SOURCE)
    assert match, f"{name} 不见了"
    return int(match.group(1))


def test_the_native_ceiling_still_clears_the_slowest_honest_probe() -> None:
    # 解掉遍历型探针实测最慢的一次是 975ms（见文件里那段 2026-08-03 的实测注释）。
    assert _const("UiaProbeHardTimeoutMs") >= 975
    assert _const("RegionHardTimeoutMs") > _const("UiaProbeHardTimeoutMs")


def test_the_timeout_error_reports_the_budget_it_actually_used() -> None:
    stripped = re.sub(r"//[^\n]*", "", SOURCE)
    assert "uia_probe_timeout_" not in stripped.replace(
        '"uia_probe_timeout_" + hardTimeoutMs + "ms"', ""
    ).replace('"uia_probe_timeout_" + hardTimeoutMs2 + "ms"', ""), (
        "超时文案里出现了写死的毫秒数：预算改了以后它会开始说谎"
    )


def test_a_timeout_never_overwrites_an_answer_that_was_already_found() -> None:
    """前面几相挣来的结果被一句 timeout 覆盖，就是「能读到的窗口报成读不到」。"""
    assert SOURCE.count("readTask.Wait(hardTimeoutMs) && !result.Ok") == 1
    assert SOURCE.count("readTask.Wait(hardTimeoutMs2) && !result.Ok") == 1


def test_each_unbounded_phase_runs_under_its_own_budget() -> None:
    """三道预算共用同一个值，而且都真的用上了。"""
    assert _const("PhaseBudgetMs") > 0
    helper = SOURCE.split("private static bool RunPhaseWithBudget", 1)[1].split(
        "private static void RunDocumentScanWithBudget", 1
    )[0]
    assert ".Wait(PhaseBudgetMs)" in helper
    for wrapper, reason in (
        ("RunDocumentScanWithBudget", "DocumentScanAbandoned"),
        ("RunDocumentFallbackWithBudget", "DocumentFallbackAbandoned"),
        ("RunPointPhaseWithBudget", "PointPhaseAbandoned"),
    ):
        block = SOURCE.split(f"private static void {wrapper}", 1)[1].split(
            "private static ", 1
        )[0]
        assert "RunPhaseWithBudget(" in block, f"{wrapper} 没走共用预算"
        assert f"result.Error = {reason}" in block, f"{wrapper} 没有可认领的放弃理由"
        # 写一半的结果不能留着：放弃必须同时把 Ok 打回 false。
        assert "result.Ok = false" in block


def test_the_ceiling_outlasts_every_phase_budget_added_up() -> None:
    """三道预算吃满时不能正好落在上限上——那等于还是超时。

    Obsidian 实测：三道各 450/450/400、上限 1200 时收场是 `uia_probe_timeout_1200ms`
    (1224ms)。有界不等于不撞上限，除非上限比它们的和大。
    """
    phase = _const("PhaseBudgetMs")
    ceiling = _const("UiaProbeHardTimeoutMs")
    # 前置几相（focused_element / focused_ancestors / root_element）实测 100-180ms。
    measured_prefix_ms = 180
    assert measured_prefix_ms + 3 * phase < ceiling, (
        f"{measured_prefix_ms} + 3*{phase} 已经贴上 {ceiling} 了"
    )
    # 也不该反过来松到没有意义：每道预算仍要够跑完一次正常的文档扫描（115-227ms）。
    assert phase > 227


def test_the_point_phase_cannot_block_the_phase_that_answers() -> None:
    """点探测挂住时，`document_text_fallback` 是唯一还能给出正文的那一相。"""
    body = SOURCE.split("private static void RunProbeCore", 1)[1]
    fallback = body.index("TryDocumentTextFallback(root, result)")
    point = body.index("RunPointPhaseWithBudget(root, targetPoint.Value, result)")
    assert fallback < point, "点探测排在正文兜底前面，它一挂就轮到不到了"


def test_the_point_descent_is_bounded_in_total_not_only_per_level() -> None:
    assert _const("PointDescentMaxNodes") > 0
    assert _const("PointDescentBudgetMs") > 0
    assert _const("PointDescentBudgetMs") <= _const("PhaseBudgetMs"), (
        "内层下探的预算不该超过包着它的那一相"
    )
    descent = SOURCE.split("private static AutomationElement FindDeepestElementAtPoint", 1)[1]
    descent = descent.split("private static ", 1)[0]
    assert "visited >= PointDescentMaxNodes" in descent
    assert "budget.ElapsedMilliseconds >= PointDescentBudgetMs" in descent


def test_the_python_budget_outlasts_every_native_ceiling() -> None:
    match = re.search(r"^PROBE_TIMEOUT_S\s*=\s*([\d.]+)", BRIDGE, re.MULTILINE)
    assert match, "PROBE_TIMEOUT_S 不见了"
    budget_ms = float(match.group(1)) * 1000
    assert budget_ms > _const("UiaProbeHardTimeoutMs"), (
        "Python 侧先掐死探针，等于把正在作答的读取报成失败"
    )
    assert budget_ms > _const("PhaseBudgetMs")
