"""Tests for action preconditions (harness gap review L4, task B1).

Covers: the four concrete precondition assertions (ResolvedExact,
TargetFocused, ContentUnchanged, NoModalSince), their fail-closed semantics
when context fields are None (insufficient information means fail, except
NoModalSince with t0=None which is disabled), check_all sequential execution,
and consistency with errors.py's is_retryable determination.
"""

from __future__ import annotations

import pytest

from app.action_guard.preconditions import (
    ContentUnchanged,
    NoModalSince,
    Precondition,
    PreconditionContext,
    ResolvedExact,
    TargetFocused,
    check_all,
)
from app.agent_runtime.errors import ActionFailure, FailureType
from app.anchor import (
    Anchor,
    AppIdentity,
    ResolutionAmbiguous,
    ResolutionChanged,
    ResolutionExact,
    ResolutionGone,
    ResolutionMoved,
    build_anchor,
)


def make_anchor(anchor_id: str = "a1") -> Anchor:
    return build_anchor(
        anchor_id=anchor_id,
        app_identity=AppIdentity(process_name="notepad.exe", process_id=1),
        structural_path="/window[1]/edit[0]",
        content_hash="h1",
        captured_at_utc="2026-08-12T00:00:00Z",
    )


def exact() -> ResolutionExact:
    return ResolutionExact(anchor=make_anchor(), evidence=("app", "structure"))


def ctx(**fields: object) -> PreconditionContext:
    return PreconditionContext(**fields)


class TestResolvedExact:
    def test_exact_passes(self) -> None:
        ResolvedExact().check(ctx(resolution=exact()))

    def test_resolution_none_fails_stale_anchor(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            ResolvedExact().check(ctx())
        assert exc.value.failure_type is FailureType.STALE_ANCHOR
        assert exc.value.recovery_hint == "re-resolve target before acting"

    def test_gone_fails_stale_anchor(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            ResolvedExact().check(ctx(resolution=ResolutionGone(anchor=make_anchor(), reason="window closed")))
        assert exc.value.failure_type is FailureType.STALE_ANCHOR
        assert exc.value.recovery_hint == "re-resolve target before acting"

    def test_moved_fails_stale_anchor(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            ResolvedExact().check(ctx(resolution=ResolutionMoved(anchor=make_anchor(), new_position=(0.5, 0.5), evidence=("spatial",))))
        assert exc.value.failure_type is FailureType.STALE_ANCHOR
        assert exc.value.recovery_hint == "re-resolve target before acting"

    def test_changed_fails_stale_anchor(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            ResolvedExact().check(ctx(resolution=ResolutionChanged(anchor=make_anchor(), expected_hash="h1", actual_hash="h2", evidence=("content",))))
        assert exc.value.failure_type is FailureType.STALE_ANCHOR

    def test_ambiguous_fails_with_ambiguous_hint(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            ResolvedExact().check(
                ctx(
                    resolution=ResolutionAmbiguous(
                        anchor=make_anchor(),
                        candidates=(make_anchor("a1"), make_anchor("a2")),
                        evidence=("structure",),
                    )
                )
            )
        assert exc.value.failure_type is FailureType.STALE_ANCHOR
        assert "ambiguous" in exc.value.recovery_hint


class TestTargetFocused:
    def test_true_passes(self) -> None:
        TargetFocused().check(ctx(target_focused=True))

    def test_false_fails_focus_lost(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            TargetFocused().check(ctx(target_focused=False))
        assert exc.value.failure_type is FailureType.FOCUS_LOST
        assert exc.value.recovery_hint == "re-focus target window"

    def test_none_fails_focus_lost(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            TargetFocused().check(ctx())
        assert exc.value.failure_type is FailureType.FOCUS_LOST
        assert exc.value.recovery_hint == "re-focus target window"


class TestContentUnchanged:
    def test_matching_passes(self) -> None:
        ContentUnchanged().check(ctx(expected_content_hash="h1", actual_content_hash="h1"))

    def test_mismatch_fails_content_changed(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            ContentUnchanged().check(ctx(expected_content_hash="h1", actual_content_hash="h2"))
        assert exc.value.failure_type is FailureType.CONTENT_CHANGED
        assert exc.value.recovery_hint == "target content changed; stop before writing"

    def test_actual_none_fails_content_changed(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            ContentUnchanged().check(ctx(expected_content_hash="h1"))
        assert exc.value.failure_type is FailureType.CONTENT_CHANGED
        assert exc.value.recovery_hint == "target content changed; stop before writing"

    def test_expected_none_fails_closed(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            ContentUnchanged().check(ctx(actual_content_hash="h1"))
        assert exc.value.failure_type is FailureType.CONTENT_CHANGED


class TestNoModalSince:
    def test_false_passes(self) -> None:
        NoModalSince(t0=100.0).check(ctx(modal_seen_since=False))

    def test_true_fails_blocked_by_modal(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            NoModalSince(t0=100.0).check(ctx(modal_seen_since=True))
        assert exc.value.failure_type is FailureType.BLOCKED_BY_MODAL
        assert exc.value.recovery_hint == "close the dialog first"

    def test_disabled_when_t0_none(self) -> None:
        NoModalSince().check(ctx(modal_seen_since=True))

    def test_modal_unknown_fails_closed_when_enabled(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            NoModalSince(t0=100.0).check(ctx())
        assert exc.value.failure_type is FailureType.BLOCKED_BY_MODAL


class TestCheckAll:
    def test_all_pass(self) -> None:
        check_all(
            (ResolvedExact(), TargetFocused(), ContentUnchanged(), NoModalSince(t0=100.0)),
            ctx(
                resolution=exact(),
                target_focused=True,
                expected_content_hash="h1",
                actual_content_hash="h1",
                modal_seen_since=False,
            ),
        )

    def test_second_failure_reported_with_name(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            check_all(
                (ResolvedExact(), ContentUnchanged()),
                ctx(resolution=exact(), expected_content_hash="h1", actual_content_hash="h2"),
            )
        assert exc.value.failure_type is FailureType.CONTENT_CHANGED
        assert "ContentUnchanged" in exc.value.message

    def test_first_failure_short_circuits(self) -> None:
        with pytest.raises(ActionFailure) as exc:
            check_all(
                (ResolvedExact(), TargetFocused()),
                ctx(target_focused=True),
            )
        assert exc.value.failure_type is FailureType.STALE_ANCHOR

    def test_preserves_order(self) -> None:
        calls: list[str] = []

        class Recording(Precondition):
            def __init__(self, name: str) -> None:
                self._name = name

            def check(self, context: PreconditionContext) -> None:
                calls.append(self._name)

        check_all((Recording("first"), Recording("second"), Recording("third")), ctx())
        assert calls == ["first", "second", "third"]


class TestRetryableSemantics:
    def test_matches_errors_py(self) -> None:
        focus = ActionFailure(FailureType.FOCUS_LOST, "x", "re-focus target window")
        stale = ActionFailure(FailureType.STALE_ANCHOR, "x", "re-resolve target before acting")
        changed = ActionFailure(FailureType.CONTENT_CHANGED, "x", "target content changed")
        modal = ActionFailure(FailureType.BLOCKED_BY_MODAL, "x", "close the dialog first")
        assert focus.is_retryable() is True
        assert stale.is_retryable() is False
        assert changed.is_retryable() is False
        assert modal.is_retryable() is False
