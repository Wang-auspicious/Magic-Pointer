"""Human-gated approval ledger (harness gap review L5 / L7.3, task B3).

Review L5: irreversible actions (send, commit, delete, pay, external
egress) require explicit confirmation, and that confirmation must not be
triggerable by the model. Review L7.3: confirmation must come from a real
human input event, and every produced action must answer "who asked for
this action". This module is the approval side of that contract:

- :meth:`ActionApproval.requires_approval` gates on :class:`Effect` class
  only (fail closed): LOCAL_IRREVERSIBLE / EXTERNAL_SEND / DESTRUCTIVE /
  PURCHASE need approval; READ / REVERSIBLE_WRITE pass (reversible writes
  still record undo, see ``app/action_guard/undo_log.py``).
- ``request()`` only registers a PENDING request — recording is not
  approval; ``approve()`` / ``reject()`` are explicit transitions.
- ``approve()`` refuses the ``NON_HUMAN_APPROVERS`` blacklist
  ('model' / 'tool' / 'agent') because confirmation cannot be triggered by
  the model; callers pass the real human identity and this module enforces
  the blacklist as the hard floor.
- ``invalidate()`` expires a request when the target identity or content
  hash changed (a stale approval must never execute); an EXPIRED request
  must be requested anew.
- ``approve_reversible()`` is the record-and-approve convenience for
  effects that do not require approval (caller's semantic choice).

Every request ever registered stays visible via ``records()`` /
``all_requests()`` for the action-origin audit (L7.2).

Pure Python, stdlib-only, thread-safe (a single lock covers all state).
"""

from __future__ import annotations

import enum
import threading
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime

from app.agent_runtime.tool_registry import Effect
from app.agent_runtime.types import ORIGIN_DATA, ORIGIN_INSTRUCTION

NON_HUMAN_APPROVERS = ("model", "tool", "agent")
"""Approver identities that can never approve an action.

Review L5: confirmation must not be triggerable by the model itself; the
approver is whoever owns the real human input entry (caller-supplied),
and this blacklist is the hard floor.
"""

_APPROVAL_REQUIRED = frozenset(
    {
        Effect.LOCAL_IRREVERSIBLE,
        Effect.EXTERNAL_SEND,
        Effect.DESTRUCTIVE,
        Effect.PURCHASE,
    }
)


class ApprovalStatus(enum.StrEnum):
    """Lifecycle of one approval request."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    """Immutable record of one approval decision; transitions replace it."""

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
    """An approval transition was refused.

    Carries the ``request_id`` it concerned and a human-readable
    ``reason`` so callers can surface or log the refusal.
    """

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
    """Thread-safe ledger of human approval for irreversible actions.

    Transition rules (documented contract):
      * ``request()`` always registers PENDING (recording is not approval).
      * ``approve()``: PENDING -> APPROVED; APPROVED is idempotent;
        REJECTED / EXPIRED raise :class:`ApprovalError`. The approver
        must not be in ``NON_HUMAN_APPROVERS``.
      * ``reject()``: PENDING -> REJECTED; APPROVED -> REJECTED (a human
        may revoke before execution); REJECTED is idempotent; EXPIRED
        raises :class:`ApprovalError`.
      * ``invalidate()``: PENDING / APPROVED -> EXPIRED (target identity
        or content hash changed); REJECTED / EXPIRED stay unchanged.
        EXPIRED can never be approved; re-``request()`` instead.
    """

    __slots__ = ("_lock", "_requests", "_reasons")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: dict[str, ApprovalRequest] = {}
        self._reasons: dict[str, str] = {}

    @staticmethod
    def requires_approval(effect: Effect) -> bool:
        """True only for irreversible effect classes; READ and
        REVERSIBLE_WRITE are exempt (undo still records them)."""
        return effect in _APPROVAL_REQUIRED

    def request(
        self,
        tool_name: str,
        target_identity: str,
        content_hash: str | None,
        effect: Effect,
        origin: str = ORIGIN_DATA,
    ) -> ApprovalRequest:
        """Register one request; always returned PENDING."""
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
        """Approve a PENDING request; only a real human entry may do so."""
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
        """Record-and-approve convenience for requests whose effect does
        not require approval (e.g. REVERSIBLE_WRITE; caller's semantic
        choice). Refuses effects that do require approval.
        """
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
        """Reject a PENDING request, or revoke an APPROVED one."""
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
        """Expire a request whose target identity or content hash changed.

        PENDING and APPROVED become EXPIRED (a stale approval must never
        execute); REJECTED / EXPIRED are terminal and stay unchanged.
        """
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
        """Current status; unknown id raises :class:`ApprovalError`."""
        with self._lock:
            current = self._requests.get(request_id)
        if current is None:
            raise ApprovalError(request_id, "unknown request")
        return current.status

    @staticmethod
    def is_approved(request: ApprovalRequest) -> bool:
        return request.status is ApprovalStatus.APPROVED

    def pending(self) -> list[ApprovalRequest]:
        """All PENDING requests in registration order (snapshot)."""
        with self._lock:
            return [
                r
                for r in self._requests.values()
                if r.status is ApprovalStatus.PENDING
            ]

    def all_requests(self) -> list[ApprovalRequest]:
        """Every request ever registered, registration order (snapshot)."""
        with self._lock:
            return list(self._requests.values())

    def records(self) -> list[ApprovalRequest]:
        """Audit view: identical to :meth:`all_requests`."""
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
