"""One-shot diagnostics report, the ``/doctor`` equivalent (review L13/L14, task C1).

Answers "which applications offer which capabilities right now, is the UIA
host resident, is OCR warmed up, is the model endpoint healthy" in a single
frozen snapshot.

Veridict semantics: ``unknown`` is **not** a failure. Only an explicit
``failed`` check degrades the report; any ``ok`` and no ``failed`` yields
``healthy``; everything unknown (or no checks) yields ``unknown``.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

import datetime
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from app.permissions.capability_matrix import CapabilityMatrix

_UTC_CLOCK = lambda: datetime.datetime.now(datetime.UTC).isoformat()  # noqa: E731


@dataclass(frozen=True, slots=True)
class HealthCheck:
    """One probe result."""

    check_id: str
    label: str
    status: str
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class DoctorReport:
    """A full diagnostic snapshot."""

    generated_at_utc: str
    checks: tuple[HealthCheck, ...]
    capability_summary: dict[str, dict]
    verdict: str


class HealthCheckResult:
    """Factories for the three check states.

    ``check_id`` is derived from the label (lowercased, spaces and non
    alphanumerics replaced) so factories stay one-argument friendly.
    """

    @staticmethod
    def ok(label: str, detail: str | None = None) -> HealthCheck:
        return HealthCheck(check_id=_slug(label), label=label, status="ok", detail=detail)

    @staticmethod
    def fail(label: str, detail: str | None) -> HealthCheck:
        return HealthCheck(check_id=_slug(label), label=label, status="failed", detail=detail)

    @staticmethod
    def unknown(label: str) -> HealthCheck:
        return HealthCheck(check_id=_slug(label), label=label, status="unknown")


def _slug(label: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in label.lower())


def _verdict(checks: Sequence[HealthCheck]) -> str:
    if any(c.status == "failed" for c in checks):
        return "degraded"
    if any(c.status == "ok" for c in checks):
        return "healthy"
    return "unknown"


def _summary(matrix: CapabilityMatrix) -> dict[str, dict[str, str]]:
    return {
        app: {
            capability.value: status.value
            for capability, status in matrix.status_for(app).items()
        }
        for app in matrix.apps()
    }


def build_doctor_report(
    matrix: CapabilityMatrix,
    checks: Sequence[HealthCheck],
    clock: Callable[[], str] | None = None,
) -> DoctorReport:
    """Build a report from the matrix and the probe results.

    ``clock`` returns the UTC timestamp string (defaults to now in UTC);
    inject a fixed clock for determinism in tests and dashboards.
    """
    generated_at = clock() if clock is not None else _UTC_CLOCK()
    return DoctorReport(
        generated_at_utc=generated_at,
        checks=tuple(checks),
        capability_summary=_summary(matrix),
        verdict=_verdict(checks),
    )
