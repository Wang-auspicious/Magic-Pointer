"""One frozen-frame look when fusion did not cover the mark.

This is not Vision in the perception fan-out. Conversation turns without a
frozen crop stay honest: they never call look from here.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from typing import Any

from app.evidence.contract import Evidence
from app.input_artifact.schema import InputArtifact, InputFact

LookOnce = Callable[[str], Evidence]


def covers_mark_from_snapshot(snapshot: dict[str, Any] | None) -> bool | None:
    if not isinstance(snapshot, dict):
        return None
    trace = snapshot.get("perception_trace")
    if isinstance(trace, dict) and "marksCovered" in trace:
        value = trace.get("marksCovered")
        if value is None:
            return None
        return bool(value)
    if "structured_covers_mark" in snapshot:
        return bool(snapshot.get("structured_covers_mark"))
    return None


def should_look_once(
    *,
    covers_mark: bool | None,
    has_visual_anchor: bool,
    has_frozen_capture: bool,
    has_vision: bool,
) -> bool:
    return (
        covers_mark is not True
        and bool(has_visual_anchor)
        and bool(has_frozen_capture)
        and bool(has_vision)
    )


def visual_anchor_token(artifact: InputArtifact) -> str | None:
    for fact in artifact.facts:
        if fact.kind != "visual_anchor":
            continue
        token = fact.value.split("（", 1)[0].strip()
        return token or None
    return None


def fact_from_look(evidence: Evidence) -> InputFact:
    status = (
        evidence.status.value
        if hasattr(evidence.status, "value")
        else str(evidence.status)
    )
    parts = [f"status={status}"]
    if evidence.value:
        parts.append(str(evidence.value))
    if evidence.note:
        parts.append(str(evidence.note))
    return InputFact("look_once", "; ".join(parts)[:8_000], ("VISION",))


def attach_look_once_if_needed(
    artifact: InputArtifact,
    *,
    snapshot: dict[str, Any] | None,
    look: LookOnce | None,
    has_frozen_capture: bool,
    has_vision: bool,
) -> InputArtifact:
    if look is None:
        return artifact
    anchor = visual_anchor_token(artifact)
    if not should_look_once(
        covers_mark=covers_mark_from_snapshot(snapshot),
        has_visual_anchor=anchor is not None,
        has_frozen_capture=has_frozen_capture,
        has_vision=has_vision,
    ):
        return artifact
    if not anchor:
        return artifact
    return replace(
        artifact,
        facts=artifact.facts + (fact_from_look(look(anchor)),),
    )
