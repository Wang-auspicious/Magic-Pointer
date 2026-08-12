"""Diagnostics and telemetry: the /doctor report and per-app capability
summary (harness gap review L13/L14, task C1).

Pure Python, stdlib-only. No I/O, no Electron coupling, no UI automation.
"""

from .doctor_report import (
    DoctorReport,
    HealthCheck,
    HealthCheckResult,
    build_doctor_report,
)

__all__ = [
    "DoctorReport",
    "HealthCheck",
    "HealthCheckResult",
    "build_doctor_report",
]
