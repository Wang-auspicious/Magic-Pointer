"""Bounded, model-ordered scheduling for one model tool-call batch.

The execution semantics follow DeepSeek Harness's MIT-licensed rolling-pool
scheduler: parallel-safe calls overlap behind a cap, exclusive calls form
barriers, physical settlement may be out of order, and committed results stay
in the model's original order. Kimi-style resource keys prevent overlapping
access to the same input device, store, document or plugin-owned resource.
Cancellation drains started work and creates explicit results for calls that
were accepted from the model but never dispatched, keeping replay
structurally valid.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, Sequence
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Literal

from app.agent_runtime.errors import FailureType
from app.agent_runtime.types import ToolCall, ToolResult
from app.governance.cancellation import CancelledError

ExecutionMode = Literal["parallel", "exclusive"]

_ABORTED_BEFORE_DISPATCH = "tool call aborted before dispatch"
_OUTCOME_UNKNOWN_AFTER_DISPATCH = (
    "tool call was cancelled after dispatch; external outcome may be unknown"
)


@dataclass(frozen=True, slots=True)
class ScheduledCallStarted:
    """One accepted call entered the durable scheduling lane.

    ``dispatched`` is false for a synthetic cancelled call.  Callers should
    still journal its call/result pair, but should not present it as executing.
    """

    call: ToolCall
    dispatched: bool


@dataclass(frozen=True, slots=True)
class ScheduledCallCommitted:
    """One result ready to append in the model's original call order."""

    call: ToolCall
    result: ToolResult
    dispatched: bool


ToolScheduleEvent = ScheduledCallStarted | ScheduledCallCommitted


def schedule_tool_calls(
    calls: Sequence[ToolCall],
    *,
    classify: Callable[[ToolCall], ExecutionMode | str],
    conflict_keys: Callable[[ToolCall], Iterable[str]] | None = None,
    execute: Callable[[ToolCall], ToolResult],
    max_parallel_tool_calls: int = 4,
    is_cancelled: Callable[[], bool] | None = None,
) -> Iterator[ToolScheduleEvent]:
    """Schedule ``calls`` with exclusive barriers and ordered commits.

    ``classify`` and ``conflict_keys`` are evaluated immediately before each
    start, so a committed tool may replace or reconfigure a later tool. Only
    the exact string
    ``"parallel"`` opts into overlap; errors and unknown values fail closed as
    exclusive.  If cancellation is observed, already-started calls drain,
    unstarted calls receive synthetic errors, and :class:`CancelledError` is
    raised after the event stream has become replay-safe.
    """
    if (
        isinstance(max_parallel_tool_calls, bool)
        or not isinstance(max_parallel_tool_calls, int)
        or max_parallel_tool_calls <= 0
    ):
        raise ValueError("max_parallel_tool_calls must be a positive integer")

    cancelled = is_cancelled if is_cancelled is not None else (lambda: False)
    planned = list(calls)
    cursor = 0
    while cursor < len(planned):
        if cancelled():
            yield from _skipped_events(planned[cursor:])
            raise CancelledError("tool batch cancelled before dispatch")

        first = planned[cursor]
        if _claim(classify, conflict_keys, first)[0] == "exclusive":
            yield ScheduledCallStarted(first, dispatched=True)
            try:
                result = execute(first)
            except CancelledError as exc:
                yield ScheduledCallCommitted(
                    first,
                    _cancelled_after_dispatch(first),
                    dispatched=True,
                )
                cursor += 1
                yield from _skipped_events(planned[cursor:])
                raise exc
            yield ScheduledCallCommitted(first, result, dispatched=True)
            cursor += 1
            if cancelled():
                yield from _skipped_events(planned[cursor:])
                raise CancelledError("tool batch cancelled after dispatch")
            continue

        cursor, was_cancelled, cancellation_error = yield from _parallel_group(
            planned,
            cursor,
            classify=classify,
            conflict_keys=conflict_keys,
            execute=execute,
            max_parallel_tool_calls=max_parallel_tool_calls,
            is_cancelled=cancelled,
        )
        if was_cancelled:
            yield from _skipped_events(planned[cursor:])
            if cancellation_error is not None:
                raise cancellation_error
            raise CancelledError("tool batch cancelled")


def _parallel_group(
    calls: list[ToolCall],
    start: int,
    *,
    classify: Callable[[ToolCall], ExecutionMode | str],
    conflict_keys: Callable[[ToolCall], Iterable[str]] | None,
    execute: Callable[[ToolCall], ToolResult],
    max_parallel_tool_calls: int,
    is_cancelled: Callable[[], bool],
) -> Iterator[ToolScheduleEvent]:
    """Run the next live parallel group and return its next unstarted index."""
    next_to_start = start
    next_to_commit = start
    settled: dict[int, tuple[ToolResult, bool]] = {}
    in_flight: dict[Future[ToolResult], tuple[int, frozenset[str]]] = {}
    active_keys: set[str] = set()
    cancelled = False
    cancellation_error: CancelledError | None = None

    with ThreadPoolExecutor(
        max_workers=max_parallel_tool_calls,
        thread_name_prefix="mp-tool",
    ) as pool:
        while True:
            while (
                not cancelled
                and len(in_flight) < max_parallel_tool_calls
                and next_to_start < len(calls)
            ):
                if is_cancelled():
                    cancelled = True
                    break
                call = calls[next_to_start]
                mode, keys = _claim(classify, conflict_keys, call)
                if mode == "exclusive" or active_keys.intersection(keys):
                    break
                yield ScheduledCallStarted(call, dispatched=True)
                future = pool.submit(execute, call)
                in_flight[future] = (next_to_start, keys)
                active_keys.update(keys)
                next_to_start += 1

            if not in_flight:
                break

            done, _pending = wait(tuple(in_flight), return_when=FIRST_COMPLETED)
            for future in done:
                index, keys = in_flight.pop(future)
                active_keys.difference_update(keys)
                call = calls[index]
                try:
                    result = future.result()
                except CancelledError as exc:
                    cancelled = True
                    cancellation_error = cancellation_error or exc
                    result = _cancelled_after_dispatch(call)
                settled[index] = (result, True)

            while next_to_commit in settled:
                result, dispatched = settled.pop(next_to_commit)
                call = calls[next_to_commit]
                yield ScheduledCallCommitted(call, result, dispatched=dispatched)
                next_to_commit += 1

            if is_cancelled():
                cancelled = True

        # ``ThreadPoolExecutor.__exit__`` has drained every submitted body.
        # A lower model-order call can only be absent here if execution raised
        # an internal scheduler error, which future.result() deliberately
        # propagated instead of fabricating a model-visible result.
        while next_to_commit in settled:
            result, dispatched = settled.pop(next_to_commit)
            call = calls[next_to_commit]
            yield ScheduledCallCommitted(call, result, dispatched=dispatched)
            next_to_commit += 1

    return next_to_start, cancelled, cancellation_error


def _mode(
    classify: Callable[[ToolCall], ExecutionMode | str], call: ToolCall
) -> ExecutionMode:
    try:
        return "parallel" if classify(call) == "parallel" else "exclusive"
    except Exception:  # noqa: BLE001 -- classification failure is exclusive
        return "exclusive"


def _claim(
    classify: Callable[[ToolCall], ExecutionMode | str],
    conflict_keys: Callable[[ToolCall], Iterable[str]] | None,
    call: ToolCall,
) -> tuple[ExecutionMode, frozenset[str]]:
    """Resolve one live scheduling claim; uncertainty is exclusive."""
    mode = _mode(classify, call)
    if mode == "exclusive" or conflict_keys is None:
        return mode, frozenset()
    try:
        raw_keys = conflict_keys(call)
        if isinstance(raw_keys, str):
            raise ValueError("conflict keys must be an iterable of strings")
        keys = tuple(raw_keys)
        if not all(isinstance(key, str) and bool(key.strip()) for key in keys):
            raise ValueError("conflict keys must be non-empty strings")
        return "parallel", frozenset(key.strip() for key in keys)
    except Exception:  # noqa: BLE001 -- resource uncertainty is exclusive
        return "exclusive", frozenset()


def _skipped_events(calls: Sequence[ToolCall]) -> Iterator[ToolScheduleEvent]:
    for call in calls:
        yield ScheduledCallStarted(call, dispatched=False)
        yield ScheduledCallCommitted(
            call,
            ToolResult(
                tool_call_id=call.id,
                value=_ABORTED_BEFORE_DISPATCH,
                is_error=True,
                failure_type=FailureType.TOOL_ERROR,
                used_backend=None,
                latency_ms=0.0,
            ),
            dispatched=False,
        )


def _cancelled_after_dispatch(call: ToolCall) -> ToolResult:
    return ToolResult(
        tool_call_id=call.id,
        value=_OUTCOME_UNKNOWN_AFTER_DISPATCH,
        is_error=True,
        failure_type=FailureType.TOOL_ERROR,
        used_backend=None,
        latency_ms=None,
    )
