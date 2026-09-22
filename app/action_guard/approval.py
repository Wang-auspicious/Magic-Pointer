
from __future__ import annotations

import enum
import threading
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime

from app.agent_runtime.tool_registry import Effect
from app.agent_runtime.types import ORIGIN_DATA, ORIGIN_INSTRUCTION

NON_HUMAN_APPROVERS = ("model", "tool", "agent")

_APPROVAL_REQUIRED = frozenset(
    {
        Effect.LOCAL_IRREVERSIBLE,
        Effect.EXTERNAL_SEND,
        Effect.DESTRUCTIVE,
        Effect.PURCHASE,
    }
)


class ApprovalStatus(enum.StrEnum):

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"


@dataclass(frozen=True, slots=True)
class ApprovalRequest:

    request_id: str
    tool_name: str
    target_identity: str
    content_hash: str | None
    effect: Effect
    origin: str
    requested_at_utc: str
    status: ApprovalStatus = ApprovalStatus.PENDING
    status_changed_at_utc: str | None = None


class ApprovalError(Exception):

    __slots__ = ("request_id", "reason")

    def __init__(self, request_id: str, reason: str) -> None:
        super().__init__(f"approval {request_id!r}: {reason}")
        self.request_id = request_id
        self.reason = reason


def _now_utc() -> str:
    return (
        datetime.now(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class ActionApproval:

    __slots__ = ("_lock", "_requests", "_reasons")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: dict[str, ApprovalRequest] = {}
        self._reasons: dict[str, str] = {}

    @staticmethod
    def requires_approval(effect: Effect) -> bool:
        return effect in _APPROVAL_REQUIRED

    def request(
        self,
        tool_name: str,
        target_identity: str,
        content_hash: str | None,
        effect: Effect,
        origin: str = ORIGIN_DATA,
    ) -> ApprovalRequest:
        if not isinstance(tool_name, str) or not tool_name:
            raise ValueError("tool_name must be a non-empty str")
        if not isinstance(target_identity, str) or not target_identity:
            raise ValueError("target_identity must be a non-empty str")
        if content_hash is not None and not isinstance(content_hash, str):
            raise TypeError("content_hash must be a str or None")
        if not isinstance(effect, Effect):
            raise TypeError(
                f"effect must be an Effect member, got {effect!r}"
            )
        if origin not in (ORIGIN_INSTRUCTION, ORIGIN_DATA):
            raise ValueError(
                f"origin must be {ORIGIN_INSTRUCTION!r} or {ORIGIN_DATA!r}, "
                f"got {origin!r}"
            )
        request = ApprovalRequest(
            request_id=uuid.uuid4().hex,
            tool_name=tool_name,
            target_identity=target_identity,
            content_hash=content_hash,
            effect=effect,
            origin=origin,
            requested_at_utc=_now_utc(),
        )
        with self._lock:
            self._requests[request.request_id] = request
        return request

    def approve(self, request_id: str, *, by: str) -> ApprovalRequest:
        self._ensure_human(by, request_id)
        with self._lock:
            current = self._requests.get(request_id)
            if current is None:
                raise ApprovalError(request_id, "unknown request")
            if current.status is ApprovalStatus.APPROVED:
                return current
            if current.status is ApprovalStatus.REJECTED:
                reason = self._reasons.get(request_id, "")
                suffix = f" (rejected: {reason})" if reason else ""
                raise ApprovalError(
                    request_id, f"cannot approve a rejected request{suffix}"
                )
            if current.status is ApprovalStatus.EXPIRED:
                reason = self._reasons.get(request_id, "")
                suffix = f" ({reason})" if reason else ""
                raise ApprovalError(
                    request_id,
                    f"request expired; must request anew{suffix}",
                )
            return self._transition(request_id, ApprovalStatus.APPROVED)

    def approve_reversible(
        self, request_id: str, *, by: str
    ) -> ApprovalRequest:
        with self._lock:
            current = self._requests.get(request_id)
        if current is None:
            raise ApprovalError(request_id, "unknown request")
        if self.requires_approval(current.effect):
            raise ApprovalError(
                request_id,
                f"approve_reversible refused for effect "
                f"{current.effect.value!r}; use approve()",
            )
        return self.approve(request_id, by=by)

    def reject(
        self, request_id: str, *, by: str, reason: str = ""
    ) -> ApprovalRequest:
        if not isinstance(by, str) or not by:
            raise ApprovalError(request_id, "reject needs a non-empty actor")
        with self._lock:
            current = self._requests.get(request_id)
            if current is None:
                raise ApprovalError(request_id, "unknown request")
            if current.status is ApprovalStatus.EXPIRED:
                raise ApprovalError(request_id, "request expired; cannot reject")
            if current.status is ApprovalStatus.REJECTED:
                return current
            if reason:
                self._reasons[request_id] = reason
            return self._transition(request_id, ApprovalStatus.REJECTED)

    def invalidate(self, request_id: str, reason: str = "") -> ApprovalRequest:
        with self._lock:
            current = self._requests.get(request_id)
            if current is None:
                raise ApprovalError(request_id, "unknown request")
            if current.status not in (
                ApprovalStatus.PENDING,
                ApprovalStatus.APPROVED,
            ):
                return current
            if reason:
                self._reasons[request_id] = reason
            return self._transition(request_id, ApprovalStatus.EXPIRED)

    def status(self, request_id: str) -> ApprovalStatus:
        with self._lock:
            current = self._requests.get(request_id)
        if current is None:
            raise ApprovalError(request_id, "unknown request")
        return current.status

    @staticmethod
    def is_approved(request: ApprovalRequest) -> bool:
        return request.status is ApprovalStatus.APPROVED

    def pending(self) -> list[ApprovalRequest]:
        with self._lock:
            return [
                r
                for r in self._requests.values()
                if r.status is ApprovalStatus.PENDING
            ]

    def all_requests(self) -> list[ApprovalRequest]:
        with self._lock:
            return list(self._requests.values())

    def records(self) -> list[ApprovalRequest]:
        return self.all_requests()

    @staticmethod
    def _ensure_human(by: str, request_id: str) -> None:
        if not isinstance(by, str) or not by:
            raise ApprovalError(request_id, "approver must be a non-empty str")
        if by in NON_HUMAN_APPROVERS:
            raise ApprovalError(
                request_id,
                f"approval cannot come from {by!r}; only a real human "
                "entry may approve",
            )

    def _transition(
        self, request_id: str, status: ApprovalStatus
    ) -> ApprovalRequest:
        current = self._requests[request_id]
        updated = replace(
            current,
            status=status,
            status_changed_at_utc=_now_utc(),
        )
        self._requests[request_id] = updated
        return updated
