"""Tests for the approval ledger (harness gap review L5 / L7.3, task B3).

Covers: the requires_approval effect matrix, request() registration as
PENDING with full fields, approve()/reject() transitions with human-only
approvers (NON_HUMAN_APPROVERS blacklist — L5: confirmation cannot be
triggered by the model), idempotency, EXPIRED invalidation when the target
identity/content hash changed, the approve_reversible convenience path for
effects that do not require approval, unknown-id failures, pending /
all / records audit views, origin field passthrough (L7 action-origin
audit), request validation and thread safety.
"""

from __future__ import annotations

import threading

import pytest

from app.action_guard.approval import (
    NON_HUMAN_APPROVERS,
    ActionApproval,
    ApprovalError,
    ApprovalRequest,
    ApprovalStatus,
)
from app.agent_runtime.tool_registry import Effect
from app.agent_runtime.types import ORIGIN_DATA, ORIGIN_INSTRUCTION

REQUIRED_EFFECTS = (
    Effect.LOCAL_IRREVERSIBLE,
    Effect.EXTERNAL_SEND,
    Effect.DESTRUCTIVE,
    Effect.PURCHASE,
)
FREE_EFFECTS = (Effect.READ, Effect.REVERSIBLE_WRITE)

TARGET_IDENTITY = "hwnd:0x1a2b:pid:1234"


def make_request(
    approval: ActionApproval,
    effect: Effect = Effect.LOCAL_IRREVERSIBLE,
    origin: str = ORIGIN_DATA,
) -> ApprovalRequest:
    return approval.request(
        tool_name="send_msg",
        target_identity=TARGET_IDENTITY,
        content_hash="sha256:deadbeef",
        effect=effect,
        origin=origin,
    )


class TestRequiresApproval:
    @pytest.mark.parametrize("effect", REQUIRED_EFFECTS)
    def test_irreversible_effects_require_approval(self, effect: Effect) -> None:
        assert ActionApproval.requires_approval(effect) is True

    @pytest.mark.parametrize("effect", FREE_EFFECTS)
    def test_read_and_reversible_write_are_exempt(self, effect: Effect) -> None:
        assert ActionApproval.requires_approval(effect) is False


class TestRequestRegistration:
    def test_request_registers_pending_with_full_fields(self) -> None:
        approval = ActionApproval()
        request = approval.request(
            tool_name="send_msg",
            target_identity=TARGET_IDENTITY,
            content_hash="sha256:deadbeef",
            effect=Effect.EXTERNAL_SEND,
            origin=ORIGIN_INSTRUCTION,
        )
        assert request.status is ApprovalStatus.PENDING
        assert request.status_changed_at_utc is None
        assert request.request_id
        assert request.tool_name == "send_msg"
        assert request.target_identity == TARGET_IDENTITY
        assert request.content_hash == "sha256:deadbeef"
        assert request.effect is Effect.EXTERNAL_SEND
        assert request.origin == ORIGIN_INSTRUCTION
        assert request.requested_at_utc.endswith("Z")
        assert "T" in request.requested_at_utc

    def test_request_defaults_to_data_origin(self) -> None:
        request = make_request(ActionApproval())
        assert request.origin == ORIGIN_DATA

    def test_request_ids_are_unique(self) -> None:
        approval = ActionApproval()
        ids = {make_request(approval).request_id for _ in range(5)}
        assert len(ids) == 5


class TestApprove:
    def test_approve_transitions_and_stamps_time(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        approved = approval.approve(request.request_id, by="human-alice")
        assert approved.status is ApprovalStatus.APPROVED
        assert approved.status_changed_at_utc is not None
        assert approval.status(request.request_id) is ApprovalStatus.APPROVED

    def test_approve_is_idempotent(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        first = approval.approve(request.request_id, by="human-alice")
        second = approval.approve(request.request_id, by="human-alice")
        assert second.status is ApprovalStatus.APPROVED
        assert second.status_changed_at_utc == first.status_changed_at_utc

    def test_is_approved(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        assert approval.is_approved(request) is False
        approved = approval.approve(request.request_id, by="human-alice")
        assert approval.is_approved(approved) is True

    def test_approve_unknown_id_raises(self) -> None:
        with pytest.raises(ApprovalError):
            ActionApproval().approve("nope", by="human-alice")


class TestApproveHumanOnly:
    @pytest.mark.parametrize("by", NON_HUMAN_APPROVERS)
    def test_non_human_approver_refused(self, by: str) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        with pytest.raises(ApprovalError) as exc:
            approval.approve(request.request_id, by=by)
        assert exc.value.request_id == request.request_id
        assert approval.status(request.request_id) is ApprovalStatus.PENDING

    def test_empty_approver_refused(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        with pytest.raises(ApprovalError):
            approval.approve(request.request_id, by="")
        assert approval.status(request.request_id) is ApprovalStatus.PENDING


class TestReject:
    def test_reject_transitions_and_stamps_time(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        rejected = approval.reject(
            request.request_id, by="human-alice", reason="wrong target"
        )
        assert rejected.status is ApprovalStatus.REJECTED
        assert rejected.status_changed_at_utc is not None

    def test_reject_is_idempotent(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        approval.reject(request.request_id, by="human-alice")
        again = approval.reject(request.request_id, by="human-alice")
        assert again.status is ApprovalStatus.REJECTED

    def test_rejected_cannot_be_approved(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        approval.reject(request.request_id, by="human-alice")
        with pytest.raises(ApprovalError) as exc:
            approval.approve(request.request_id, by="human-bob")
        assert exc.value.request_id == request.request_id

    def test_approve_after_reject_surfaces_reason(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        approval.reject(request.request_id, by="human-alice", reason="not today")
        with pytest.raises(ApprovalError) as exc:
            approval.approve(request.request_id, by="human-bob")
        assert "not today" in exc.value.reason

    def test_reject_revokes_approved_request(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        approval.approve(request.request_id, by="human-alice")
        revoked = approval.reject(request.request_id, by="human-alice")
        assert revoked.status is ApprovalStatus.REJECTED
        with pytest.raises(ApprovalError):
            approval.approve(request.request_id, by="human-bob")

    def test_reject_unknown_id_raises(self) -> None:
        with pytest.raises(ApprovalError):
            ActionApproval().reject("nope", by="human-alice")


class TestInvalidate:
    def test_invalidate_approved_to_expired(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        approval.approve(request.request_id, by="human-alice")
        expired = approval.invalidate(request.request_id, reason="content changed")
        assert expired.status is ApprovalStatus.EXPIRED
        assert expired.status_changed_at_utc is not None

    def test_expired_cannot_be_approved(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        approval.invalidate(request.request_id, reason="target moved")
        with pytest.raises(ApprovalError):
            approval.approve(request.request_id, by="human-alice")

    def test_invalidate_pending_prevents_later_approval(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        approval.invalidate(request.request_id, reason="target moved")
        with pytest.raises(ApprovalError):
            approval.approve(request.request_id, by="human-alice")

    def test_invalidate_is_idempotent_on_expired(self) -> None:
        approval = ActionApproval()
        request = make_request(approval)
        approval.invalidate(request.request_id)
        again = approval.invalidate(request.request_id)
        assert again.status is ApprovalStatus.EXPIRED

    def test_invalidate_unknown_id_raises(self) -> None:
        with pytest.raises(ApprovalError):
            ActionApproval().invalidate("nope")

    def test_re_request_after_expiry_can_be_approved(self) -> None:
        approval = ActionApproval()
        first = make_request(approval)
        approval.invalidate(first.request_id, reason="target moved")
        second = make_request(approval)
        assert second.request_id != first.request_id
        approved = approval.approve(second.request_id, by="human-alice")
        assert approved.status is ApprovalStatus.APPROVED


class TestApproveReversible:
    def test_reversible_write_record_and_approve(self) -> None:
        approval = ActionApproval()
        request = make_request(approval, effect=Effect.REVERSIBLE_WRITE)
        approved = approval.approve_reversible(request.request_id, by="human-alice")
        assert approved.status is ApprovalStatus.APPROVED

    def test_approve_reversible_refuses_irreversible_effect(self) -> None:
        approval = ActionApproval()
        request = make_request(approval, effect=Effect.DESTRUCTIVE)
        with pytest.raises(ApprovalError):
            approval.approve_reversible(request.request_id, by="human-alice")

    def test_approve_reversible_still_human_only(self) -> None:
        approval = ActionApproval()
        request = make_request(approval, effect=Effect.REVERSIBLE_WRITE)
        with pytest.raises(ApprovalError):
            approval.approve_reversible(request.request_id, by="model")

    def test_approve_reversible_unknown_id_raises(self) -> None:
        with pytest.raises(ApprovalError):
            ActionApproval().approve_reversible("nope", by="human-alice")


class TestUnknownId:
    def test_status_unknown_raises(self) -> None:
        with pytest.raises(ApprovalError):
            ActionApproval().status("missing")


class TestAudit:
    def test_pending_lists_only_pending(self) -> None:
        approval = ActionApproval()
        p1 = make_request(approval)
        p2 = make_request(approval)
        a1 = make_request(approval)
        approval.approve(a1.request_id, by="human-alice")
        r1 = make_request(approval)
        approval.reject(r1.request_id, by="human-alice")
        pending = approval.pending()
        assert {x.request_id for x in pending} == {p1.request_id, p2.request_id}

    def test_all_requests_in_registration_order(self) -> None:
        approval = ActionApproval()
        ids = [make_request(approval).request_id for _ in range(4)]
        assert [r.request_id for r in approval.all_requests()] == ids

    def test_records_is_audit_snapshot(self) -> None:
        approval = ActionApproval()
        make_request(approval)
        snapshot = approval.records()
        snapshot.clear()
        assert len(approval.records()) == 1
        assert len(approval.all_requests()) == 1

    def test_records_preserve_origin_across_transitions(self) -> None:
        approval = ActionApproval()
        data_req = approval.request(
            tool_name="submit_form",
            target_identity="cdp:tab:42",
            content_hash=None,
            effect=Effect.EXTERNAL_SEND,
            origin=ORIGIN_DATA,
        )
        approval.approve(data_req.request_id, by="human-alice")
        matched = next(
            r for r in approval.records() if r.request_id == data_req.request_id
        )
        assert matched.origin == ORIGIN_DATA
        assert matched.status is ApprovalStatus.APPROVED


class TestDataOriginAudit:
    def test_data_origin_request_is_auditable(self) -> None:
        approval = ActionApproval()
        request = approval.request(
            tool_name="fill_form",
            target_identity="web:form:1",
            content_hash="sha256:feed",
            effect=Effect.EXTERNAL_SEND,
            origin=ORIGIN_DATA,
        )
        assert request.origin == ORIGIN_DATA
        assert [r.origin for r in approval.records()] == [ORIGIN_DATA]


class TestRequestValidation:
    def test_invalid_effect_rejected(self) -> None:
        with pytest.raises(TypeError):
            ActionApproval().request(
                "t", TARGET_IDENTITY, None, effect="destructive"
            )

    def test_invalid_origin_rejected(self) -> None:
        with pytest.raises(ValueError):
            ActionApproval().request(
                "t", TARGET_IDENTITY, None, Effect.DESTRUCTIVE, origin="screen_ocr"
            )

    def test_empty_tool_name_rejected(self) -> None:
        with pytest.raises(ValueError):
            ActionApproval().request(
                "", TARGET_IDENTITY, None, Effect.DESTRUCTIVE
            )

    def test_empty_target_identity_rejected(self) -> None:
        with pytest.raises(ValueError):
            ActionApproval().request("t", "", None, Effect.DESTRUCTIVE)


class TestConcurrency:
    def test_8_threads_request_and_approve(self) -> None:
        approval = ActionApproval()
        errors: list[BaseException] = []
        ids: list[str] = []

        def worker() -> None:
            try:
                request = approval.request(
                    tool_name="send_msg",
                    target_identity=TARGET_IDENTITY,
                    content_hash="sha256:deadbeef",
                    effect=Effect.EXTERNAL_SEND,
                    origin=ORIGIN_DATA,
                )
                approved = approval.approve(request.request_id, by="human-alice")
                ids.append(approved.request_id)
            except BaseException as exc:  # pragma: no cover - failure path
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        assert len(ids) == 8
        assert len(set(ids)) == 8
        records = approval.records()
        assert len(records) == 8
        assert all(r.status is ApprovalStatus.APPROVED for r in records)
