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


def _material(
    index: int,
    *,
    covered: bool,
    window: list[int] | None,
    selection: list[int] | None = None,
) -> dict:
    return {
        "stroke_index": index,
        "source_window": {"title": "w", "bbox": window} if window is not None else None,
        "selection_bbox": selection if selection is not None else [10, 20, 30, 40],
        "perception_trace": {"marksCovered": covered},
    }


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


def test_each_unread_material_gets_vision_even_when_another_material_was_read():
    import threading
    import time

    snapshot = _snapshot(covers=True)
    snapshot["selection_materials"] = [
        _material(0, covered=True, window=[1130, 188, 2626, 1960]),
        _material(1, covered=False, window=[10, 20, 810, 620]),
        _material(2, covered=False, window=[900, 30, 1700, 630]),
    ]
    calls = []
    in_flight = 0
    peak = 0
    lock = threading.Lock()

    def look(anchor):
        nonlocal in_flight, peak
        with lock:
            in_flight += 1
            peak = max(peak, in_flight)
        time.sleep(0.01)
        calls.append(anchor)
        with lock:
            in_flight -= 1
        return ok_evidence(anchor + " selected content", EvidenceSource.VISION)

    artifact = attach_look_once_if_needed(
        _artifact(), snapshot=snapshot,
        look=look,
        has_frozen_capture=True, has_vision=True,
    )
    assert calls == ["bbox:10,20,810,620", "bbox:900,30,1700,630"]
    facts = [fact.value for fact in artifact.facts if fact.kind == "look_once"]
    assert len(facts) == 2
    assert all(any(anchor in fact for fact in facts) for anchor in calls)
    assert peak == 1, "Look has a shared per-run quota and is not concurrency-safe"
    # 读到的那一笔不该再花一次视觉。
    assert all("A" not in fact.split("（")[0] for fact in facts)


def test_two_unread_strokes_in_one_window_are_asked_once():
    """多笔落在同一个窗口是常态。每一笔各问一次，问的是同一张窗口图。"""
    snapshot = _snapshot(covers=True)
    snapshot["selection_materials"] = [
        _material(0, covered=False, window=[1130, 188, 2626, 1960]),
        _material(1, covered=False, window=[1130, 188, 2626, 1960]),
    ]
    calls = []

    artifact = attach_look_once_if_needed(
        _artifact(), snapshot=snapshot,
        look=lambda anchor: (calls.append(anchor), ok_evidence("窗内文字", EvidenceSource.VISION))[1],
        has_frozen_capture=True, has_vision=True,
    )
    assert calls == ["bbox:1130,188,2626,1960"]
    fact = next(item.value for item in artifact.facts if item.kind == "look_once")
    # 一次调用要能说清它替哪几笔看了：图上标的字母和这里的字母是同一套。
    assert "A, B" in fact


def test_a_stroke_without_a_window_still_gets_a_bounded_look():
    """笔画落在桌面上时没有归属窗口，退回这一笔自己的选区，而不是什么都不看。"""
    snapshot = _snapshot(covers=True)
    snapshot["selection_materials"] = [
        _material(0, covered=False, window=None, selection=[358, 1310, 91, 90]),
    ]
    calls = []

    attach_look_once_if_needed(
        _artifact(), snapshot=snapshot,
        look=lambda anchor: (calls.append(anchor), ok_evidence("x", EvidenceSource.VISION))[1],
        has_frozen_capture=True, has_vision=True,
    )
    assert calls == ["bbox:358,1310,449,1400"]
