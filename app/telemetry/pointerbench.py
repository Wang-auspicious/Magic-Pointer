"""PointerBench: three-way task comparison base (harness gap review L13).

A fixed set of real tasks (browser/Office/WeChat/PDF/terminal), each run by
Magic Pointer, a pure-screenshot CUA, and a human baseline. This module owns
the task/run schema, JSON persistence, and honest report generation: a
backend with no runs is reported as not collected, never as zero performance.

This module is pure Python with no UI, OCR, or platform dependencies; its
only I/O is the JSON runs file.
"""

from __future__ import annotations

import enum
import json
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import ceil, floor
from pathlib import Path
from typing import Any

BENCH_SCHEMA = "pointerbench_runs"
BENCH_VERSION = 1
DIFFICULTIES = ("easy", "medium", "hard")

_REQUIRED_RUN_KEYS = frozenset(
    {"task_id", "backend", "succeeded", "e2e_latency_ms", "tokens", "reference_accuracy"}
)


class BenchError(Exception):
    """Base error for PointerBench misuse and persistence failures."""


class BenchDuplicateError(BenchError):
    """The (task_id, backend) pair was already recorded."""


class BenchUnknownTaskError(BenchError):
    """The run references a task that is not registered."""


class BackendTag(enum.StrEnum):
    """The three PointerBench groups."""

    MAGIC_POINTER = "magic_pointer"
    SCREEN_CUA = "screen_cua"
    HUMAN = "human"


@dataclass(frozen=True, slots=True)
class BenchTask:
    """One real task; ``difficulty`` is one of easy/medium/hard."""

    task_id: str
    app: str
    target: str
    goal: str
    expected_result: str
    difficulty: str

    def __post_init__(self) -> None:
        if not self.task_id.strip():
            raise ValueError("task_id must be non-empty")
        if self.difficulty not in DIFFICULTIES:
            raise ValueError(
                f"difficulty must be one of {DIFFICULTIES}, got {self.difficulty!r}"
            )


@dataclass(frozen=True, slots=True)
class BenchRun:
    """One backend's execution of one task.

    Validation invariants:
    - ``e2e_latency_ms``/``tokens`` are ``None`` or non-negative.
    - ``reference_accuracy`` is ``None`` or within 0..1.
    """

    task_id: str
    backend: BackendTag
    succeeded: bool
    e2e_latency_ms: float | None = None
    tokens: int | None = None
    reference_accuracy: float | None = None

    def __post_init__(self) -> None:
        if self.e2e_latency_ms is not None and self.e2e_latency_ms < 0:
            raise ValueError(f"e2e_latency_ms must be non-negative, got {self.e2e_latency_ms!r}")
        if self.tokens is not None and self.tokens < 0:
            raise ValueError(f"tokens must be non-negative, got {self.tokens!r}")
        if self.reference_accuracy is not None and not 0.0 <= self.reference_accuracy <= 1.0:
            raise ValueError(
                f"reference_accuracy must be within 0..1, got {self.reference_accuracy!r}"
            )


@dataclass(frozen=True, slots=True)
class BackendStats:
    """Per-backend report row.

    ``None`` fields mean "no data" (no runs at all, or no run carrying that
    measurement), which is distinct from a zero.
    """

    backend: BackendTag
    runs: int
    succeeded: int
    success_rate: float | None
    latency_p50_ms: float | None
    latency_p95_ms: float | None
    tokens_total: int
    reference_accuracy_mean: float | None


@dataclass(frozen=True, slots=True)
class BenchReport:
    """Three-way comparison table plus honest missing-group annotation."""

    task_total: int
    stats: tuple[BackendStats, ...]
    missing_backends: tuple[str, ...]


class PointerBench:
    """Task registry + run recorder + report generator."""

    def __init__(self, tasks: Sequence[BenchTask]) -> None:
        self._tasks: dict[str, BenchTask] = {t.task_id: t for t in tasks}
        self._runs: dict[tuple[str, BackendTag], BenchRun] = {}
        self._lock = threading.Lock()

    def record_run(self, run: BenchRun) -> None:
        """Record a run; unknown task or duplicate (task_id, backend) rejected."""
        if run.task_id not in self._tasks:
            raise BenchUnknownTaskError(f"task {run.task_id!r} is not registered")
        with self._lock:
            key = (run.task_id, run.backend)
            if key in self._runs:
                raise BenchDuplicateError(f"run for {key} already recorded")
            self._runs[key] = run

    def save_runs(self, path: str | Path) -> None:
        """Write all recorded runs as a versioned JSON file."""
        with self._lock:
            runs = list(self._runs.values())
        payload = {
            "schema": BENCH_SCHEMA,
            "version": BENCH_VERSION,
            "runs": [_run_to_dict(r) for r in runs],
        }
        Path(path).write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    def load_runs(self, path: str | Path) -> list[BenchRun]:
        """Adopt runs from a JSON file, replacing the current run store.

        The file must match the runs schema; malformed files, unknown tasks,
        and duplicate (task_id, backend) pairs raise :class:`BenchError`.
        """
        try:
            raw = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BenchError(f"cannot read runs file {path}: {exc}") from exc
        if not isinstance(raw, dict):
            raise BenchError(f"{path} is not a runs object")
        if raw.get("schema") != BENCH_SCHEMA or raw.get("version") != BENCH_VERSION:
            raise BenchError(f"{path} is not a {BENCH_SCHEMA} v{BENCH_VERSION} file")
        raw_runs = raw.get("runs")
        if not isinstance(raw_runs, list):
            raise BenchError(f"{path} has no runs list")
        try:
            runs = [_run_from_dict(r) for r in raw_runs]
        except (KeyError, TypeError, ValueError) as exc:
            raise BenchError(f"{path} contains an invalid run: {exc}") from exc
        loaded: dict[tuple[str, BackendTag], BenchRun] = {}
        for run in runs:
            if run.task_id not in self._tasks:
                raise BenchError(f"{path} references unknown task {run.task_id!r}")
            key = (run.task_id, run.backend)
            if key in loaded:
                raise BenchError(f"{path} contains duplicate run for {key}")
            loaded[key] = run
        with self._lock:
            self._runs = loaded
        return runs

    def generate_report(self) -> BenchReport:
        """Build per-backend stats; backends with zero runs go to missing."""
        with self._lock:
            runs = list(self._runs.values())
        stats = [_stats_for(backend, [r for r in runs if r.backend is backend]) for backend in BackendTag]
        missing = tuple(s.backend.value for s in stats if s.runs == 0)
        return BenchReport(task_total=len(self._tasks), stats=tuple(stats), missing_backends=missing)


def _stats_for(backend: BackendTag, runs: list[Any]) -> BackendStats:
    """Aggregate one backend's runs; ``None`` marks absent data, not zero."""
    if not runs:
        return BackendStats(
            backend=backend,
            runs=0,
            succeeded=0,
            success_rate=None,
            latency_p50_ms=None,
            latency_p95_ms=None,
            tokens_total=0,
            reference_accuracy_mean=None,
        )
    latencies = [r.e2e_latency_ms for r in runs if r.e2e_latency_ms is not None]
    accuracies = [r.reference_accuracy for r in runs if r.reference_accuracy is not None]
    return BackendStats(
        backend=backend,
        runs=len(runs),
        succeeded=sum(r.succeeded for r in runs),
        success_rate=sum(r.succeeded for r in runs) / len(runs),
        latency_p50_ms=_percentile(latencies, 50) if latencies else None,
        latency_p95_ms=_percentile(latencies, 95) if latencies else None,
        tokens_total=sum(r.tokens for r in runs if r.tokens is not None),
        reference_accuracy_mean=sum(accuracies) / len(accuracies) if accuracies else None,
    )


def _percentile(values: Sequence[float], p: float) -> float:
    """Linear-interpolated percentile; requires a non-empty sequence."""
    ordered = sorted(values)
    if not ordered:
        raise ValueError("cannot compute percentile of empty sequence")
    k = (len(ordered) - 1) * (p / 100.0)
    low = floor(k)
    high = ceil(k)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - k) + ordered[high] * (k - low)


def _run_to_dict(run: BenchRun) -> dict[str, Any]:
    return {
        "task_id": run.task_id,
        "backend": run.backend.value,
        "succeeded": run.succeeded,
        "e2e_latency_ms": run.e2e_latency_ms,
        "tokens": run.tokens,
        "reference_accuracy": run.reference_accuracy,
    }


def _run_from_dict(d: Mapping[str, Any]) -> BenchRun:
    """Reconstruct a run with strict schema validation (load)."""
    if not isinstance(d, dict):
        raise TypeError(f"run is {type(d).__name__}, expected dict")
    missing = _REQUIRED_RUN_KEYS - d.keys()
    if missing:
        raise KeyError(f"run missing fields {sorted(missing)}")
    if not isinstance(d["task_id"], str):
        raise TypeError("task_id must be a string")
    if not isinstance(d["backend"], str):
        raise TypeError("backend must be a string")
    if not isinstance(d["succeeded"], bool):
        raise TypeError("succeeded must be a bool")
    if isinstance(d["e2e_latency_ms"], bool) or not (
        d["e2e_latency_ms"] is None or isinstance(d["e2e_latency_ms"], (int, float))
    ):
        raise TypeError("e2e_latency_ms must be a number or null")
    if isinstance(d["tokens"], bool) or not (d["tokens"] is None or isinstance(d["tokens"], int)):
        raise TypeError("tokens must be an int or null")
    if isinstance(d["reference_accuracy"], bool) or not (
        d["reference_accuracy"] is None or isinstance(d["reference_accuracy"], (int, float))
    ):
        raise TypeError("reference_accuracy must be a number or null")
    return BenchRun(
        task_id=d["task_id"],
        backend=BackendTag(d["backend"]),
        succeeded=d["succeeded"],
        e2e_latency_ms=d["e2e_latency_ms"],
        tokens=d["tokens"],
        reference_accuracy=d["reference_accuracy"],
    )
