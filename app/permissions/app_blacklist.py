
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class BlacklistRule:

    rule_id: str
    process_name: str | None = None
    title_pattern: str | None = None
    window_class: str | None = None
    reason: str = ""


@dataclass(frozen=True, slots=True)
class BlacklistDecision:

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

    def __init__(self, rules: Sequence[BlacklistRule] = DEFAULT_RULES) -> None:
        self._rules: list[BlacklistRule] = list(rules)

    def add_rule(self, rule: BlacklistRule) -> None:
        self._rules.append(rule)

    def remove_rule(self, rule_id: str) -> bool:
        for i, rule in enumerate(self._rules):
            if rule.rule_id == rule_id:
                del self._rules[i]
                return True
        return False

    def list_rules(self) -> list[BlacklistRule]:
        return list(self._rules)

    def check(self, window_identity: dict[str, Any]) -> BlacklistDecision:
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
        return not self.check(window_identity).allowed
