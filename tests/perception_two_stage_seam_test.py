
from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

import app.perception.pixel_ocr as pixel_ocr
from app.adapters.base import AdapterReadContext
from app.grounding.perception_cascade import resolve_structured_perception
from app.input_artifact import compile_input_artifact
from scripts.selection_bridge import _fuse_pixel_tier
from scripts.selection_snapshot_bridge import capture_snapshot

CONSOLE = {
    "title": "Windows PowerShell",
    "hwnd": 31,
    "pid": 4242,
    "process_name": "powershell.exe",
    "bbox": (194, 196, 2544, 1421),
}
UNDERLINE = {
    "schemaVersion": 2,
    "coordinateSpace": "physical_screen_pixels",
    "releasePoint": {"x": 1604, "y": 301},
    "bbox": {"x": 429, "y": 286, "width": 1175, "height": 30},
    "strokes": [{"points": [
        {"x": 429, "y": 301}, {"x": 1000, "y": 301}, {"x": 1604, "y": 301},
    ]}],
}
MARKED_LINE = "PS D:\\Desktop> npm run sync"


class _ContainerNameAdapter:

    name = "uia_text_selection"

    def read_context(self, window, **_kwargs):
        left, top, right, bottom = window["bbox"]
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="application",
            window=window,
            content="C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            label="Windows PowerShell",
            method="uia:region-elements",
            artifacts={
                "perception_result_kind": "region_elements",
                "region_elements": [{
                    "text": "Windows PowerShell",
                    "rect": [left + 2, top + 81, right - left - 198, bottom - top - 279],
                }],
                "selection_rectangles": [
                    [left + 2, top + 81, right - left - 198, bottom - top - 279]
                ],
                "selection_rectangles_format": "xywh",
                "selection_rectangles_coordinate_space": "physical_screen_pixels",
            },
        )


class _ExactLineAdapter:
    name = "uia_text_selection"

    def read_context(self, window, **_kwargs):
        return AdapterReadContext(
            adapter="uia_text_selection",
            app="application",
            window=window,
            content=MARKED_LINE,
            label="line",
            method="uia:text-pattern.selection",
            artifacts={
                "perception_result_kind": "region_elements",
                "region_elements": [{"text": MARKED_LINE, "rect": [429, 288, 1175, 26]}],
                "selection_rectangles": [[429, 288, 1175, 26]],
                "selection_rectangles_format": "xywh",
                "selection_rectangles_coordinate_space": "physical_screen_pixels",
            },
        )


class _Registry:
    def __init__(self, adapter: Any) -> None:
        self.adapter = adapter

    def matching_adapter(self, _window):
        return self.adapter


def _lease(tmp_path: Path, size=(2800, 1700)) -> dict[str, Any]:
    artifact = tmp_path / "frozen.png"
    Image.new("RGB", size, "white").save(artifact)
    return {
        "schemaVersion": 1,
        "frameLeaseId": "frame-console",
        "epochId": "epoch-console",
        "capturedAtMonotonicMs": 1000.0,
        "capturedAtUtc": "2026-08-18T00:00:00.000Z",
        "source": "gdi-fallback",
        "targetWindow": {
            "hwnd": CONSOLE["hwnd"],
            "processId": CONSOLE["pid"],
            "processName": CONSOLE["process_name"],
            "title": CONSOLE["title"],
        },
        "surfaceBoundsPx": [0, 0, size[0], size[1]],
        "displayId": "display-1",
        "scaleFactor": 1,
        "gesture": UNDERLINE,
        "localArtifact": {
            "path": str(artifact),
            "mimeType": "image/png",
            "width": size[0],
            "height": size[1],
        },
        "contentHash": "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest(),
        "overlayExcluded": True,
        "captureLatencyMs": 5.0,
    }


def _snapshot(tmp_path: Path, adapter: Any) -> dict[str, Any]:
    payload = capture_snapshot(
        [dict(CONSOLE)],
        registry=_Registry(adapter),
        target_point={"x": 1604, "y": 301},
        gesture=UNDERLINE,
        visual_capture=lambda *, bbox, all_screens: Image.new(
            "RGB", (bbox[2] - bbox[0], bbox[3] - bbox[1]), "white"
        ),
        global_capture_bbox=(0, 0, 2800, 1700),
        capture_dir=tmp_path,
        frame_lease=_lease(tmp_path),
    )
    return payload["selectionSnapshot"]


def _second_stage_context(snapshot: dict[str, Any]) -> AdapterReadContext | None:
    data = snapshot.get("context")
    return AdapterReadContext.from_dict(data) if isinstance(data, dict) else None


def _ocr(monkeypatch, blocks: list[dict[str, Any]]) -> list[str]:
    calls: list[str] = []

    def read(path, *, strokes_local=None, selection_local=None):
        calls.append(str(path))
        return list(blocks), "test-ocr"

    monkeypatch.setattr(pixel_ocr, "read_ocr_blocks", read)
    return calls


def test_a_container_name_from_the_first_stage_is_superseded_not_erased(
    monkeypatch, tmp_path
) -> None:
    snapshot = _snapshot(tmp_path, _ContainerNameAdapter())
    assert snapshot["structured_covers_mark"] is False
    structured = [
        item for item in snapshot["perception_trace"]["observations"]
        if item["layer"] == "uia"
    ]
    assert structured, "the first stage must record its own observation"

    calls = _ocr(monkeypatch, [
        {"text": "an earlier line", "rect": [429, 240, 900, 26], "conf": 0.9},
        {"text": MARKED_LINE, "rect": [429, 290, 1175, 26], "conf": 0.97},
    ])
    context, trace = _fuse_pixel_tier(
        dict(CONSOLE),
        _second_stage_context(snapshot),
        snapshot,
    )

    assert len(calls) == 1, "the pixel tier reads the frozen frame exactly once"
    assert context is not None
    assert context.content == MARKED_LINE
    assert context.adapter == "local_ocr"
    kept = {item["layer"]: item for item in trace["observations"]}
    assert kept["uia"]["coversMark"] is False
    assert kept["uia"]["coverageReason"] == "identity_only"
    assert kept["ocr"]["coversMark"] is True
    assert trace["conflicts"] == []
    assert [item["kind"] for item in trace["notes"]] == ["structured_superseded"]
    assert trace["selectedTier"] == "pixel"
    assert trace["fallbackReason"] == "structured_container_only"


def test_a_structured_read_of_the_marked_line_spends_no_ocr(monkeypatch, tmp_path) -> None:
    snapshot = _snapshot(tmp_path, _ExactLineAdapter())
    assert snapshot["structured_covers_mark"] is True

    calls = _ocr(monkeypatch, [{"text": "never read", "rect": [429, 290, 1175, 26]}])
    context, trace = _fuse_pixel_tier(
        dict(CONSOLE),
        _second_stage_context(snapshot),
        snapshot,
    )

    assert calls == []
    assert context is not None and context.content == MARKED_LINE
    assert trace["selectedTier"] == "structured"
    assert trace["pixelFallbackUsed"] is False


def test_without_a_capture_the_pixel_tier_reports_unsupported_and_reads_nothing(
    monkeypatch, tmp_path
) -> None:
    snapshot = _snapshot(tmp_path, _ContainerNameAdapter())
    snapshot["capture_path"] = None

    calls = _ocr(monkeypatch, [{"text": "live screen", "rect": [429, 290, 1175, 26]}])
    context, trace = _fuse_pixel_tier(
        dict(CONSOLE),
        _second_stage_context(snapshot),
        snapshot,
    )

    assert calls == []
    assert context is not None and context.content == ""
    pixel = [item for item in trace["observations"] if item["layer"] == "ocr"]
    assert [item["status"] for item in pixel] == ["unsupported"]
    assert [item["reason"] for item in pixel] == ["frozen_pixels_unavailable"]
    assert trace["readState"] == "unavailable"


@pytest.mark.parametrize(("other_amount", "record_key"), [
    ("1200", "conflicts"),
    ("120", "corroborations"),
])
def test_structured_evidence_relations_survive_the_answer_process(
    monkeypatch, other_amount, record_key,
) -> None:
    class AmountAdapter(_ExactLineAdapter):
        def __init__(self, name: str, amount: str) -> None:
            self.name = name
            self.amount = amount

        def read_context(self, window, **kwargs):
            return replace(
                super().read_context(window, **kwargs),
                adapter=self.name,
                content=f"金额{self.amount}",
            )

    class AmountRegistry:
        def matching_adapters(self, _window):
            return [AmountAdapter("dom", "120"), AmountAdapter("uia", other_amount)]

    initial = resolve_structured_perception(
        dict(CONSOLE), AmountRegistry(), mark_bbox=(429, 286, 1175, 30),
    )
    assert initial.trace[record_key], "the first stage must establish the relation"
    snapshot = {
        "snapshot_id": "numeric-evidence",
        "perception_trace": initial.trace,
        "context": initial.context.to_dict(),
        "selection_gesture": UNDERLINE,
        "frame_lease": {"frameLeaseId": "frame-console"},
    }
    calls = _ocr(monkeypatch, [])

    context, trace = _fuse_pixel_tier(
        dict(CONSOLE), _second_stage_context(snapshot), snapshot,
    )

    assert calls == []
    assert trace[record_key] == initial.trace[record_key]
    if record_key == "conflicts":
        artifact = compile_input_artifact(
            "这笔金额多少", dict(CONSOLE), context,
            {**snapshot, "perception_trace": trace},
        )
        assert artifact.to_model_dict()["conflicts"]
        assert artifact.display.needs_confirmation is True
