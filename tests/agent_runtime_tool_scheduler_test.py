"""DSH-style bounded, ordered tool-call scheduling contracts."""

from __future__ import annotations

import threading
import time

import pytest

from app.agent_runtime.tool_scheduler import (
    ScheduledCallCommitted,
    ScheduledCallStarted,
    schedule_tool_calls,
)
from app.agent_runtime.types import ToolCall, ToolResult
from app.governance.cancellation import CancelledError


def _call(index: int, name: str = "read") -> ToolCall:
    return ToolCall(id=f"c{index}", name=name, arguments={"index": index})


def _result(call: ToolCall, value: str | None = None) -> ToolResult:
    return ToolResult(
        tool_call_id=call.id,
        value=value or call.id,
        is_error=False,
        failure_type=None,
        used_backend="fake",
        latency_ms=1.0,
    )


def test_parallel_pool_is_bounded_and_replenishes_as_calls_settle() -> None:
    lock = threading.Lock()
    active = 0
    peak = 0
    executed: list[str] = []

    def execute(call: ToolCall) -> ToolResult:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            executed.append(call.id)
        time.sleep(0.015)
        with lock:
            active -= 1
        return _result(call)

    events = list(
        schedule_tool_calls(
            [_call(index) for index in range(1, 6)],
            classify=lambda _call: "parallel",
            execute=execute,
            max_parallel_tool_calls=2,
        )
    )

    assert peak == 2
    assert executed == ["c1", "c2", "c3", "c4", "c5"]
    assert [
        event.call.id for event in events if isinstance(event, ScheduledCallCommitted)
    ] == ["c1", "c2", "c3", "c4", "c5"]


def test_exclusive_calls_form_barriers_between_parallel_groups() -> None:
    order: list[str] = []

    def execute(call: ToolCall) -> ToolResult:
        order.append(f"start:{call.id}")
        time.sleep(0.005)
        order.append(f"end:{call.id}")
        return _result(call)

    calls = [_call(1), _call(2), _call(3, "write"), _call(4)]
    list(
        schedule_tool_calls(
            calls,
            classify=lambda call: "exclusive" if call.name == "write" else "parallel",
            execute=execute,
            max_parallel_tool_calls=2,
        )
    )

    write_start = order.index("start:c3")
    assert order.index("end:c1") < write_start
    assert order.index("end:c2") < write_start
    assert order.index("end:c3") < order.index("start:c4")


def test_results_commit_in_model_order_when_settlement_is_out_of_order() -> None:
    def execute(call: ToolCall) -> ToolResult:
        time.sleep(0.04 if call.id == "c1" else 0.002)
        return _result(call)

    events = list(
        schedule_tool_calls(
            [_call(1), _call(2)],
            classify=lambda _call: "parallel",
            execute=execute,
            max_parallel_tool_calls=2,
        )
    )

    assert [
        event.call.id for event in events if isinstance(event, ScheduledCallCommitted)
    ] == ["c1", "c2"]


def test_matching_resource_keys_never_overlap_but_other_resources_still_do() -> None:
    lock = threading.Lock()
    active_by_resource: dict[str, int] = {}
    overlapping_resources: list[str] = []
    peak = 0

    calls = [
        ToolCall(id="c1", name="read", arguments={"resource": "desktop"}),
        ToolCall(id="c2", name="read", arguments={"resource": "desktop"}),
        ToolCall(id="c3", name="read", arguments={"resource": "network"}),
    ]

    def execute(call: ToolCall) -> ToolResult:
        nonlocal peak
        resource = str(call.arguments["resource"])
        with lock:
            active_by_resource[resource] = active_by_resource.get(resource, 0) + 1
            if active_by_resource[resource] > 1:
                overlapping_resources.append(resource)
            peak = max(peak, sum(active_by_resource.values()))
        time.sleep(0.015)
        with lock:
            active_by_resource[resource] -= 1
        return _result(call)

    events = list(
        schedule_tool_calls(
            calls,
            classify=lambda _call: "parallel",
            conflict_keys=lambda call: (str(call.arguments["resource"]),),
            execute=execute,
            max_parallel_tool_calls=2,
        )
    )

    assert overlapping_resources == []
    assert peak == 2
    assert [
        event.call.id for event in events if isinstance(event, ScheduledCallCommitted)
    ] == ["c1", "c2", "c3"]


def test_invalid_resource_key_resolution_fails_closed_as_exclusive() -> None:
    active = 0
    peak = 0
    lock = threading.Lock()

    def execute(call: ToolCall) -> ToolResult:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.01)
        with lock:
            active -= 1
        return _result(call)

    list(
        schedule_tool_calls(
            [_call(1), _call(2)],
            classify=lambda _call: "parallel",
            conflict_keys=lambda _call: ("",),
            execute=execute,
            max_parallel_tool_calls=2,
        )
    )

    assert peak == 1


def test_abort_drains_started_call_and_synthesizes_unstarted_results() -> None:
    cancelled = False
    executed: list[str] = []
    observed = []

    def execute(call: ToolCall) -> ToolResult:
        nonlocal cancelled
        executed.append(call.id)
        cancelled = True
        return _result(call)

    generator = schedule_tool_calls(
        [_call(1), _call(2), _call(3)],
        classify=lambda _call: "parallel",
        execute=execute,
        max_parallel_tool_calls=1,
        is_cancelled=lambda: cancelled,
    )
    with pytest.raises(CancelledError):
        while True:
            observed.append(next(generator))

    assert executed == ["c1"]
    starts = [event for event in observed if isinstance(event, ScheduledCallStarted)]
    assert [(event.call.id, event.dispatched) for event in starts] == [
        ("c1", True),
        ("c2", False),
        ("c3", False),
    ]
    committed = [
        event for event in observed if isinstance(event, ScheduledCallCommitted)
    ]
    assert [event.call.id for event in committed] == ["c1", "c2", "c3"]
    assert committed[0].result.is_error is False
    assert all(event.result.is_error for event in committed[1:])
    assert all("before dispatch" in event.result.value for event in committed[1:])


@pytest.mark.parametrize("value", [0, -1, 1.5, True])
def test_parallel_cap_must_be_a_positive_integer(value) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        list(
            schedule_tool_calls(
                [],
                classify=lambda _call: "parallel",
                execute=_result,
                max_parallel_tool_calls=value,
            )
        )
