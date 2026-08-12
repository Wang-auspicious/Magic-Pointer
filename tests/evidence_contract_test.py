"""Tests for the enforced perception evidence contract (review L6).

Covers: enum completeness, dataclass validation branches, helper factories,
the anti-container heuristic, merge_for_decision branches, and trust.
"""

import pytest

from app.evidence import (
    MIN_CONFIDENCE_FOR_TRUST,
    Evidence,
    EvidenceSource,
    EvidenceStatus,
    apply_container_heuristic,
    busy_evidence,
    empty_confirmed,
    failed_evidence,
    is_trustworthy,
    merge_for_decision,
    ok_evidence,
)


class TestEnums:
    def test_evidence_status_has_all_contract_values(self) -> None:
        assert {s.value for s in EvidenceStatus} == {
            "ok",
            "degraded",
            "empty_confirmed",
            "busy",
            "timeout",
            "unsupported",
            "denied",
            "error",
        }

    def test_evidence_source_has_all_contract_values(self) -> None:
        assert {s.value for s in EvidenceSource} == {
            "uia",
            "cdp",
            "com",
            "ocr",
            "vision",
            "cache",
            "file",
            "test",
        }

    def test_status_is_str_enum(self) -> None:
        assert EvidenceStatus("busy") is EvidenceStatus.BUSY
        assert EvidenceStatus.BUSY == "busy"
        assert EvidenceStatus.OK.value == "ok"

    def test_source_is_str_enum(self) -> None:
        assert EvidenceSource("uia") is EvidenceSource.UIA
        assert EvidenceSource.UIA == "uia"


class TestEvidenceValidation:
    def test_ok_requires_non_none_value(self) -> None:
        with pytest.raises(ValueError):
            Evidence(
                value=None,
                status=EvidenceStatus.OK,
                confidence=1.0,
                source=EvidenceSource.UIA,
            )

    def test_confidence_below_zero_rejected(self) -> None:
        with pytest.raises(ValueError):
            Evidence(
                value="x",
                status=EvidenceStatus.DEGRADED,
                confidence=-0.1,
                source=EvidenceSource.UIA,
            )

    def test_confidence_above_one_rejected(self) -> None:
        with pytest.raises(ValueError):
            Evidence(
                value="x",
                status=EvidenceStatus.DEGRADED,
                confidence=1.01,
                source=EvidenceSource.UIA,
            )

    def test_ok_requires_confidence_at_least_0_5(self) -> None:
        with pytest.raises(ValueError):
            Evidence(
                value="x",
                status=EvidenceStatus.OK,
                confidence=0.49,
                source=EvidenceSource.UIA,
            )

    def test_non_ok_statuses_allow_none_value_and_low_confidence(self) -> None:
        ev = Evidence(
            value=None,
            status=EvidenceStatus.BUSY,
            confidence=0.0,
            source=EvidenceSource.OCR,
        )
        assert ev.value is None
        timed = Evidence(
            value=None,
            status=EvidenceStatus.TIMEOUT,
            confidence=0.1,
            source=EvidenceSource.UIA,
        )
        assert timed.status is EvidenceStatus.TIMEOUT

    def test_boundary_values_accepted(self) -> None:
        Evidence(
            value="x",
            status=EvidenceStatus.OK,
            confidence=0.5,
            source=EvidenceSource.TEST,
        )
        Evidence(
            value="x",
            status=EvidenceStatus.DEGRADED,
            confidence=0.0,
            source=EvidenceSource.TEST,
        )
        Evidence(
            value="x",
            status=EvidenceStatus.DEGRADED,
            confidence=1.0,
            source=EvidenceSource.TEST,
        )


class TestHelpers:
    def test_ok_evidence_defaults_and_kwargs(self) -> None:
        ev = ok_evidence(
            "hello",
            EvidenceSource.UIA,
            latency_ms=12.5,
            captured_at_utc="2026-08-12T00:00:00Z",
            note="raw",
        )
        assert ev.value == "hello"
        assert ev.status is EvidenceStatus.OK
        assert ev.confidence == 1.0
        assert ev.source is EvidenceSource.UIA
        assert ev.latency_ms == 12.5
        assert ev.captured_at_utc == "2026-08-12T00:00:00Z"
        assert ev.note == "raw"
        assert ev.container_hint is False

    def test_ok_evidence_accepts_confidence(self) -> None:
        assert ok_evidence("x", EvidenceSource.OCR, confidence=0.8).confidence == 0.8

    def test_ok_evidence_rejects_none_value_and_low_confidence(self) -> None:
        with pytest.raises(ValueError):
            ok_evidence(None, EvidenceSource.UIA)
        with pytest.raises(ValueError):
            ok_evidence("x", EvidenceSource.UIA, confidence=0.49)

    def test_empty_confirmed_helper(self) -> None:
        ev = empty_confirmed(EvidenceSource.VISION)
        assert ev.value is None
        assert ev.status is EvidenceStatus.EMPTY_CONFIRMED
        assert ev.confidence == 1.0
        assert ev.source is EvidenceSource.VISION

    def test_busy_evidence_helper(self) -> None:
        ev = busy_evidence(EvidenceSource.OCR, latency_ms=250.0)
        assert ev.value is None
        assert ev.status is EvidenceStatus.BUSY
        assert ev.latency_ms == 250.0
        assert ev.confidence == 0.0

    def test_failed_evidence_helper(self) -> None:
        timed = failed_evidence(
            EvidenceSource.UIA,
            EvidenceStatus.TIMEOUT,
            note="probe exceeded budget",
        )
        assert timed.value is None
        assert timed.status is EvidenceStatus.TIMEOUT
        assert timed.note == "probe exceeded budget"
        err = failed_evidence(EvidenceSource.OCR, EvidenceStatus.ERROR, note="worker died")
        assert err.status is EvidenceStatus.ERROR
        denied = failed_evidence(EvidenceSource.CDP, EvidenceStatus.DENIED, note="no grant")
        assert denied.status is EvidenceStatus.DENIED
        assert denied.value is None


class TestContainerHeuristic:
    CONTAINERS = {"List", "Window", "Pane"}

    def test_container_name_value_is_downgraded(self) -> None:
        ev = ok_evidence("List", EvidenceSource.UIA, confidence=0.9)
        out = apply_container_heuristic(ev, self.CONTAINERS)
        assert out.container_hint is True
        assert out.status is EvidenceStatus.DEGRADED
        assert out.confidence == 0.2
        assert out.value == "List"
        assert out.source is EvidenceSource.UIA

    def test_original_evidence_is_not_mutated(self) -> None:
        ev = ok_evidence("Window", EvidenceSource.UIA, confidence=0.95, note="raw")
        apply_container_heuristic(ev, self.CONTAINERS)
        assert ev.status is EvidenceStatus.OK
        assert ev.confidence == 0.95
        assert ev.container_hint is False
        assert ev.note == "raw"

    def test_value_with_surrounding_whitespace_is_stripped(self) -> None:
        ev = ok_evidence("  Pane ", EvidenceSource.UIA)
        out = apply_container_heuristic(ev, self.CONTAINERS)
        assert out.container_hint is True
        assert out.status is EvidenceStatus.DEGRADED

    def test_non_container_value_returns_same_object(self) -> None:
        ev = ok_evidence("OK button", EvidenceSource.UIA)
        assert apply_container_heuristic(ev, self.CONTAINERS) is ev

    def test_empty_value_returns_same_object(self) -> None:
        ev = ok_evidence("", EvidenceSource.UIA)
        assert apply_container_heuristic(ev, self.CONTAINERS) is ev

    def test_confidence_never_rises(self) -> None:
        ev = Evidence(
            value="List",
            status=EvidenceStatus.DEGRADED,
            confidence=0.1,
            source=EvidenceSource.UIA,
        )
        assert apply_container_heuristic(ev, self.CONTAINERS).confidence == 0.1

    def test_already_degraded_keeps_status(self) -> None:
        ev = Evidence(
            value="List",
            status=EvidenceStatus.DEGRADED,
            confidence=0.4,
            source=EvidenceSource.UIA,
        )
        out = apply_container_heuristic(ev, self.CONTAINERS)
        assert out.status is EvidenceStatus.DEGRADED
        assert out.confidence == 0.2


class TestMergeForDecision:
    def test_empty_list_synthesizes_empty_confirmed(self) -> None:
        out = merge_for_decision([])
        assert out.status is EvidenceStatus.EMPTY_CONFIRMED
        assert out.value is None

    def test_single_busy(self) -> None:
        out = merge_for_decision([busy_evidence(EvidenceSource.OCR, 300.0)])
        assert out.status is EvidenceStatus.BUSY
        assert out.value is None
        assert out.source is EvidenceSource.OCR

    def test_busy_plus_ok_prefers_ok(self) -> None:
        out = merge_for_decision(
            [
                busy_evidence(EvidenceSource.OCR, 300.0),
                ok_evidence("target text", EvidenceSource.UIA, confidence=0.9),
            ]
        )
        assert out.status is EvidenceStatus.OK
        assert out.value == "target text"
        assert out.container_hint is False

    def test_two_oks_keep_highest_confidence(self) -> None:
        low = ok_evidence("low", EvidenceSource.OCR, confidence=0.6)
        high = ok_evidence("high", EvidenceSource.UIA, confidence=0.95)
        out = merge_for_decision([low, high])
        assert out.value == "high"
        assert out.confidence == 0.95
        assert out.source is EvidenceSource.UIA

    def test_severity_priority_error_over_timeout_over_busy(self) -> None:
        out = merge_for_decision(
            [
                busy_evidence(EvidenceSource.OCR, 100.0),
                failed_evidence(EvidenceSource.UIA, EvidenceStatus.TIMEOUT, note="t"),
                failed_evidence(EvidenceSource.CDP, EvidenceStatus.ERROR, note="e"),
            ]
        )
        assert out.status is EvidenceStatus.ERROR
        assert out.value is None

    def test_severity_priority_denied_over_timeout(self) -> None:
        out = merge_for_decision(
            [
                failed_evidence(EvidenceSource.UIA, EvidenceStatus.TIMEOUT, note="t"),
                failed_evidence(EvidenceSource.COM, EvidenceStatus.DENIED, note="d"),
            ]
        )
        assert out.status is EvidenceStatus.DENIED

    def test_severity_priority_timeout_over_busy_over_unsupported(self) -> None:
        out = merge_for_decision(
            [
                failed_evidence(EvidenceSource.VISION, EvidenceStatus.UNSUPPORTED, note="u"),
                busy_evidence(EvidenceSource.OCR, 50.0),
                failed_evidence(EvidenceSource.CACHE, EvidenceStatus.TIMEOUT, note="t"),
            ]
        )
        assert out.status is EvidenceStatus.TIMEOUT

    def test_only_container_hints_yield_degraded_with_value(self) -> None:
        a = Evidence(
            value="List",
            status=EvidenceStatus.OK,
            confidence=0.9,
            source=EvidenceSource.UIA,
            container_hint=True,
        )
        b = Evidence(
            value="Pane",
            status=EvidenceStatus.DEGRADED,
            confidence=0.2,
            source=EvidenceSource.UIA,
            container_hint=True,
        )
        out = merge_for_decision([a, b])
        assert out.status is EvidenceStatus.DEGRADED
        assert out.value in ("List", "Pane")
        assert out.container_hint is True

    def test_ok_with_container_hint_does_not_win(self) -> None:
        hint = Evidence(
            value="List",
            status=EvidenceStatus.OK,
            confidence=0.9,
            source=EvidenceSource.UIA,
            container_hint=True,
        )
        out = merge_for_decision([hint])
        assert out.status is EvidenceStatus.DEGRADED
        assert out.container_hint is True
        assert out.value == "List"

    def test_only_empty_confirmed(self) -> None:
        out = merge_for_decision(
            [empty_confirmed(EvidenceSource.UIA), empty_confirmed(EvidenceSource.VISION)]
        )
        assert out.status is EvidenceStatus.EMPTY_CONFIRMED
        assert out.value is None

    def test_empty_confirmed_with_busy_returns_busy(self) -> None:
        out = merge_for_decision(
            [
                empty_confirmed(EvidenceSource.UIA),
                busy_evidence(EvidenceSource.OCR, 10.0),
            ]
        )
        assert out.status is EvidenceStatus.BUSY

    def test_note_summarizes_source_statuses(self) -> None:
        out = merge_for_decision(
            [
                ok_evidence("x", EvidenceSource.UIA, confidence=0.9),
                busy_evidence(EvidenceSource.OCR, 100.0),
            ]
        )
        assert out.note == "uia:ok ocr:busy"


class TestTrust:
    def test_min_confidence_constant(self) -> None:
        assert MIN_CONFIDENCE_FOR_TRUST == 0.5

    def test_ok_high_confidence_not_hint_is_trustworthy(self) -> None:
        assert is_trustworthy(ok_evidence("x", EvidenceSource.UIA, confidence=0.9)) is True

    def test_ok_at_minimum_threshold_is_trustworthy(self) -> None:
        assert is_trustworthy(ok_evidence("x", EvidenceSource.UIA, confidence=0.5)) is True

    def test_non_ok_statuses_are_not_trustworthy(self) -> None:
        assert is_trustworthy(empty_confirmed(EvidenceSource.UIA)) is False
        assert is_trustworthy(busy_evidence(EvidenceSource.OCR, 1.0)) is False
        degraded = Evidence(
            value="x",
            status=EvidenceStatus.DEGRADED,
            confidence=0.9,
            source=EvidenceSource.UIA,
        )
        assert is_trustworthy(degraded) is False

    def test_container_hint_never_trustworthy(self) -> None:
        hint = Evidence(
            value="List",
            status=EvidenceStatus.OK,
            confidence=0.9,
            source=EvidenceSource.UIA,
            container_hint=True,
        )
        assert is_trustworthy(hint) is False
