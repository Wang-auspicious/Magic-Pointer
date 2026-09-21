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
from dataclasses import dataclass, field
from typing import Any

from app.agent_runtime.tool_registry import Effect

__all__ = ["PermissionDecisions", "GRANTABLE_EFFECTS"]

GRANTABLE_EFFECTS = frozenset({Effect.LOCAL_IRREVERSIBLE})
_UNSAFE_PREFIX_COMMAND = re.compile(r"[|&;<>`]|\$\(|[\r\n]")


@dataclass(frozen=True)
class PermissionDecisions:
    """Thread rules plus one-call approvals claimed within this runtime invocation."""

    allowed: tuple[str, ...] = ()
    denied: tuple[str, ...] = ()
    once: tuple[str, ...] = ()
    once_arguments: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    _claimed_once: dict[str, tuple[str, dict[str, Any]]] = field(default_factory=dict, compare=False, repr=False)

    def lookup(self, tool_name: str, arguments: Mapping[str, Any] | None = None) -> str | None:
        """``"allow"`` / ``"deny"`` / ``None`` (undecided) for one tool."""
        name = str(tool_name or "").strip()
        if not name:
            return None
        if any(_matches_rule(name, arguments or {}, rule) for rule in self.denied):
            return "deny"
        if name in self.allowed:
            return "allow"
        return None

    def allows_call(
        self,
        tool_name: str,
        arguments: Mapping[str, Any],
        call_id: str | None = None,
    ) -> bool:
        """Allow a whole tool or a bounded ``Bash(<prefix>)`` rule.

        Prefix rules apply only to Bash and only on a clean command token
        boundary. Shell chaining, substitution, redirection, and multiline
        input never inherit a prefix grant; the user is asked again instead.
        """
        name = str(tool_name or "").strip()
        if not name or self.lookup(name, arguments) == 'deny':
            return False
        if name in self.allowed:
            return True
        command = str((arguments or {}).get("command") or "").strip()
        if name == 'Bash' and (not command or _UNSAFE_PREFIX_COMMAND.search(command)):
            return False
        if any(_matches_rule(name, arguments, rule) for rule in self.allowed):
            return True
        for rule in self.once:
            if not call_id or not _matches_rule(name, arguments, rule):
                continue
            if rule in self.once_arguments and dict(arguments) != dict(self.once_arguments[rule]):
                continue
            claim = self._claimed_once.setdefault(rule, (call_id, dict(arguments)))
            if claim == (call_id, dict(arguments)):
                return True
        return False

    @staticmethod
    def from_allowed(value) -> PermissionDecisions | None:
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


def _matches_rule(name: str, arguments: Mapping[str, Any], rule: str) -> bool:
    if name == rule:
        return True
    if name != 'Bash' or not rule.startswith('Bash(') or not rule.endswith(')'):
        return False
    prefix = rule[5:-1].strip()
    command = str(arguments.get('command') or '').strip()
    return bool(prefix and (command == prefix or command.startswith(prefix) and command[len(prefix):1 + len(prefix)].isspace()))
