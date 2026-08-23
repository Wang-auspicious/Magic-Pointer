"""Thread-scoped permission grants (CC toolPermissionDecision pattern).

CC records a user's allow/deny answer per tool rule and applies it to later
calls without re-asking. MP's equivalent is thread-scoped: the conversation
record carries the granted tool names, every request re-injects them, and
the loop consults the memo before refusing an ASK-class call.

Scope guard: a grant only upgrades an ASK for :attr:`Effect.LOCAL_IRREVERSIBLE`
(machine-verifiable local writes). External sends, destructive and purchase
effects keep asking in every mode — a blanket "always allow" chip must never
be able to mint invariant ④⑤⑥ authority. An explicit deny always wins.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.agent_runtime.tool_registry import Effect

__all__ = ["PermissionDecisions", "GRANTABLE_EFFECTS"]

GRANTABLE_EFFECTS = frozenset({Effect.LOCAL_IRREVERSIBLE})


@dataclass(frozen=True)
class PermissionDecisions:
    """Immutable per-thread allow/deny memo keyed by tool name."""

    allowed: tuple[str, ...] = ()
    denied: tuple[str, ...] = ()

    def lookup(self, tool_name: str) -> str | None:
        """``"allow"`` / ``"deny"`` / ``None`` (undecided) for one tool."""
        name = str(tool_name or "").strip()
        if not name:
            return None
        if name in self.denied:
            return "deny"
        if name in self.allowed:
            return "allow"
        return None

    @staticmethod
    def from_allowed(value) -> "PermissionDecisions | None":
        """Build from a bridge payload list of granted tool names.

        ``None``/empty means no memo (every ASK keeps asking).
        """
        if not isinstance(value, (list, tuple)):
            return None
        allowed = tuple(
            str(item).strip() for item in value if str(item or "").strip()
        )
        if not allowed:
            return None
        return PermissionDecisions(allowed=allowed)
