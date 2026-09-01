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

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from app.agent_runtime.tool_registry import Effect

__all__ = ["PermissionDecisions", "GRANTABLE_EFFECTS"]

GRANTABLE_EFFECTS = frozenset({Effect.LOCAL_IRREVERSIBLE})
_UNSAFE_PREFIX_COMMAND = re.compile(r"[|&;<>`]|\$\(|[\r\n]")


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

    def allows_call(
        self,
        tool_name: str,
        arguments: Mapping[str, Any],
    ) -> bool:
        """Allow a whole tool or a bounded ``Bash(<prefix>)`` rule.

        Prefix rules apply only to Bash and only on a clean command token
        boundary. Shell chaining, substitution, redirection, and multiline
        input never inherit a prefix grant; the user is asked again instead.
        """
        name = str(tool_name or "").strip()
        if not name or name in self.denied:
            return False
        if name in self.allowed:
            return True
        if name != "Bash":
            return False
        command = str((arguments or {}).get("command") or "").strip()
        if not command or _UNSAFE_PREFIX_COMMAND.search(command):
            return False
        marker = f"{name}("
        for rule in self.allowed:
            value = str(rule or "").strip()
            if not value.startswith(marker) or not value.endswith(")"):
                continue
            prefix = value[len(marker):-1].strip()
            if not prefix or _UNSAFE_PREFIX_COMMAND.search(prefix):
                continue
            if command == prefix:
                return True
            if command.startswith(prefix):
                suffix = command[len(prefix):]
                if suffix and suffix[0].isspace():
                    return True
        return False

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
