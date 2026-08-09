"""填入 must never claim a write it did not verify.

The bug `a6a6d08` removed was an in-place rewrite reporting success while the
user's text was untouched. Carrying the capsule answer into another app reopens
exactly that risk: the paste into a self-drawn control (WeChat, Canvas) happens
blind, and there is no readable text to compare against afterwards.

These tests pin the resolution: an unverifiable write is reported as an
unverifiable write, and the answer lands on the clipboard so the user can finish
it themselves in one keystroke.
"""

from __future__ import annotations

import hashlib

import pytest

from app.actions.capsule_delivery import (
    CAPSULE_DELIVERY_KIND,
    CLIPBOARD_FALLBACK_KIND,
    WRITTEN,
    describe_delivery_failure,
    make_capsule_delivery_proposal,
    make_clipboard_fallback_proposal,
)
from app.actions.draft_delivery import DraftDeliveryError
from app.actions.policy import LocalPermissionPolicy

TARGET_WINDOW = {
    "hwnd": 4321,
    "pid": 8765,
    "title": "文件传输助手 - 微信",
    "process_name": "WeChat.exe",
    "class_name": "WeChatMainWndForPC",
}


def _proposal(text: str = "改好的那句话"):
    return make_capsule_delivery_proposal(
        text,
        target_window=TARGET_WINDOW,
        target_point={"x": 900, "y": 700},
        target_point_space="physical_screen_pixels",
    )


def test_delivery_proposal_keeps_every_identity_guarantee() -> None:
    proposal = _proposal()
    params = proposal.parameters
    assert proposal.action_type == "paste_text_to_foreground"
    assert proposal.id.startswith("capsule-delivery-")
    assert params["target_hwnd"] == 4321
    assert params["target_process_id"] == 8765
    assert params["target_title"] == "文件传输助手 - 微信"
    assert params["target_point_space"] == "physical_screen_pixels"
    assert params["text_sha256"] == hashlib.sha256("改好的那句话".encode()).hexdigest()
    # Magic Pointer never presses send for the user.
    assert params["submit"] is False
    assert proposal.metadata["no_submit"] is True
    assert proposal.metadata["delivery_kind"] == CAPSULE_DELIVERY_KIND


def test_adaptive_delivery_keeps_main_owned_current_window_hint() -> None:
    proposal = make_capsule_delivery_proposal(
        "写入这段文字",
        target_window=TARGET_WINDOW,
        target_point={"x": 900, "y": 700},
        target_point_space="physical_screen_pixels",
        target_resolution="adaptive",
        current_target_window={
            "hwnd": 7001,
            "process_id": 7002,
            "process_name": "Cursor.exe",
            "renderer_supplied_field": "must not cross the boundary",
        },
    )

    assert proposal.parameters["target_resolution"] == "adaptive"
    assert proposal.parameters["current_target_hwnd"] == 7001
    assert proposal.parameters["current_target_process_id"] == 7002
    assert proposal.parameters["current_target_process_name"] == "Cursor.exe"
    assert "renderer_supplied_field" not in proposal.parameters


def test_delivery_is_refused_without_a_trustworthy_target() -> None:
    for broken in (
        {**TARGET_WINDOW, "hwnd": 0},
        {**TARGET_WINDOW, "title": ""},
        {k: v for k, v in TARGET_WINDOW.items() if k not in {"pid"}},
    ):
        with pytest.raises(DraftDeliveryError):
            make_capsule_delivery_proposal(
                "x",
                target_window=broken,
                target_point={"x": 1, "y": 2},
                target_point_space="physical_screen_pixels",
            )


def test_a_guessed_coordinate_space_is_never_accepted() -> None:
    # A DIP point would land somewhere else entirely on a 150% display, which is
    # how a write ends up in the wrong control.
    with pytest.raises(DraftDeliveryError):
        make_capsule_delivery_proposal(
            "x",
            target_window=TARGET_WINDOW,
            target_point={"x": 1, "y": 2},
            target_point_space="electron_dip",
        )


def test_the_write_needs_no_extra_confirmation_but_stays_bounded() -> None:
    # The user pressing 填入 *is* the confirmation; the policy grants it only
    # because submit is off and the target identity is complete.
    decision = LocalPermissionPolicy().decide(_proposal())
    assert decision.allowed is True
    assert decision.requires_confirmation is False

    unbounded = _proposal()
    unbounded.parameters["submit"] = True
    escalated = LocalPermissionPolicy().decide(unbounded)
    assert escalated.requires_confirmation is True


def test_an_unverifiable_paste_is_reported_as_unverifiable() -> None:
    # This is the WeChat case: Ctrl+V was sent, nothing can be read back.
    verdict = describe_delivery_failure(
        "keyboard paste could not be verified from the editable element"
    )
    assert verdict.kind == "clipboard"
    assert verdict.reason_code == "write_not_verifiable"
    assert verdict.write_attempted is True
    assert "无法确认" in verdict.message
    assert "Ctrl+V" in verdict.message
    # The one thing it must never say.
    assert "已填入" not in verdict.message


def test_a_refusal_says_which_refusal_it_was() -> None:
    cases = {
        "the pointed element is not an editable input surface": "not_an_input_surface",
        "target input already contains a different draft; clear it before delivery": "input_already_has_text",
        "password inputs are never eligible for draft delivery": "password_input",
        "the pointed input surface is disabled": "input_disabled",
        "target window could not be restored to foreground": "window_not_foreground",
        "terminal delivery requires a local prompt artifact": "terminal_target",
    }
    for error, expected in cases.items():
        verdict = describe_delivery_failure(error)
        assert verdict.reason_code == expected, error
        # None of these sent keys, so none may imply the text moved.
        assert verdict.write_attempted is False, error
        assert "Ctrl+V" in verdict.message


def test_an_unfamiliar_error_is_not_dressed_up_as_a_known_cause() -> None:
    verdict = describe_delivery_failure("some writer failure nobody has seen yet")
    assert verdict.kind == "clipboard"
    assert verdict.reason_code == "write_refused"
    assert verdict.write_attempted is False


def test_no_failure_verdict_can_ever_read_as_success() -> None:
    errors = [
        "the pointed element is not an editable input surface",
        "target input already contains a different draft",
        "password inputs are never eligible for draft delivery",
        "the pointed input surface is disabled",
        "target window could not be restored to foreground",
        "terminal delivery requires a local prompt artifact",
        "keyboard paste could not be verified from the editable element",
        "UI Automation value verification failed",
        "draft writer character-count verification failed",
        "draft writer did not verify the write",
        "",
        None,
    ]
    for error in errors:
        verdict = describe_delivery_failure(error)
        assert verdict.kind == "clipboard"
        assert verdict != WRITTEN
        assert "已填入输入框并核对过" not in verdict.message


def test_only_a_verified_write_gets_the_success_sentence() -> None:
    assert WRITTEN.kind == "written"
    assert WRITTEN.write_attempted is True
    assert "核对过" in WRITTEN.message
    assert "没有发送" in WRITTEN.message


def test_the_clipboard_fallback_carries_the_reason_and_needs_no_confirmation() -> None:
    proposal = make_clipboard_fallback_proposal("改好的那句话", reason_code="write_not_verifiable")
    assert proposal.action_type == "copy_text_to_clipboard"
    assert proposal.parameters["text"] == "改好的那句话"
    assert proposal.parameters["fallback_reason"] == "write_not_verifiable"
    assert proposal.metadata["delivery_kind"] == CLIPBOARD_FALLBACK_KIND
    decision = LocalPermissionPolicy().decide(proposal)
    assert decision.allowed is True
    assert decision.requires_confirmation is False


def test_empty_text_is_refused_on_both_paths() -> None:
    with pytest.raises(DraftDeliveryError):
        make_clipboard_fallback_proposal("   ", reason_code="x")
    with pytest.raises(DraftDeliveryError):
        make_capsule_delivery_proposal(
            "",
            target_window=TARGET_WINDOW,
            target_point={"x": 1, "y": 2},
            target_point_space="physical_screen_pixels",
        )
