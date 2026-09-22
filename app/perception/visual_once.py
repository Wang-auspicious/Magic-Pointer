
from __future__ import annotations

from collections.abc import Callable, Sequence
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


def _ltrb_anchor(left: Any, top: Any, right: Any, bottom: Any) -> str | None:
    try:
        values = tuple(int(round(float(value))) for value in (left, top, right, bottom))
    except (TypeError, ValueError):
        return None
    if values[2] <= values[0] or values[3] <= values[1]:
        return None
    return "bbox:" + ",".join(str(value) for value in values)


def _material_look_anchor(material: Any) -> str | None:
    if not isinstance(material, dict):
        return None
    window = material.get("source_window")
    bbox = window.get("bbox") if isinstance(window, dict) else None
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        anchor = _ltrb_anchor(*bbox)
        if anchor is not None:
            return anchor
    selection = material.get("selection_bbox")
    if isinstance(selection, (list, tuple)) and len(selection) == 4:
        try:
            x, y, width, height = (int(round(float(value))) for value in selection)
        except (TypeError, ValueError):
            return None
        return _ltrb_anchor(x, y, x + width, y + height)
    return None


def _uncovered_material_anchors(
    materials: Sequence[Any],
    *,
    has_frozen_capture: bool,
    has_vision: bool,
) -> list[tuple[str, tuple[int, ...]]]:
    groups: dict[str, list[int]] = {}
    order: list[str] = []
    for index, material in enumerate(materials):
        if not isinstance(material, dict):
            continue
        anchor = _material_look_anchor(material)
        if anchor is None:
            continue
        if not should_look_once(
            covers_mark=covers_mark_from_snapshot(material),
            has_visual_anchor=True,
            has_frozen_capture=has_frozen_capture,
            has_vision=has_vision,
        ):
            continue
        if anchor not in groups:
            groups[anchor] = []
            order.append(anchor)
        groups[anchor].append(index)
    return [(anchor, tuple(groups[anchor])) for anchor in order]


def _material_names(indexes: Sequence[int]) -> str:
    return ", ".join(chr(ord("A") + index) for index in indexes)


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
    materials = (snapshot or {}).get("selection_materials") or []
    snapshot_id = str((snapshot or {}).get("snapshot_id") or "")
    if materials and snapshot_id:
        windows = _uncovered_material_anchors(
            materials,
            has_frozen_capture=has_frozen_capture,
            has_vision=has_vision,
        )
        if not windows:
            return artifact
        facts = []
        for anchor, indexes in windows:
            fact = fact_from_look(look(anchor))
            names = _material_names(indexes)
            facts.append(replace(
                fact,
                value=f"{anchor}（材料 {names} 所在的窗口，笔迹已标在图上）: {fact.value}",
            ))
        return replace(artifact, facts=artifact.facts + tuple(facts))
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
