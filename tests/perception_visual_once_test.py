"""Harness looks once when structured evidence missed the mark."""

from __future__ import annotations

from app.evidence.contract import EvidenceSource, EvidenceStatus, failed_evidence, ok_evidence
from app.input_artifact import compile_input_artifact
from app.perception.visual_once import attach_look_once_if_needed, should_look_once


def _snapshot(*, covers: bool | None = False) -> dict:
    return {
        "snapshot_id": "sel-1",
        "captured_at": "2026-08-19T08:00:00+00:00",
        "source_kind": "native_selection",
        "selection_gesture": {
            "schemaVersion": 2,
            "coordinateSpace": "physical_screen_pixels",
            "bbox": {"x": 10, "y": 20, "width": 30, "height": 40},
            "strokes": [{"points": [{"x": 10, "y": 40}, {"x": 40, "y": 40}]}],
        },
        "capture_path": "D:/evidence/frozen.png",
        "frame_lease": {
            "frameLeaseId": "lease-1",
            "surfaceBoundsPx": [10, 20, 200, 220],
        },
        "perception_trace": {
            "schemaVersion": 1,
            "marksCovered": covers,
        },
    }


def _artifact():
    return compile_input_artifact(
        "这是什么",
        {"title": "窗口"},
        None,
        _snapshot(),
    )


def test_should_look_when_mark_is_uncovered_and_pixels_exist() -> None:
    assert should_look_once(
        covers_mark=False,
        has_visual_anchor=True,
        has_frozen_capture=True,
        has_vision=True,
    ) is True


def test_should_not_look_when_structure_already_covers() -> None:
    assert should_look_once(
        covers_mark=True,
        has_visual_anchor=True,
        has_frozen_capture=True,
        has_vision=True,
    ) is False


def test_should_not_look_without_vision_or_frozen_frame() -> None:
    assert should_look_once(
        covers_mark=False,
        has_visual_anchor=True,
        has_frozen_capture=True,
        has_vision=False,
    ) is False
    assert should_look_once(
        covers_mark=False,
        has_visual_anchor=True,
        has_frozen_capture=False,
        has_vision=True,
    ) is False
    assert should_look_once(
        covers_mark=False,
        has_visual_anchor=False,
        has_frozen_capture=True,
        has_vision=True,
    ) is False


def test_attach_looks_once_and_writes_the_evidence_fact() -> None:
    calls: list[str] = []

    def look(anchor: str):
        calls.append(anchor)
        return ok_evidence("按钮上写着保存", EvidenceSource.VISION)

    artifact = attach_look_once_if_needed(
        _artifact(),
        snapshot=_snapshot(covers=False),
        look=look,
        has_frozen_capture=True,
        has_vision=True,
    )
    assert calls == ["bbox:10,20,200,220"]
    fact = next(item for item in artifact.facts if item.kind == "look_once")
    assert "保存" in fact.value
    assert "VISION" in fact.sources


def test_attach_skips_when_the_mark_is_already_covered() -> None:
    calls: list[str] = []
    artifact = attach_look_once_if_needed(
        _artifact(),
        snapshot=_snapshot(covers=True),
        look=lambda anchor: calls.append(anchor) or ok_evidence("nope", EvidenceSource.VISION),
        has_frozen_capture=True,
        has_vision=True,
    )
    assert calls == []
    assert [item.kind for item in artifact.facts if item.kind == "look_once"] == []


def test_failed_look_keeps_an_honest_status() -> None:
    artifact = attach_look_once_if_needed(
        _artifact(),
        snapshot=_snapshot(covers=False),
        look=lambda _anchor: failed_evidence(
            EvidenceSource.VISION,
            EvidenceStatus.UNSUPPORTED,
            "vision_unavailable",
        ),
        has_frozen_capture=True,
        has_vision=True,
    )
    fact = next(item for item in artifact.facts if item.kind == "look_once")
    assert "unsupported" in fact.value
    assert "vision_unavailable" in fact.value
