"""Application-level perception blacklist (harness gap review L10).

Semantics: a denied window is blocked **before any perception happens** —
no capture, no UIA/DOM/OCR, no context packet. The caller is expected to
consult :meth:`AppBlacklist.check` as the first gate of the perception
pipeline and to skip all perception work when the decision denies.

Window identity is a plain dict (``process_name``/``title``/``window_class``)
so this module has no dependency on ``app.anchor`` and no import cycle risk.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class BlacklistRule:
    """One blacklist rule.

    At least one of ``process_name`` / ``title_pattern`` / ``window_class``
    must be set; a rule with all three unset can never match.
    """

    rule_id: str
    process_name: str | None = None
    title_pattern: str | None = None
    window_class: str | None = None
    reason: str = ""


@dataclass(frozen=True, slots=True)
class BlacklistDecision:
    """Outcome of one window-identity check.

    ``allowed=True`` with ``reason='no_match'`` means the window may be
    perceived; ``allowed=False`` carries the matching rule.
    """

    allowed: bool
    rule: BlacklistRule | None = None
    reason: str = "no_match"


DEFAULT_RULES: tuple[BlacklistRule, ...] = (
    BlacklistRule(
        rule_id="pw_keepass",
        process_name="KeePass.exe",
        reason="password manager",
    ),
    BlacklistRule(
        rule_id="pw_lastpass",
        process_name="LastPass.exe",
        reason="password manager",
    ),
    BlacklistRule(
        rule_id="pw_1password",
        process_name="1Password.exe",
        reason="password manager",
    ),
    BlacklistRule(
        rule_id="pw_bitwarden",
        process_name="Bitwarden.exe",
        reason="password manager",
    ),
    BlacklistRule(
        rule_id="bank_title",
        title_pattern="银行",
        reason="banking client window",
    ),
    BlacklistRule(
        rule_id="credential_title",
        title_pattern="凭据",
        reason="credential window",
    ),
    BlacklistRule(
        rule_id="credential_title_en",
        title_pattern="credential",
        reason="credential window",
    ),
    BlacklistRule(
        rule_id="private_inprivate",
        title_pattern="InPrivate",
        reason="privacy-mode browser window",
    ),
    BlacklistRule(
        rule_id="private_incognito",
        title_pattern="无痕",
        reason="privacy-mode browser window",
    ),
    BlacklistRule(
        rule_id="secure_window_class",
        window_class="Windows.UI.Core.CoreWindow",
        reason="secure/system credential window class",
    ),
)


def _field_matches(haystack: str | None, needle: str | None) -> bool:
    if needle is None or not haystack:
        return False
    return needle.lower() in haystack.lower()


class AppBlacklist:
    """Rule set consulted before any perception request is issued."""

    def __init__(self, rules: Sequence[BlacklistRule] = DEFAULT_RULES) -> None:
        self._rules: list[BlacklistRule] = list(rules)

    def add_rule(self, rule: BlacklistRule) -> None:
        """Append a rule; it is consulted after existing rules."""
        self._rules.append(rule)

    def remove_rule(self, rule_id: str) -> bool:
        """Remove the first rule with ``rule_id``; True when one was removed."""
        for i, rule in enumerate(self._rules):
            if rule.rule_id == rule_id:
                del self._rules[i]
                return True
        return False

    def list_rules(self) -> list[BlacklistRule]:
        """Snapshot of the current rules (copy; mutating it is safe)."""
        return list(self._rules)

    def check(self, window_identity: dict[str, Any]) -> BlacklistDecision:
        """Check a window identity against the rules.

        First matching rule wins: process name is an exact (case-insensitive)
        comparison; title and window class are case-insensitive substring
        matches. No hit -> ``allowed=True`` with ``reason='no_match'``.
        """
        process_name = window_identity.get("process_name") or ""
        title = window_identity.get("title") or ""
        window_class = window_identity.get("window_class")
        for rule in self._rules:
            if rule.process_name is not None and rule.process_name.lower() != process_name.lower():
                continue
            if rule.title_pattern is not None and not _field_matches(title, rule.title_pattern):
                continue
            if rule.window_class is not None and not _field_matches(window_class, rule.window_class):
                continue
            if rule.process_name is None and rule.title_pattern is None and rule.window_class is None:
                continue
            return BlacklistDecision(
                allowed=False,
                rule=rule,
                reason=f"blacklisted by rule '{rule.rule_id}': {rule.reason}",
            )
        return BlacklistDecision(allowed=True, reason="no_match")

    def is_blacklisted(self, window_identity: dict[str, Any]) -> bool:
        """Convenience wrapper returning just the boolean decision."""
        return not self.check(window_identity).allowed
