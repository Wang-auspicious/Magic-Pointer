"""Egress gate: fail-closed checkpoint for every path that leaves this machine.

Harness gap review (docs/harness-gap-review-20260812.md) L7.4: all "send
data off this machine" routes (send message, upload, external agent handoff,
web-form submission) must pass through one egress gate that is auditable and
can be disabled. L5: irreversible actions require explicit confirmation that
the model cannot trigger itself — implemented here as the rule that data-
driven egress (content read from the screen driving an external send) needs
``explicit_approval=True`` even when the scope is allowed; only a genuine
instruction origin passes on scope alone.

The gate defaults to denying every scope (fail closed). Every decision is
recorded as a chronological :class:`EgressEvent` for the audit trail; the
trail survives :meth:`EgressGate.close`.

Pure Python, stdlib-only, thread-safe.
"""

from __future__ import annotations

import enum
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime

from app.agent_runtime.types import ORIGIN_DATA, ORIGIN_INSTRUCTION


class EgressScope(enum.StrEnum):
    """Class of off-machine data transfer (review L7.4 egress points)."""

    EXTERNAL_SEND = "external_send"
    AGENT_HANDOFF = "agent_handoff"
    MAP_ROUTE = "map_route"
    UPLOAD = "upload"
    WEB_FORM = "web_form"
    CUSTOM = "custom"


@dataclass(frozen=True, slots=True)
class EgressDecision:
    """Outcome of one egress check; never mutated after creation."""

    allowed: bool
    reason: str
    scope: EgressScope


@dataclass(frozen=True, slots=True)
class EgressEvent:
    """One audited egress check, in call order."""

    t_utc: str
    scope: EgressScope
    tool_name: str
    target_ref: str | None
    origin: str
    allowed: bool
    reason: str


class EgressDeniedError(Exception):
    """Raised by :meth:`EgressGate.assert_allowed` on a denied egress.

    Carries the full :class:`EgressDecision` so callers can log, surface or
    retry with approval.
    """

    def __init__(self, decision: EgressDecision) -> None:
        super().__init__(f"egress denied: {decision.reason}")
        self.decision = decision


def _now_utc() -> str:
    return (
        datetime.now(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


class EgressGate:
    """Thread-safe, fail-closed checkpoint for off-machine data transfer.

    - ``None``/empty allowed scopes = everything denied until ``allow()``.
    - Instruction-origin egress passes when the scope is allowed.
    - Any other origin (default ``ORIGIN_DATA``, including unknown tags)
      additionally requires ``explicit_approval=True`` — confirmation the
      model cannot produce on its own.
    - :meth:`close` empties the allowed scopes and disables the gate; the
      event trail is preserved and every post-close check is recorded as a
      denial (auditable close).
    """

    __slots__ = ("_lock", "_allowed", "_closed", "_events")

    def __init__(self, allowed_scopes: set[EgressScope] | None = None) -> None:
        self._lock = threading.Lock()
        self._allowed: set[EgressScope] = (
            set(allowed_scopes) if allowed_scopes is not None else set()
        )
        self._closed = False
        self._events: list[EgressEvent] = []

    def allow(self, scope: EgressScope) -> None:
        """Permit ``scope``; no-op after :meth:`close`."""
        with self._lock:
            if not self._closed:
                self._allowed.add(scope)

    def disallow(self, scope: EgressScope) -> None:
        """Revoke ``scope``."""
        with self._lock:
            self._allowed.discard(scope)

    def is_allowed(self, scope: EgressScope) -> bool:
        """True only while the gate is open and ``scope`` is permitted."""
        with self._lock:
            return not self._closed and scope in self._allowed

    def assert_allowed(
        self,
        scope: EgressScope,
        tool_name: str,
        target_ref: str | None = None,
        origin: str = ORIGIN_DATA,
        explicit_approval: bool = False,
    ) -> EgressDecision:
        """Check one egress; raise :class:`EgressDeniedError` when denied.

        Every check (allowed or denied) appends an :class:`EgressEvent` in
        call order. Denials when the gate is closed, the scope is not
        allowed, or a non-instruction origin lacks explicit approval.
        """
        with self._lock:
            if self._closed:
                decision = EgressDecision(
                    allowed=False,
                    reason="egress gate is closed",
                    scope=scope,
                )
            elif scope not in self._allowed:
                decision = EgressDecision(
                    allowed=False,
                    reason=f"scope {scope.value!r} not allowed",
                    scope=scope,
                )
            elif origin == ORIGIN_INSTRUCTION:
                decision = EgressDecision(
                    allowed=True,
                    reason=f"scope {scope.value!r} allowed (origin {ORIGIN_INSTRUCTION})",
                    scope=scope,
                )
            elif not explicit_approval:
                decision = EgressDecision(
                    allowed=False,
                    reason=f"origin {origin!r} requires explicit_approval=True",
                    scope=scope,
                )
            else:
                decision = EgressDecision(
                    allowed=True,
                    reason=f"scope {scope.value!r} allowed with explicit approval",
                    scope=scope,
                )
            self._events.append(
                EgressEvent(
                    t_utc=_now_utc(),
                    scope=scope,
                    tool_name=tool_name,
                    target_ref=target_ref,
                    origin=origin,
                    allowed=decision.allowed,
                    reason=decision.reason,
                )
            )
        if not decision.allowed:
            raise EgressDeniedError(decision)
        return decision

    def events(self) -> list[EgressEvent]:
        """All audit events in chronological (call) order; a snapshot copy."""
        with self._lock:
            return list(self._events)

    def close(self) -> None:
        """Clear allowed scopes and disable the gate (auditable close).

        The event trail is kept; subsequent ``assert_allowed`` calls are
        recorded as denials and ``allow()`` becomes a no-op.
        """
        with self._lock:
            self._closed = True
            self._allowed.clear()

    def is_closed(self) -> bool:
        with self._lock:
            return self._closed


class EgressAudit:
    """Accounting helpers over :class:`EgressEvent` lists."""

    @staticmethod
    def summarize(events: Iterable[EgressEvent]) -> dict[str, object]:
        """Count events per scope plus global allowed/denied figures.

        Result shape: ``{"scopes": {<scope value>: {"allowed", "denied",
        "total"}}, "total", "allowed", "denied", "allowed_ratio"}``.
        ``allowed_ratio`` is ``allowed / total``, or ``0.0`` with no events.
        """
        scopes: dict[str, dict[str, int]] = {}
        allowed = 0
        denied = 0
        for event in events:
            entry = scopes.setdefault(event.scope.value, {"allowed": 0, "denied": 0, "total": 0})
            entry["total"] += 1
            if event.allowed:
                allowed += 1
                entry["allowed"] += 1
            else:
                denied += 1
                entry["denied"] += 1
        total = allowed + denied
        return {
            "scopes": scopes,
            "total": total,
            "allowed": allowed,
            "denied": denied,
            "allowed_ratio": (allowed / total) if total else 0.0,
        }
