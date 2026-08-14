"""Action preconditions (harness gap review L4): fail-closed world-state assertions.

Each precondition declares an assumption the action makes about the world;
``check`` is a pure function over an injected :class:`PreconditionContext`
(no I/O — the caller fills the context with real probe results). A failed
check raises :class:`ActionFailure` with a typed failure and a recovery hint,
aligned with CC Edit's "宁可失败也不猜": a ``None`` context field counts as
insufficient information and therefore as a failure, except
:class:`NoModalSince` with ``t0=None`` which is explicitly disabled.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from app.agent_runtime.errors import ActionFailure, FailureType
from app.anchor import Anchor, AnchorResolution, ResolutionAmbiguous, ResolutionExact


@dataclass(frozen=True, slots=True)
class PreconditionContext:
    """Snapshot of world state probed by the caller before action execution.

    ``None`` fields mean the caller could not obtain that information;
    preconditions treat that as insufficient and fail closed.
    """

    anchor: Anchor | None = None
    resolution: AnchorResolution | None = None
    target_focused: bool | None = None
    expected_content_hash: str | None = None
    actual_content_hash: str | None = None
    modal_seen_since: bool | None = None


class Precondition(Protocol):
    """A declarable world-state assumption; silent pass, raise on failure."""

    def check(self, context: PreconditionContext) -> None: ...


@dataclass(frozen=True, slots=True)
class ResolvedExact:
    """The anchor resolves to the exact same target.

    Any resolution other than ``exact`` (moved/changed/gone/ambiguous) or a
    missing resolution is ``stale_anchor``. ``ambiguous`` is never treated as
    exact and asks the user to confirm.
    """

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
    """The target window keeps focus; anything but an explicit True fails."""

    def check(self, context: PreconditionContext) -> None:
        if context.target_focused is not True:
            raise ActionFailure(
                FailureType.FOCUS_LOST,
                "target is not focused (or focus state unknown)",
                recovery_hint="re-focus target window",
            )


@dataclass(frozen=True, slots=True)
class ContentUnchanged:
    """Target content still matches the idempotency hash; stop if it changed."""

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
    """No modal dialog has appeared since ``t0``.

    ``t0=None`` disables the precondition (documented opt-out): the caller
    may not track modal appearance for this action. When enabled, an unknown
    modal state fails closed.
    """

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
    """Run preconditions in order; the first failure stops the chain.

    The raised :class:`ActionFailure` keeps its failure_type and
    recovery_hint, with the failing precondition's name prepended to the
    message.
    """
    for precondition in preconditions:
        try:
            precondition.check(context)
        except ActionFailure as exc:
            raise ActionFailure(
                exc.failure_type,
                f"{type(precondition).__name__}: {exc.message}",
                exc.recovery_hint,
            ) from exc
