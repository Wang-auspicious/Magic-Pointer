"""认知引擎基准：惊奇分级 / 断言记忆 / 模型表面 / Event-Action 调度循环。

用户指令要求的极限场景全部在此：
- 高并发事件抢占（user_interrupt / surprise 在途抢占）
- 预测失败自愈（BROKEN → 确定性重定向探针 → 回归；反复失败 → needs_user）
- 上下文极度受限（预算饿死 → 压缩动作 + 剪枝诚实报告）
- 确定性回放（同一事件序列 → 同一动作轨迹）

HERO 边界：这些测试只钉行为契约，不钉实现细节；没有任何"规则路由用户意图"
的断言——惊奇分级只比较类型化证据字段与显式预测。
"""

from __future__ import annotations

import pytest

from app.agent_runtime.assertion_memory import AssertionStore, assertion_key
from app.agent_runtime.event_loop import (
    Action,
    Event,
    EventActionLoop,
    LoopParams,
    LoopState,
    PRIORITY_REGROUND,
    PRIORITY_USER,
)
from app.agent_runtime.model_surface import (
    ModelSurface,
    SurfaceBudget,
    SurfaceNode,
    build_model_surface,
    estimate_tokens,
    prune_nodes,
)
from app.agent_runtime.surprise import (
    Expectation,
    Observation,
    SurpriseGrade,
    SurpriseReport,
    grade_surprise,
)


# ============================================================================
# 惊奇分级
# ============================================================================

def test_tool_result_ok_is_expected():
    report = grade_surprise(
        Expectation("tool_result", "read|path=a.txt", {"expect_nonempty": True}),
        Observation("tool_result", "read|path=a.txt", {"text": "内容", "is_error": False}),
    )
    assert report.grade == SurpriseGrade.EXPECTED
    assert not report.escalate


def test_predicted_error_is_not_surprise():
    """预测编码的核心：预期内的失败不是惊奇，模型不被唤醒。"""
    report = grade_surprise(
        Expectation("tool_result", "probe", {"expect_error": True}),
        Observation("tool_result", "probe", {"is_error": True, "text": "timeout"}),
    )
    assert report.grade == SurpriseGrade.EXPECTED


def test_unpredicted_error_escalates():
    report = grade_surprise(
        Expectation("tool_result", "write|path=b", {}),
        Observation("tool_result", "write|path=b", {"is_error": True, "text": "权限被拒"}),
    )
    assert report.grade == SurpriseGrade.CONFLICT
    assert report.escalate
    assert not report.retryable


def test_empty_observation_is_broken_world():
    report = grade_surprise(
        Expectation("tool_result", "read", {"expect_nonempty": True}),
        Observation("tool_result", "read", {}),
    )
    assert report.grade == SurpriseGrade.BROKEN
    assert report.retryable


def test_busy_is_drift_not_failure():
    """busy≠empty：忙是可重试的漂移，不是冲突。"""
    report = grade_surprise(
        Expectation("tool_result", "ocr", {}),
        Observation("tool_result", "ocr", {"status": "busy"}),
    )
    assert report.grade == SurpriseGrade.DRIFT
    assert report.retryable


def test_expected_content_missing_escalates():
    """预测应有内容却为空 —— 与「非空≠读到了」同族，必须唤醒模型。"""
    report = grade_surprise(
        Expectation("tool_result", "uia", {"expect_nonempty": True}),
        Observation("tool_result", "uia", {"status": "ok", "text": ""}),
    )
    assert report.grade == SurpriseGrade.CONFLICT


def test_anchor_five_way_projection():
    assert grade_surprise(
        Expectation("anchor", "a1", {}),
        Observation("anchor", "a1", {"status": "exact"}),
    ).grade == SurpriseGrade.EXPECTED
    assert grade_surprise(
        Expectation("anchor", "a1", {}),
        Observation("anchor", "a1", {"status": "moved"}),
    ).grade == SurpriseGrade.DRIFT
    # ambiguous/changed 永不按 exact 处理（不变量②）
    assert grade_surprise(
        Expectation("anchor", "a1", {}),
        Observation("anchor", "a1", {"status": "ambiguous"}),
    ).escalate
    assert grade_surprise(
        Expectation("anchor", "a1", {}),
        Observation("anchor", "a1", {"status": "gone"}),
    ).grade == SurpriseGrade.BROKEN


def test_latency_over_budget_is_drift_note():
    report = grade_surprise(
        Expectation("tool_result", "x", {}),
        Observation("tool_result", "x", {"text": "ok"}, latency_ms=800, budget_ms=300),
    )
    assert report.grade == SurpriseGrade.DRIFT
    assert any("800ms" in d for d in report.details)


def test_evidence_identity_disagreement_escalates():
    report = grade_surprise(
        Expectation("evidence_agreement", "obj-1", {}),
        Observation("evidence_agreement", "obj-1", {"sources": [
            {"status": "ok", "confidence": 0.9, "identity": "A"},
            {"status": "ok", "confidence": 0.8, "identity": "B"},
        ]}),
    )
    assert report.grade == SurpriseGrade.CONFLICT
    assert report.escalate


# ============================================================================
# 断言记忆（主动遗忘）
# ============================================================================

def test_assertion_store_is_upsert_and_bounded():
    store = AssertionStore(max_assertions=3, ttl_s=3600)
    store.remember(assertion_key("notepad", "document", "h1"), "failure", "路径 A → 503", "run-1", now=1000)
    store.remember(assertion_key("notepad", "document", "h1"), "failure", "路径 A → 200（已修）", "run-2", now=2000)
    cells = store.recall(scope="notepad", limit=5, now=3000)
    assert len(cells) == 1
    assert cells[0].text == "路径 A → 200（已修）"
    assert cells[0].hits == 2
    # 容量上限：最久未用的先被遗忘
    for i in range(5):
        store.remember(assertion_key("edge", "t", f"f{i}"), "fact", f"f{i}", "run-3", now=4000)
    assert len(store) == 3
    assert all(a.key.startswith("edge") for a in store.recall(now=5000))


def test_assertion_expiry_forgets():
    import time as _time
    base = _time.time()
    store = AssertionStore(ttl_s=100)
    store.remember("k", "fact", "旧事实", "run-1", now=base)
    assert store.recall(now=base + 50)
    assert not store.recall(now=base + 200)
    assert len(store) == 0


def test_assertion_prompt_shape_is_one_line_per_cell():
    import time as _time
    store = AssertionStore()
    store.remember("s|o|f", "failure", "路径 A → 503", "run-1", now=_time.time())
    rendered = store.render_for_prompt(scope="s")
    assert rendered == "- [failure] 路径 A → 503"


# ============================================================================
# 模型表面（预算 + 剪枝诚实报告）
# ============================================================================

def _nodes(n: int) -> list[SurfaceNode]:
    return [SurfaceNode(f"n{i}", "text", f"节点{i}", (0, i, 10, 10), coverage=0.9) for i in range(n)]


def test_prune_order_and_honest_ledger():
    nodes = [
        SurfaceNode("deep", "grouping", "装饰容器", (0, 0, 1, 1), depth=4, coverage=1.0),
        SurfaceNode("low", "text", "低覆盖", (0, 0, 1, 1), coverage=0.1),
        SurfaceNode("off", "button", "禁用按钮", (0, 0, 1, 1), state="disabled"),
        *[SurfaceNode(f"keep{i}", "text", f"正文{i}", (0, i, 1, 1), coverage=0.9) for i in range(10)],
    ]
    kept, pruned = prune_nodes(nodes, max_nodes=4)
    assert [n.id for n in kept] == [f"keep{i}" for i in range(4)]
    assert any("装饰容器" in p for p in pruned)
    assert any("覆盖率过低" in p for p in pruned)
    assert any("禁用状态" in p for p in pruned)


def test_surface_budget_and_token_estimate():
    assert estimate_tokens("你好") == 2
    assert estimate_tokens("abcd") == 1
    surface = build_model_surface(
        instruction="把这个表格转成 CSV",
        context_sections=[("证据", "x" * 8000)],
        nodes=_nodes(20),
        surprise_deltas=[{"grade": "conflict", "reason": "anchor:changed", "details": ["目标变了"]}],
        assertions="- [failure] 路径 A → 503",
        budget=SurfaceBudget(max_chars=1000, max_nodes=8),
    )
    assert len(surface.nodes) == 8
    assert surface.total_chars <= 1200  # 指令 + 断言之余量
    assert any("惊奇" in title for title, _ in surface.sections)
    assert any("丢弃节" in p or "已截断" in p for p in surface.pruned)
    assert surface.estimated_tokens > 0


def test_surface_never_silently_truncates():
    surface = build_model_surface(
        instruction="问",
        context_sections=[("证据", "很长的证据" * 500)],
        nodes=[],
        budget=SurfaceBudget(max_chars=200),
    )
    assert any("截断" in p or "预算" in p for p in surface.pruned)


# ============================================================================
# Event-Action 调度循环（极限场景）
# ============================================================================

def _run(loop: EventActionLoop, events: list[Event], initial: LoopState) -> LoopState:
    state = initial
    for event in events:
        _, state = loop.step(state, event)
    return state


def test_start_emits_single_model_turn():
    loop = EventActionLoop()
    actions, state = loop.start("把表格转成 CSV")
    assert [a.kind for a in actions] == ["model_turn"]
    assert state.phase == "reasoning"


def test_preemption_surprise_cancels_inflight_and_reprobes():
    """高并发抢占：surprise(CONFLICT) 必须取消在途工作并插入确定性探针。"""
    loop = EventActionLoop()
    _, state = loop.start("写回")
    state = LoopState(seq=3, phase="executing", actions=[
        Action("tool-1", "tool"), Action("tool-2", "tool"), Action("bg-1", "compact", priority=9),
    ])
    actions, state = loop.step(state, Event(4, "surprise", {"grade": "conflict", "reason": "anchor:changed"}))
    assert [a.kind for a in actions] == ["probe"], "冲突 → 先重定向探针，不继续任何工具"
    assert actions[0].priority == PRIORITY_REGROUND
    assert state.phase == "probing"
    assert any(kind == "cancelled:tool-1:surprise:conflict" for _, kind in state.dag), "抢占必须留取消回执"


def test_self_heal_regrounds_then_resumes():
    """预测失败自愈：BROKEN → probe → 回归 → 模型带着 delta 继续。"""
    loop = EventActionLoop()
    _, state = loop.start("读对象")
    state = LoopState(seq=2, phase="executing", actions=[])
    _, state = loop.step(state, Event(3, "surprise", {"grade": "broken", "reason": "anchor:gone"}))
    assert state.phase == "probing"
    assert state.heal_attempts == 1
    actions, state = loop.step(state, Event(4, "probe_result", {"delta": ["重新找到目标"]}))
    assert state.phase == "reasoning"
    assert [a.kind for a in actions] == ["model_turn"]
    assert actions[0].payload.get("note") == "regrounded"


def test_self_heal_bounded_suspends_as_needs_user():
    """自愈有界：反复失败交回人，绝不盲目重试。"""
    loop = EventActionLoop(LoopParams(max_heal_attempts=2))
    _, state = loop.start("任务")
    state = LoopState(seq=2, phase="executing", actions=[])
    _, state = loop.step(state, Event(3, "surprise", {"grade": "broken", "reason": "x"}))
    _, state = loop.step(state, Event(4, "probe_result", {}))
    _, state = loop.step(state, Event(5, "surprise", {"grade": "broken", "reason": "x"}))
    _, state = loop.step(state, Event(6, "probe_result", {}))
    actions, state = loop.step(state, Event(7, "surprise", {"grade": "broken", "reason": "x"}))
    assert state.phase == "suspended"
    assert [a.kind for a in actions] == ["suspend"]
    assert actions[0].payload.get("reason") == "needs_user"


def test_user_interrupt_wins_over_everything():
    loop = EventActionLoop()
    _, state = loop.start("任务")
    state = LoopState(seq=2, phase="probing", actions=[
        Action("probe-1", "probe", priority=PRIORITY_REGROUND), Action("tool-1", "tool"),
    ])
    actions, state = loop.step(state, Event(3, "user_interrupt"))
    assert actions == []
    assert state.phase == "done"
    assert any(kind == "cancelled:probe-1:user_interrupt" for _, kind in state.dag)


def test_context_starvation_schedules_compaction():
    """上下文极度受限：预算饿死 → 压缩动作排队，而不是静默丢尾巴。"""
    loop = EventActionLoop()
    _, state = loop.start("长任务")
    state = LoopState(seq=2, phase="reasoning", actions=[])
    actions, state = loop.step(state, Event(3, "budget", {"remaining_ms": 1000, "ratio": 0.1}))
    assert state.context_exhausted
    assert [a.kind for a in actions] == ["compact"]


def test_model_output_dispatches_tools_then_finish():
    loop = EventActionLoop()
    _, state = loop.start("任务")
    state = LoopState(seq=2, phase="executing", actions=[])
    actions, state = loop.step(state, Event(3, "model_output", {
        "terminal": "", "tool_calls": [{"name": "read"}, {"name": "grep"}],
    }))
    assert [a.kind for a in actions] == ["tool", "tool"]
    assert state.phase == "executing"
    actions, state = loop.step(state, Event(4, "tool_result", {"ok": True}))
    assert [a.kind for a in actions] == ["model_turn"]
    actions, state = loop.step(state, Event(5, "model_output", {"terminal": "completed"}))
    assert [a.kind for a in actions] == ["finish"]
    assert state.phase == "done"


def test_deterministic_replay():
    """确定性回放：同一事件序列两次驱动，动作轨迹与 DAG 完全一致。"""
    def drive() -> dict:
        loop = EventActionLoop()
        _, state = loop.start("任务")
        state = LoopState(seq=2, phase="executing", actions=[Action("tool-1", "tool")])
        trace = []
        for event in [
            Event(3, "surprise", {"grade": "broken", "reason": "anchor:gone"}),
            Event(4, "probe_result", {"delta": []}),
            Event(5, "budget", {"remaining_ms": 100, "ratio": 0.05}),
            Event(6, "model_output", {"terminal": "needs_user"}),
        ]:
            actions, state = loop.step(state, event)
            trace.append([(a.id, a.kind, a.priority) for a in actions])
        return {"trace": trace, "dag": list(state.dag), "phase": state.phase}

    first = drive()
    second = drive()
    assert first == second
    assert first["phase"] == "suspended"


def test_priority_order_is_stable_on_drain():
    loop = EventActionLoop()
    state = LoopState(seq=1, phase="executing", actions=[
        Action("bg", "compact", priority=9),
        Action("probe", "probe", priority=PRIORITY_REGROUND),
        Action("tool", "tool"),
        Action("stop", "suspend", priority=PRIORITY_USER),
    ])
    ready, rest = loop.drain(state)
    assert [a.id for a in ready] == ["stop", "probe", "tool", "bg"]
    assert rest.actions == []
