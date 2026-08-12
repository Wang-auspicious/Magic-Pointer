"""Enforced perception evidence contract (harness gap review L6).

Pure Python: no UI automation, Electron, or OS-specific APIs here.
"""

from .contract import (
    MIN_CONFIDENCE_FOR_TRUST,
    Evidence,
    EvidenceSource,
    EvidenceStatus,
    apply_container_heuristic,
    busy_evidence,
    empty_confirmed,
    failed_evidence,
    is_trustworthy,
    merge_for_decision,
    ok_evidence,
)

__all__ = [
    "MIN_CONFIDENCE_FOR_TRUST",
    "Evidence",
    "EvidenceSource",
    "EvidenceStatus",
    "apply_container_heuristic",
    "busy_evidence",
    "empty_confirmed",
    "failed_evidence",
    "is_trustworthy",
    "merge_for_decision",
    "ok_evidence",
]
