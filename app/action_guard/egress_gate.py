
from __future__ import annotations

import enum
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime

from app.agent_runtime.types import ORIGIN_DATA, ORIGIN_INSTRUCTION


class EgressScope(enum.StrEnum):

    EXTERNAL_SEND = "external_send"
    AGENT_HANDOFF = "agent_handoff"
    MAP_ROUTE = "map_route"
    UPLOAD = "upload"
    WEB_FORM = "web_form"
    CUSTOM = "custom"


@dataclass(frozen=True, slots=True)
class EgressDecision:

    allowed: bool
    reason: str
    scope: EgressScope


@dataclass(frozen=True, slots=True)
class EgressEvent:

    t_utc: str
    scope: EgressScope
    tool_name: str
    target_ref: str | None
    origin: str
    allowed: bool
    reason: str


class EgressDeniedError(Exception):

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

    __slots__ = ("_lock", "_allowed", "_closed", "_events")

    def __init__(self, allowed_scopes: set[EgressScope] | None = None) -> None:
        self._lock = threading.Lock()
        self._allowed: set[EgressScope] = (
            set(allowed_scopes) if allowed_scopes is not None else set()
        )
        self._closed = False
        self._events: list[EgressEvent] = []

    def allow(self, scope: EgressScope) -> None:
        with self._lock:
            if not self._closed:
                self._allowed.add(scope)

    def disallow(self, scope: EgressScope) -> None:
        with self._lock:
            self._allowed.discard(scope)

    def is_allowed(self, scope: EgressScope) -> bool:
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
        with self._lock:
            return list(self._events)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._allowed.clear()

    def is_closed(self) -> bool:
        with self._lock:
            return self._closed


class EgressAudit:

    @staticmethod
    def summarize(events: Iterable[EgressEvent]) -> dict[str, object]:
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
