"""Receipt value objects.

A Receipt is the stop proof. The model saying it is done is not enough;
the loop issues one of these before it yields LoopStopped.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass


class ReceiptStatus(enum.StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    PARTIAL = "partial"
    INTERRUPTED = "interrupted"
    UNKNOWN = "unknown"
    UNVERIFIED = "unverified"


class ReceiptProjectionError(RuntimeError):
    """The event stream cannot be projected into a Receipt without inventing state."""


@dataclass(frozen=True, slots=True)
class Receipt:
    receipt_id: str
    status: ReceiptStatus
    effect: str
    verification_method: str
    used_backend: str
    artifact_ids: tuple[str, ...]
    wrote: bool
    verified: bool
    failure_type: str | None = None
    memory_eligible: bool = False
