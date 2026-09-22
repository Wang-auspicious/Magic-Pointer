
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
    pass


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
