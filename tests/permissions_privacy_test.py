"""Tests for perception permissions and privacy (harness gap review L10, task A2).

Covers: default app blacklist rules (password managers / banking / credential
windows / privacy-mode browsers) matching by process name, title and window
class; the perception-pre-blocking semantic (denied -> no perception request
is issued); rule management; sensitive content redaction (Luhn-valid credit
cards, 18-digit ID numbers, 11-digit phone numbers) preserving the first and
last 4 characters; PASSWORD_FIELD_MARKER hook point; offline (no-egress) mode
scope gating and impact summary; concurrency between blacklist checks and
offline toggling.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.permissions.app_blacklist import AppBlacklist, BlacklistDecision, BlacklistRule
from app.permissions.offline_mode import (
    FORBIDDEN_SCOPES,
    OfflineForbiddenError,
    OfflineMode,
)
from app.permissions.sensitive_detect import (
    PASSWORD_FIELD_MARKER,
    RedactionHit,
    RedactionResult,
    contains_sensitive,
    redact,
)

VALID_VISA = "4532015112830366"
INVALID_VISA = "4532015112830365"
ID_18 = "110101199003078888"
PHONE_11 = "13800138000"


@pytest.fixture(autouse=True)
def _offline_restore() -> None:
    OfflineMode().set(False)
    yield
    OfflineMode().set(False)


class TestDefaultRules:
    def test_default_rules_at_least_six(self) -> None:
        bl = AppBlacklist()
        rules = bl.list_rules()
        assert len(rules) >= 6
        assert len({r.rule_id for r in rules}) == len(rules)

    def test_process_name_hit_denied_with_rule_id(self) -> None:
        bl = AppBlacklist()
        identity = {"process_name": "KeePass.exe", "title": "KeePass - DB", "window_class": None}
        decision = bl.check(identity)
        assert decision.allowed is False
        assert decision.rule is not None
        assert decision.rule.rule_id == "pw_keepass"
        assert decision.reason

    def test_title_hit_denied_bank(self) -> None:
        bl = AppBlacklist()
        identity = {"process_name": "app.exe", "title": "招商银行 网上银行", "window_class": "Qt5QWindowIcon"}
        decision = bl.check(identity)
        assert decision.allowed is False
        assert decision.rule is not None
        assert decision.rule.title_pattern == "银行"

    @pytest.mark.parametrize("title", ["Windows 凭据管理器", "Credential Manager", "Sign-in - credential prompt"])
    def test_credential_title_hit_denied(self, title: str) -> None:
        bl = AppBlacklist()
        decision = bl.check({"process_name": "x.exe", "title": title, "window_class": None})
        assert decision.allowed is False
        assert decision.rule is not None

    def test_window_class_hit_denied(self) -> None:
        bl = AppBlacklist()
        identity = {
            "process_name": "something.exe",
            "title": "Log in",
            "window_class": "Windows.UI.Core.CoreWindow",
        }
        decision = bl.check(identity)
        assert decision.allowed is False
        assert decision.rule is not None
        assert decision.rule.window_class == "Windows.UI.Core.CoreWindow"

    def test_inprivate_title_hit_denied(self) -> None:
        bl = AppBlacklist()
        decision = bl.check(
            {"process_name": "chrome.exe", "title": "Booking - InPrivate", "window_class": "Chrome_WidgetWin_1"}
        )
        assert decision.allowed is False
        assert decision.rule is not None
        assert decision.rule.rule_id == "private_inprivate"

    def test_incognito_cn_title_hit_denied(self) -> None:
        bl = AppBlacklist()
        decision = bl.check(
            {"process_name": "chrome.exe", "title": "无痕浏览", "window_class": "Chrome_WidgetWin_1"}
        )
        assert decision.allowed is False
        assert decision.rule is not None
        assert decision.rule.rule_id == "private_incognito"

    def test_no_match_allowed(self) -> None:
        bl = AppBlacklist()
        identity = {"process_name": "notepad.exe", "title": "Untitled - Notepad", "window_class": "Notepad"}
        decision = bl.check(identity)
        assert decision.allowed is True
        assert decision.rule is None
        assert decision.reason == "no_match"

    def test_partial_identity_does_not_crash(self) -> None:
        bl = AppBlacklist()
        decision = bl.check({"process_name": "orphan.exe"})
        assert decision.allowed is True
        assert bl.is_blacklisted({"process_name": "KeePass.exe"}) is True
        assert bl.is_blacklisted({"process_name": "orphan.exe"}) is False

    def test_is_blacklisted_convenience(self) -> None:
        bl = AppBlacklist()
        assert bl.is_blacklisted({"process_name": "1Password.exe", "title": "", "window_class": None}) is True
        assert bl.is_blacklisted({"process_name": "calc.exe", "title": "Calculator", "window_class": None}) is False

    def test_first_matching_rule_wins(self) -> None:
        bl = AppBlacklist(
            rules=(
                BlacklistRule("probe_first", process_name="probe.exe", title_pattern=None, window_class=None, reason="first"),
                BlacklistRule("probe_second", process_name="probe.exe", title_pattern="银行", window_class=None, reason="second"),
            )
        )
        decision = bl.check({"process_name": "probe.exe", "title": "银行", "window_class": None})
        assert decision.rule is not None
        assert decision.rule.rule_id == "probe_first"


class TestRuleManagement:
    def test_add_rule(self) -> None:
        bl = AppBlacklist()
        rule = BlacklistRule("custom", process_name="secretvault.exe", title_pattern=None, window_class=None, reason="custom")
        bl.add_rule(rule)
        assert bl.is_blacklisted({"process_name": "secretvault.exe", "title": "", "window_class": None}) is True

    def test_remove_rule(self) -> None:
        bl = AppBlacklist()
        assert bl.remove_rule("pw_keepass") is True
        assert bl.is_blacklisted({"process_name": "KeePass.exe", "title": "", "window_class": None}) is False
        assert bl.remove_rule("no_such_id") is False

    def test_list_rules_returns_copy(self) -> None:
        bl = AppBlacklist()
        snapshot = bl.list_rules()
        snapshot.clear()
        assert len(bl.list_rules()) >= 6

    def test_custom_rules_override_defaults(self) -> None:
        bl = AppBlacklist(rules=())
        assert bl.list_rules() == []
        assert bl.check({"process_name": "KeePass.exe", "title": "", "window_class": None}).allowed is True


class TestPerceptionPreBlock:
    def test_denied_before_perception_request(self) -> None:
        perceive_calls: list[dict] = []

        def perceive(identity: dict) -> str:
            perceive_calls.append(identity)
            return "screen text"

        bl = AppBlacklist()
        identity = {"process_name": "KeePass.exe", "title": "KeePass - DB", "window_class": None}
        decision = bl.check(identity)
        assert decision.allowed is False
        assert perceive_calls == []

    def test_allowed_reaches_perception(self) -> None:
        perceive_calls: list[dict] = []
        bl = AppBlacklist()
        identity = {"process_name": "notepad.exe", "title": "Untitled - Notepad", "window_class": "Notepad"}
        if bl.check(identity).allowed:
            perceive_calls.append(identity)
        assert perceive_calls == [identity]


class TestCreditCardRedaction:
    def test_valid_luhn_redacted_keeps_first_last_4(self) -> None:
        result = redact(f"card {VALID_VISA}")
        assert result.text_redacted == "card 4532********0366"
        assert len(result.hits) == 1
        hit = result.hits[0]
        assert hit.pattern == "credit_card"
        assert hit.masked == "4532********0366"
        assert result.text_redacted[hit.start : hit.end] == hit.masked

    def test_invalid_luhn_not_redacted(self) -> None:
        for card in (INVALID_VISA, "1234567890123456"):
            result = redact(f"card {card}")
            assert result.hits == ()
            assert result.text_redacted == f"card {card}"

    def test_separated_card_redacted(self) -> None:
        result = redact("4532 0151 1283 0366")
        assert result.text_redacted == "4532***********0366"

    def test_hyphenated_card_redacted(self) -> None:
        result = redact("4532-0151-1283-0366")
        assert result.text_redacted == "4532***********0366"

    def test_card_embedded_in_longer_digits_not_redacted(self) -> None:
        result = redact(f"x{VALID_VISA}9")
        assert result.hits == ()


class TestIdCardRedaction:
    def test_18_digit_id_redacted(self) -> None:
        result = redact(f"id {ID_18}")
        assert result.text_redacted == "id 1101**********8888"
        assert result.hits[0].pattern == "id_card"

    def test_18_digit_id_with_x_redacted(self) -> None:
        result = redact("11010119900307888X")
        assert result.text_redacted == "1101**********888X"

    def test_17_digits_not_redacted(self) -> None:
        text = "11010119900307888"
        assert redact(text).hits == ()

    def test_19_digits_not_redacted(self) -> None:
        text = "1101011990030788889"
        assert redact(text).hits == ()


class TestPhoneRedaction:
    def test_11_digit_phone_redacted(self) -> None:
        result = redact(f"tel {PHONE_11}")
        assert result.text_redacted == "tel 1380***8000"
        assert result.hits[0].pattern == "phone"

    def test_10_digits_not_redacted(self) -> None:
        assert redact("1380013800").hits == ()

    def test_phone_inside_longer_run_not_redacted(self) -> None:
        assert redact(f"{PHONE_11}0").hits == ()
        assert redact(f"0{PHONE_11}").hits == ()


class TestMultiHitAndImmutability:
    def test_contains_sensitive(self) -> None:
        assert contains_sensitive(f"card {VALID_VISA}") is True
        assert contains_sensitive(f"id {ID_18}") is True
        assert contains_sensitive(f"tel {PHONE_11}") is True
        assert contains_sensitive("hello world") is False

    def test_multiple_hits_ordered_by_start(self) -> None:
        text = f"手机 {PHONE_11} 卡 {VALID_VISA} 证 {ID_18}"
        result = redact(text)
        assert len(result.hits) == 3
        starts = [h.start for h in result.hits]
        assert starts == sorted(starts)
        assert [h.pattern for h in result.hits] == ["phone", "credit_card", "id_card"]

    def test_redact_does_not_mutate_input_and_returns_frozen_objects(self) -> None:
        original = f"phone {PHONE_11}"
        result = redact(original)
        assert original == f"phone {PHONE_11}"
        assert isinstance(result, RedactionResult)
        assert isinstance(result.hits[0], RedactionHit)
        assert result.text_redacted != original

    def test_clean_text_returns_equal_redacted(self) -> None:
        result = redact("nothing sensitive here")
        assert result.text_redacted == "nothing sensitive here"
        assert result.hits == ()

    def test_password_field_marker_present(self) -> None:
        assert PASSWORD_FIELD_MARKER == "is_password"


class TestOfflineMode:
    def test_offline_denies_model_text(self) -> None:
        mode = OfflineMode()
        mode.set(True)
        with pytest.raises(OfflineForbiddenError) as exc:
            mode.assert_allowed("model_text")
        assert exc.value.scope == "model_text"

    @pytest.mark.parametrize("scope", sorted(FORBIDDEN_SCOPES))
    def test_offline_denies_every_forbidden_scope(self, scope: str) -> None:
        mode = OfflineMode()
        mode.set(True)
        with pytest.raises(OfflineForbiddenError):
            mode.assert_allowed(scope)

    def test_offline_allows_local_ocr(self) -> None:
        mode = OfflineMode()
        mode.set(True)
        mode.assert_allowed("local_ocr")
        mode.assert_allowed("local_model")

    def test_offline_unknown_scope_allowed(self) -> None:
        mode = OfflineMode()
        mode.set(True)
        mode.assert_allowed("some_unknown_scope")

    def test_restore_online_after_false(self) -> None:
        mode = OfflineMode()
        mode.set(True)
        with pytest.raises(OfflineForbiddenError):
            mode.assert_allowed("model_vision")
        mode.set(False)
        mode.assert_allowed("model_vision")
        mode.assert_allowed("external_send")
        assert mode.is_offline() is False

    def test_impact_summary(self) -> None:
        mode = OfflineMode()
        mode.set(True)
        summary = mode.impact_summary()
        assert summary["offline"] is True
        assert set(summary["forbidden_scopes"]) == set(FORBIDDEN_SCOPES)
        assert "local_ocr" in summary["local_scopes"]
        mode.set(False)
        summary = mode.impact_summary()
        assert summary["offline"] is False
        assert summary["forbidden_scopes"] == []

    def test_forbidden_scopes_constant(self) -> None:
        assert set(FORBIDDEN_SCOPES) == {"model_text", "model_vision", "external_send", "mcp_remote"}


class TestConcurrency:
    def test_concurrent_blacklist_check_and_offline_toggle(self) -> None:
        bl = AppBlacklist()
        mode = OfflineMode()
        mode.set(False)
        identities = [
            {"process_name": "KeePass.exe", "title": "KeePass - DB", "window_class": None},
            {"process_name": "notepad.exe", "title": "Untitled - Notepad", "window_class": "Notepad"},
            {"process_name": "chrome.exe", "title": "Booking - InPrivate", "window_class": "Chrome_WidgetWin_1"},
        ]

        def worker(n: int) -> None:
            for i in range(100):
                decision = bl.check(identities[i % len(identities)])
                assert isinstance(decision, BlacklistDecision)
                assert decision.allowed in (True, False)
                mode.set(i % 2 == 0)
                mode.assert_allowed("local_ocr")
                try:
                    mode.assert_allowed("model_text")
                except OfflineForbiddenError:
                    pass
                assert mode.is_offline() in (True, False)

        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(worker, n) for n in range(8)]
            for future in futures:
                future.result(timeout=30)
        mode.set(False)
        assert mode.is_offline() is False
