
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.agent_runtime.errors import ActionFailure, FailureType
from app.anchor import Anchor, AnchorResolution, ResolutionAmbiguous, ResolutionExact


@dataclass(frozen=True, slots=True)
class PreconditionContext:

    anchor: Anchor | None = None
    resolution: AnchorResolution | None = None
    target_focused: bool | None = None
    expected_content_hash: str | None = None
    actual_content_hash: str | None = None
    modal_seen_since: bool | None = None


class Precondition(Protocol):

    def check(self, context: PreconditionContext) -> None: ...


@dataclass(frozen=True, slots=True)
class ResolvedExact:

    def check(self, context: PreconditionContext) -> None:
        resolution = context.resolution
        if isinstance(resolution, ResolutionAmbiguous):
            raise ActionFailure(
                FailureType.STALE_ANCHOR,
                "resolution is ambiguous; user confirmation required, never act on an ambiguous target",
                recovery_hint="ambiguous target: re-resolve and ask the user to confirm before acting",
            )
        if not isinstance(resolution, ResolutionExact):
            raise ActionFailure(
                FailureType.STALE_ANCHOR,
                f"resolution is {type(resolution).__name__ if resolution is not None else 'None'}, expected exact",
                recovery_hint="re-resolve target before acting",
            )


@dataclass(frozen=True, slots=True)
class TargetFocused:

    def check(self, context: PreconditionContext) -> None:
        if context.target_focused is not True:
            raise ActionFailure(
                FailureType.FOCUS_LOST,
                "target is not focused (or focus state unknown)",
                recovery_hint="re-focus target window",
            )


@dataclass(frozen=True, slots=True)
class ContentUnchanged:

    def check(self, context: PreconditionContext) -> None:
        expected = context.expected_content_hash
        actual = context.actual_content_hash
        if expected is None or actual is None or actual != expected:
            raise ActionFailure(
                FailureType.CONTENT_CHANGED,
                f"target content no longer matches expected hash (expected={expected!r}, actual={actual!r})",
                recovery_hint="target content changed; stop before writing",
            )


@dataclass(frozen=True, slots=True)
class NoModalSince:

    t0: float | None = None

    def check(self, context: PreconditionContext) -> None:
        if self.t0 is None:
            return
        if context.modal_seen_since is not False:
            raise ActionFailure(
                FailureType.BLOCKED_BY_MODAL,
                f"modal dialog appeared since t0={self.t0!r} (or modal state unknown)",
                recovery_hint="close the dialog first",
            )


def check_all(
    preconditions: tuple[Precondition, ...] | list[Precondition],
    context: PreconditionContext,
) -> None:
    for precondition in preconditions:
        try:
            precondition.check(context)
        except ActionFailure as exc:
            raise ActionFailure(
                exc.failure_type,
                f"{type(precondition).__name__}: {exc.message}",
                exc.recovery_hint,
            ) from exc
