"""Tests for the egress gate (harness gap review L7.4 / L5, task D2).

Covers: default-deny construction, scope allow/disallow, instruction vs data
origin semantics (data-driven egress requires explicit approval even when
the scope is allowed — L7 channel separation + L5 irreversible-action
confirmation), the EgressDeniedError carrying its decision, the chronological
event audit trail, close() semantics, EgressAudit.summarize accounting, and
thread-safety under concurrent calls.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.action_guard.egress_gate import (
    EgressAudit,
    EgressDecision,
    EgressDeniedError,
    EgressGate,
    EgressScope,
)
from app.agent_runtime.types import ORIGIN_DATA, ORIGIN_INSTRUCTION

ALL_SCOPES = tuple(EgressScope)


def gate(*allowed: EgressScope) -> EgressGate:
    return EgressGate(allowed_scopes=set(allowed))


def denied_decision(exc: pytest.ExceptionInfo[EgressDeniedError]) -> EgressDecision:
    return exc.value.decision


class TestDefaultDeny:
    @pytest.mark.parametrize("scope", ALL_SCOPES)
    def test_every_scope_denied_by_default(self, scope: EgressScope) -> None:
        g = EgressGate()
        with pytest.raises(EgressDeniedError) as exc:
            g.assert_allowed(scope, tool_name="send_msg")
        decision = denied_decision(exc)
        assert decision.allowed is False
        assert decision.scope is scope
        assert decision.reason

    def test_denial_records_event(self) -> None:
        g = EgressGate()
        with pytest.raises(EgressDeniedError):
            g.assert_allowed(
                EgressScope.EXTERNAL_SEND,
                tool_name="send_msg",
                target_ref="contact:alice",
                origin=ORIGIN_INSTRUCTION,
            )
        events = g.events()
        assert len(events) == 1
        event = events[0]
        assert event.allowed is False
        assert event.scope is EgressScope.EXTERNAL_SEND
        assert event.tool_name == "send_msg"
        assert event.target_ref == "contact:alice"
        assert event.origin == ORIGIN_INSTRUCTION

    def test_denial_event_t_utc_is_iso_z(self) -> None:
        g = EgressGate()
        with pytest.raises(EgressDeniedError):
            g.assert_allowed(EgressScope.UPLOAD, tool_name="upload")
        t_utc = g.events()[0].t_utc
        assert t_utc.endswith("Z")
        assert "T" in t_utc


class TestAllowInstructionOrigin:
    def test_instruction_origin_passes_after_allow(self) -> None:
        g = gate(EgressScope.EXTERNAL_SEND)
        decision = g.assert_allowed(
            EgressScope.EXTERNAL_SEND,
            tool_name="send_msg",
            target_ref="contact:alice",
            origin=ORIGIN_INSTRUCTION,
        )
        assert decision.allowed is True
        assert decision.scope is EgressScope.EXTERNAL_SEND
        assert decision.reason

    def test_allowed_instruction_records_event(self) -> None:
        g = gate(EgressScope.AGENT_HANDOFF)
        g.assert_allowed(
            EgressScope.AGENT_HANDOFF, tool_name="handoff", origin=ORIGIN_INSTRUCTION
        )
        event = g.events()[0]
        assert event.allowed is True
        assert event.origin == ORIGIN_INSTRUCTION
        assert event.tool_name == "handoff"

    def test_constructor_set_and_allow_are_equivalent(self) -> None:
        g1 = gate(EgressScope.UPLOAD)
        g2 = EgressGate()
        g2.allow(EgressScope.UPLOAD)
        assert g1.assert_allowed(EgressScope.UPLOAD, "up", origin=ORIGIN_INSTRUCTION).allowed
        assert g2.assert_allowed(EgressScope.UPLOAD, "up", origin=ORIGIN_INSTRUCTION).allowed


class TestDataOriginApproval:
    def test_data_origin_without_approval_denied_even_when_allowed(self) -> None:
        g = gate(EgressScope.WEB_FORM)
        with pytest.raises(EgressDeniedError) as exc:
            g.assert_allowed(EgressScope.WEB_FORM, tool_name="fill_form", origin=ORIGIN_DATA)
        decision = denied_decision(exc)
        assert decision.allowed is False
        assert "approval" in decision.reason
        assert g.events()[0].allowed is False

    def test_data_origin_with_approval_passes(self) -> None:
        g = gate(EgressScope.WEB_FORM)
        decision = g.assert_allowed(
            EgressScope.WEB_FORM,
            tool_name="fill_form",
            origin=ORIGIN_DATA,
            explicit_approval=True,
        )
        assert decision.allowed is True
        assert g.events()[0].allowed is True

    def test_approval_does_not_bypass_disallowed_scope(self) -> None:
        g = EgressGate()
        with pytest.raises(EgressDeniedError) as exc:
            g.assert_allowed(
                EgressScope.EXTERNAL_SEND,
                tool_name="send_msg",
                origin=ORIGIN_DATA,
                explicit_approval=True,
            )
        assert denied_decision(exc).allowed is False

    def test_unknown_origin_requires_approval(self) -> None:
        g = gate(EgressScope.CUSTOM)
        with pytest.raises(EgressDeniedError) as exc:
            g.assert_allowed(
                EgressScope.CUSTOM, tool_name="plugin_emit", origin="screen_ocr"
            )
        assert denied_decision(exc).allowed is False
        decision = g.assert_allowed(
            EgressScope.CUSTOM,
            tool_name="plugin_emit",
            origin="screen_ocr",
            explicit_approval=True,
        )
        assert decision.allowed is True


class TestAllowDisallow:
    def test_is_allowed_reflects_allow_and_disallow(self) -> None:
        g = EgressGate()
        assert not g.is_allowed(EgressScope.MAP_ROUTE)
        g.allow(EgressScope.MAP_ROUTE)
        assert g.is_allowed(EgressScope.MAP_ROUTE)
        g.disallow(EgressScope.MAP_ROUTE)
        assert not g.is_allowed(EgressScope.MAP_ROUTE)

    def test_disallow_turns_denial_back_on(self) -> None:
        g = gate(EgressScope.EXTERNAL_SEND)
        g.disallow(EgressScope.EXTERNAL_SEND)
        with pytest.raises(EgressDeniedError):
            g.assert_allowed(
                EgressScope.EXTERNAL_SEND, tool_name="send_msg", origin=ORIGIN_INSTRUCTION
            )

    def test_allow_other_scopes_does_not_leak(self) -> None:
        g = gate(EgressScope.UPLOAD)
        assert not g.is_allowed(EgressScope.WEB_FORM)
        with pytest.raises(EgressDeniedError):
            g.assert_allowed(EgressScope.WEB_FORM, tool_name="fill_form", origin=ORIGIN_INSTRUCTION)


class TestClose:
    def test_close_denies_everything(self) -> None:
        g = gate(EgressScope.EXTERNAL_SEND, EgressScope.UPLOAD)
        g.close()
        assert g.is_closed()
        for scope in ALL_SCOPES:
            with pytest.raises(EgressDeniedError) as exc:
                g.assert_allowed(scope, tool_name="t", origin=ORIGIN_INSTRUCTION)
            assert "closed" in denied_decision(exc).reason

    def test_close_makes_allow_noop(self) -> None:
        g = EgressGate()
        g.close()
        g.allow(EgressScope.EXTERNAL_SEND)
        assert not g.is_allowed(EgressScope.EXTERNAL_SEND)
        with pytest.raises(EgressDeniedError):
            g.assert_allowed(EgressScope.EXTERNAL_SEND, tool_name="t", origin=ORIGIN_INSTRUCTION)

    def test_close_preserves_audit_trail_and_records_denial(self) -> None:
        g = gate(EgressScope.UPLOAD)
        g.assert_allowed(EgressScope.UPLOAD, "up", origin=ORIGIN_INSTRUCTION)
        g.close()
        with pytest.raises(EgressDeniedError):
            g.assert_allowed(EgressScope.UPLOAD, "up", origin=ORIGIN_INSTRUCTION)
        events = g.events()
        assert len(events) == 2
        assert events[0].allowed is True
        assert events[1].allowed is False
        assert "closed" in events[1].reason


class TestAuditTrail:
    def test_events_chronological(self) -> None:
        g = gate(EgressScope.EXTERNAL_SEND)
        g.assert_allowed(EgressScope.EXTERNAL_SEND, "a", origin=ORIGIN_INSTRUCTION)
        with pytest.raises(EgressDeniedError):
            g.assert_allowed(EgressScope.WEB_FORM, "b", origin=ORIGIN_INSTRUCTION)
        g.assert_allowed(EgressScope.EXTERNAL_SEND, "c", origin=ORIGIN_INSTRUCTION)
        stamps = [e.t_utc for e in g.events()]
        assert stamps == sorted(stamps)

    def test_events_returns_snapshot_copy(self) -> None:
        g = gate(EgressScope.UPLOAD)
        g.assert_allowed(EgressScope.UPLOAD, "up", origin=ORIGIN_INSTRUCTION)
        snapshot = g.events()
        snapshot.clear()
        assert len(g.events()) == 1


class TestDecision:
    def test_denied_decision_carries_reason_and_is_on_exception(self) -> None:
        g = EgressGate()
        with pytest.raises(EgressDeniedError) as exc:
            g.assert_allowed(EgressScope.EXTERNAL_SEND, "send_msg", origin=ORIGIN_INSTRUCTION)
        decision = exc.value.decision
        assert decision.allowed is False
        assert decision.scope is EgressScope.EXTERNAL_SEND
        assert "external_send" in decision.reason

    def test_allowed_decision_carries_reason(self) -> None:
        g = gate(EgressScope.MAP_ROUTE)
        decision = g.assert_allowed(EgressScope.MAP_ROUTE, "route", origin=ORIGIN_INSTRUCTION)
        assert decision.allowed is True
        assert "map_route" in decision.reason


class TestAuditSummary:
    def test_summarize_counts_per_scope_and_ratio(self) -> None:
        g = gate(EgressScope.EXTERNAL_SEND, EgressScope.UPLOAD)
        g.assert_allowed(EgressScope.EXTERNAL_SEND, "a", origin=ORIGIN_INSTRUCTION)
        g.assert_allowed(EgressScope.EXTERNAL_SEND, "b", origin=ORIGIN_INSTRUCTION)
        with pytest.raises(EgressDeniedError):
            g.assert_allowed(EgressScope.EXTERNAL_SEND, "c", origin=ORIGIN_DATA)
        g.assert_allowed(EgressScope.UPLOAD, "d", origin=ORIGIN_DATA, explicit_approval=True)
        summary = EgressAudit.summarize(g.events())
        assert summary["total"] == 4
        assert summary["allowed"] == 3
        assert summary["denied"] == 1
        assert summary["allowed_ratio"] == pytest.approx(0.75)
        external = summary["scopes"]["external_send"]
        assert external == {"allowed": 2, "denied": 1, "total": 3}
        assert summary["scopes"]["upload"] == {"allowed": 1, "denied": 0, "total": 1}

    def test_summarize_empty_events(self) -> None:
        summary = EgressAudit.summarize([])
        assert summary["total"] == 0
        assert summary["allowed"] == 0
        assert summary["denied"] == 0
        assert summary["allowed_ratio"] == 0.0
        assert summary["scopes"] == {}


class TestConcurrency:
    def test_8_threads_no_lost_events(self) -> None:
        g = gate(EgressScope.EXTERNAL_SEND)
        errors: list[BaseException] = []
        results: list[bool] = []

        def worker(i: int) -> None:
            try:
                decision = g.assert_allowed(
                    EgressScope.EXTERNAL_SEND,
                    tool_name=f"send_msg_{i}",
                    origin=ORIGIN_INSTRUCTION,
                )
                results.append(decision.allowed)
            except BaseException as exc:  # pragma: no cover - failure path
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert results == [True] * 8
        events = g.events()
        assert len(events) == 8
        assert all(e.allowed for e in events)
        assert {e.tool_name for e in events} == {f"send_msg_{i}" for i in range(8)}

    def test_thread_pool_mixed_allow_deny(self) -> None:
        g = gate(EgressScope.EXTERNAL_SEND)
        allowed_count = 0

        def worker(i: int) -> None:
            nonlocal allowed_count
            if i % 2 == 0:
                decision = g.assert_allowed(
                    EgressScope.EXTERNAL_SEND, f"t{i}", origin=ORIGIN_INSTRUCTION
                )
                if decision.allowed:
                    allowed_count += 1
            else:
                with pytest.raises(EgressDeniedError):
                    g.assert_allowed(EgressScope.UPLOAD, f"t{i}", origin=ORIGIN_INSTRUCTION)

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(worker, range(8)))
        assert allowed_count == 4
        assert len(g.events()) == 8
        assert sum(1 for e in g.events() if e.allowed) == 4
