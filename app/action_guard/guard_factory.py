"""Production precondition context factory (T4.4 guard wiring, data layer).

The loop already enforces ToolSpec preconditions; this module builds the
:class:`PreconditionContext` from live desktop evidence so the guard chain
(anchor exact / focused / content unchanged / no modal) has real data
instead of being skipped. The probe is injectable — production uses the
UIA probe + window enumeration, tests use fakes.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol, runtime_checkable

from app.action_guard.preconditions import PreconditionContext
from app.anchor import Anchor, AnchorResolution


@runtime_checkable
class GuardProbe(Protocol):
    """Live desktop evidence for the guard chain (injectable)."""

    def resolve_anchor(self, anchor: Anchor) -> AnchorResolution: ...

    def is_focused(self, anchor: Anchor) -> bool: ...

    def content_hash_at(self, anchor: Anchor) -> str | None: ...

    def modal_seen_since(self, anchor: Anchor) -> bool | None: ...


def build_context_factory(
    probe: GuardProbe,
    anchor_from_call: Callable[[dict[str, Any]], Anchor | None],
) -> Callable:
    """Return a loop precondition_context_factory backed by the probe.

    ``anchor_from_call`` extracts the target Anchor from the tool call
    arguments (the bridge wires the current selection anchor). When no
    anchor is extractable the factory returns None -> the loop refuses
    fail-closed (permission_denied feedback), matching the L4 "宁可失败
    也不猜" contract.
    """

    def factory(tool_call) -> PreconditionContext | None:
        arguments = getattr(tool_call, "arguments", None) or {}
        anchor = anchor_from_call(dict(arguments))
        if anchor is None:
            return None
        return PreconditionContext(
            anchor=anchor,
            resolution=probe.resolve_anchor(anchor),
            target_focused=probe.is_focused(anchor),
            expected_content_hash=anchor.content_hash,
            actual_content_hash=probe.content_hash_at(anchor),
            modal_seen_since=probe.modal_seen_since(anchor),
        )

    return factory


def anchor_from_arguments(
    arguments: dict[str, Any],
    *,
    fallback_anchor: Anchor | None = None,
) -> Anchor | None:
    """Extract an anchor: explicit ``anchor`` dict in arguments, else the
    caller-provided fallback (the current selection anchor)."""
    raw = arguments.get("anchor")
    if isinstance(raw, dict):
        try:
            from app.anchor import from_dict

            return from_dict(raw)
        except (ValueError, TypeError):
            return None
    return fallback_anchor
