"""Event-Action loop core: deterministic scheduling with preemption,
surprise-wake and re-grounding self-heal.

The production loop (loop.py) already owns model/tool execution. This module is
the cognitive scheduler that sits around it: it owns *which* work happens next
and *what the world doing something unexpected means* — the System-1/System-2
arbitration point.

Design rules:

- Every state transition is a pure function ``step(state, event) -> (actions,
  state)``. Same event sequence → same action trace (replay property).
- Priorities: 0 user interrupt, 1 re-ground probe, 5 normal model/tool work,
  9 background. Preemption = cancelling an in-flight action with a synthetic
  cancelled receipt so the DAG stays structurally complete.
- Surprise (CONFLICT/BROKEN) wakes System 2 *with the delta*; EXPECTED/DRIFT
  keep the loop on the zero-token verifier path. A broken world triggers a
  deterministic read-only probe (re-grounding) before any further action;
  repeated failure suspends as needs_user — it never loops blindly.
- Context starvation (budget exhausted on a truncated surface) schedules
  compaction/read_around instead of silently losing the tail.

No I/O, no asyncio, no model calls. Wiring into the async loop.py is a thin
adapter; this core stays replayable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from app.agent_runtime.surprise import SurpriseGrade

# 优先级：数字越小越先执行。
PRIORITY_USER = 0
PRIORITY_REGROUND = 1
PRIORITY_NORMAL = 5
PRIORITY_BACKGROUND = 9


@dataclass(frozen=True)
class Action:
    """One schedulable unit of work."""

    id: str
    kind: str            # model_turn | tool | probe | compact | suspend | finish
    priority: int = PRIORITY_NORMAL
    payload: dict[str, Any] = field(default_factory=dict)
    parent_seq: int | None = None


@dataclass(frozen=True)
class Event:
    """One recorded world event. seq is the global DAG sequence."""

    seq: int
    kind: str            # instruction | model_output | tool_result | surprise
                         # user_interrupt | budget | probe_result | timeout
    payload: dict[str, Any] = field(default_factory=dict)
    parent_seq: int | None = None


@dataclass
class LoopState:
    seq: int = 0
    phase: str = "idle"                    # idle|reasoning|executing|probing|suspended|done
    actions: list[Action] = field(default_factory=list)
    dag: list[tuple[int, str]] = field(default_factory=list)   # (seq, kind) 回放骨架
    surprise_last: str = SurpriseGrade.EXPECTED.value
    heal_attempts: int = 0
    budget_remaining_ms: float | None = None
    context_exhausted: bool = False

    def snapshot(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "phase": self.phase,
            "actions": [{"id": a.id, "kind": a.kind, "priority": a.priority,
                         "payload": a.payload, "parent_seq": a.parent_seq} for a in self.actions],
            "dag": [list(e) for e in self.dag],
            "surprise_last": self.surprise_last,
            "heal_attempts": self.heal_attempts,
            "budget_remaining_ms": self.budget_remaining_ms,
            "context_exhausted": self.context_exhausted,
        }


@dataclass(frozen=True)
class LoopParams:
    max_heal_attempts: int = 2
    context_warn_ratio: float = 0.25     # budget 剩余低于该比例 → 饿上下文
    probe_kind: str = "probe"            # 重定向探针动作 kind


def _emit(state: LoopState, *actions: Action) -> LoopState:
    merged = sorted(state.actions + list(actions), key=lambda a: a.priority)
    return LoopState(
        seq=state.seq,
        phase=state.phase,
        actions=merged,
        dag=state.dag,
        surprise_last=state.surprise_last,
        heal_attempts=state.heal_attempts,
        budget_remaining_ms=state.budget_remaining_ms,
        context_exhausted=state.context_exhausted,
    )


def _cancel_in_flight(state: LoopState, reason: str) -> LoopState:
    """Preempt all in-flight non-user work; every preempted action leaves a
    synthetic cancelled receipt in the DAG so replay stays structurally
    complete (DSH 语义：中断后未启动的调用收到 skipped 结果)."""
    surviving = [a for a in state.actions if a.priority == PRIORITY_USER]
    cancelled = [a for a in state.actions if a.priority != PRIORITY_USER]
    dag = state.dag + [(state.seq, f"cancelled:{a.id}:{reason}") for a in cancelled]
    return LoopState(
        seq=state.seq, phase=state.phase, actions=surviving, dag=dag,
        surprise_last=state.surprise_last, heal_attempts=state.heal_attempts,
        budget_remaining_ms=state.budget_remaining_ms,
        context_exhausted=state.context_exhausted,
    )


class EventActionLoop:
    """The arbitration core. Instantiate per run; feed events; drain actions."""

    def __init__(self, params: LoopParams | None = None):
        self.params = params or LoopParams()

    def start(self, instruction: str, context_tokens: int | None = None) -> tuple[list[Action], LoopState]:
        state = LoopState(seq=1, phase="reasoning", dag=[(1, "instruction")])
        state.budget_remaining_ms = None
        state = _emit(state, Action(id="turn-1", kind="model_turn",
                                    payload={"instruction": instruction,
                                             "context_tokens": context_tokens}))
        return sorted(state.actions, key=lambda a: (a.priority, a.id)), state

    def step(self, state: LoopState, event: Event) -> tuple[list[Action], LoopState]:
        """Feed one event; returns ONLY the newly emitted actions (stable
        priority order). The in-flight queue is internal state — call
        :meth:`drain` to pop ready work. Preempted actions leave the queue
        with synthetic cancelled receipts in the DAG."""
        before_ids = {a.id for a in state.actions}

        def _new(final: LoopState) -> list[Action]:
            return sorted(
                (a for a in final.actions if a.id not in before_ids),
                key=lambda a: (a.priority, a.id),
            )
        state = LoopState(
            seq=event.seq, phase=state.phase, actions=list(state.actions),
            dag=state.dag + [(event.seq, event.kind)], surprise_last=state.surprise_last,
            heal_attempts=state.heal_attempts, budget_remaining_ms=state.budget_remaining_ms,
            context_exhausted=state.context_exhausted,
        )

        # ---- 用户中断永远赢：抢占一切（最高优先级不变量） ----
        if event.kind == "user_interrupt":
            state = _cancel_in_flight(state, "user_interrupt")
            state.phase = "done"
            return [], state

        # ---- 惊奇分级：S2/S3 唤醒 System 2 前先做确定性重定向 ----
        if event.kind == "surprise":
            grade = str(event.payload.get("grade") or SurpriseGrade.DRIFT.value)
            state.surprise_last = grade
            if grade in (SurpriseGrade.CONFLICT.value, SurpriseGrade.BROKEN.value):
                state = _cancel_in_flight(state, f"surprise:{grade}")
                if state.heal_attempts < self.params.max_heal_attempts:
                    state.heal_attempts += 1
                    state.phase = "probing"
                    state = _emit(state, Action(
                        id=f"reprobe-{event.seq}", kind=self.params.probe_kind,
                        priority=PRIORITY_REGROUND,
                        payload={"reason": event.payload.get("reason"),
                                 "delta": event.payload.get("details", [])},
                        parent_seq=event.seq,
                    ))
                else:
                    # 反复失败：交回人，绝不盲目重试（自愈有界）。
                    state.phase = "suspended"
                    state = _emit(state, Action(
                        id=f"suspend-{event.seq}", kind="suspend", priority=PRIORITY_USER,
                        payload={"reason": "needs_user",
                                 "message": f"环境反复与预测不符（{event.payload.get('reason')}），需要你确认。"},
                        parent_seq=event.seq,
                    ))
            else:
                # S0/S1：零 Token 路径继续，模型不参与。
                state.phase = "executing"
            return _new(state), state

        # ---- 重定向探针结果：世界重新对齐后回归主线 ----
        if event.kind == "probe_result":
            if state.phase == "probing":
                state.phase = "reasoning"
                state = _emit(state, Action(
                    id=f"resume-{event.seq}", kind="model_turn",
                    payload={"note": "regrounded", "delta": event.payload.get("delta", [])},
                    parent_seq=event.seq,
                ))
            return _new(state), state

        # ---- 工具结果：期望内 → 继续；惊奇 → 分级事件在外部产生 ----
        if event.kind == "tool_result":
            state.phase = "reasoning"
            state = _emit(state, Action(
                id=f"continue-{event.seq}", kind="model_turn",
                payload={"tool_result": event.payload}, parent_seq=event.seq,
            ))
            return _new(state), state

        # ---- 预算事件：上下文饿死时先压缩，不静默丢尾巴 ----
        if event.kind == "budget":
            remaining = event.payload.get("remaining_ms")
            ratio = event.payload.get("ratio")
            state.budget_remaining_ms = remaining
            if (ratio is not None and ratio <= self.params.context_warn_ratio) \
                    or (remaining is not None and remaining <= 0):
                state.context_exhausted = True
                state = _emit(state, Action(
                    id=f"compact-{event.seq}", kind="compact", priority=PRIORITY_BACKGROUND,
                    payload={"reason": "context_starved"}, parent_seq=event.seq,
                ))
            return _new(state), state

        # ---- 模型输出：终结或继续 ----
        if event.kind == "model_output":
            terminal = str(event.payload.get("terminal") or "")
            if terminal == "completed":
                state.phase = "done"
                state = _emit(state, Action(id=f"finish-{event.seq}", kind="finish",
                                            priority=PRIORITY_USER, parent_seq=event.seq))
            elif terminal in ("needs_user", "permission_required"):
                state.phase = "suspended"
                state = _emit(state, Action(id=f"ask-{event.seq}", kind="suspend",
                                            priority=PRIORITY_USER,
                                            payload={"reason": terminal}, parent_seq=event.seq))
            else:
                state.phase = "executing"
                for index, tool in enumerate(event.payload.get("tool_calls") or []):
                    state = _emit(state, Action(
                        id=f"tool-{event.seq}-{index}", kind="tool",
                        payload={"tool": tool}, parent_seq=event.seq,
                    ))
            return _new(state), state

        if event.kind == "timeout":
            state = _cancel_in_flight(state, "timeout")
            state.phase = "probing"
            state = _emit(state, Action(id=f"reprobe-{event.seq}", kind=self.params.probe_kind,
                                        priority=PRIORITY_REGROUND,
                                        payload={"reason": "timeout"}, parent_seq=event.seq))
            return _new(state), state

        return list(state.actions), state

    def drain(self, state: LoopState) -> tuple[list[Action], LoopState]:
        """Pop the ready queue. Deterministic: stable priority order."""
        ready = sorted(state.actions, key=lambda a: (a.priority, a.id))
        rest = LoopState(seq=state.seq, phase=state.phase, actions=[],
                         dag=state.dag, surprise_last=state.surprise_last,
                         heal_attempts=state.heal_attempts,
                         budget_remaining_ms=state.budget_remaining_ms,
                         context_exhausted=state.context_exhausted)
        return ready, rest
