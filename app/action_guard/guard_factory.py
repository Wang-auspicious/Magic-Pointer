
from __future__ import annotations

from collections.abc import Callable
from typing import Any, Protocol, runtime_checkable

from app.action_guard.preconditions import PreconditionContext
from app.anchor import Anchor, AnchorResolution


@runtime_checkable
class GuardProbe(Protocol):

    def resolve_anchor(self, anchor: Anchor) -> AnchorResolution: ...

    def is_focused(self, anchor: Anchor) -> bool: ...

    def content_hash_at(self, anchor: Anchor) -> str | None: ...

    def modal_seen_since(self, anchor: Anchor) -> bool | None: ...


def build_context_factory(
    probe: GuardProbe,
    anchor_from_call: Callable[[dict[str, Any]], Anchor | None],
) -> Callable:

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
    raw = arguments.get("anchor")
    if isinstance(raw, dict):
        try:
            from app.anchor import from_dict

            return from_dict(raw)
        except (ValueError, TypeError):
            return None
    return fallback_anchor
