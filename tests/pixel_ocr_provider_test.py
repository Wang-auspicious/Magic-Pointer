"""Frozen-frame OCR as a provider: same recognition, arbitrated by fusion."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image

from app.evidence.contract import EvidenceStatus
from app.perception.broker import PerceptionBroker
from app.perception.pixel_ocr import OCR_WORKER_BUSY_ENGINE, FrozenFrameOcrProvider
from app.perception.providers import PerceptionRequest

WINDOW = {
    "hwnd": 77,
    "title": "WeChat",
    "process_name": "WeChat.exe",
    "class_name": "WeChatMainWndForPC",
    "bbox": [0, 0, 1200, 900],
}


def _frozen_frame(tmp_path: Path) -> str:
    path = tmp_path / "frozen.png"
    Image.new("RGB", (1200, 900), (250, 250, 250)).save(path)
    return str(path)


def _reader(blocks: list[dict[str, Any]], engine: str = "rapidocr-onnx") -> Any:
    def read(_path: str, *, strokes_local: Any = None, selection_local: Any = None) -> Any:
        read.calls.append({"strokes": strokes_local, "selection": selection_local})
        return list(blocks), engine

    read.calls = []  # type: ignore[attr-defined]
    return read


def _request(tmp_path: Path, **overrides: Any) -> PerceptionRequest:
    values: dict[str, Any] = {
        "window": dict(WINDOW),
        "mark_bbox": (200, 500, 320, 18),
        "frame_lease_id": "frame_wechat",
        "frozen_artifact_path": _frozen_frame(tmp_path),
        "frozen_artifact_bbox": (0, 0, 1200, 900),
        "gesture": {
            "coordinateSpace": "physical_screen_pixels",
            "strokes": [{"points": [
                {"x": 200, "y": 512}, {"x": 360, "y": 512}, {"x": 520, "y": 512},
            ]}],
            "bbox": {"x": 200, "y": 500, "width": 320, "height": 18},
        },
    }
    values.update(overrides)
    return PerceptionRequest(**values)


def test_only_the_underlined_row_reaches_the_answer(tmp_path: Path) -> None:
    reader = _reader([
        {"text": "上一条消息", "rect": [200, 460, 300, 20], "conf": 0.98},
        {"text": "明天下午三点开会", "rect": [200, 502, 320, 20], "conf": 0.97},
        {"text": "下一条消息", "rect": [200, 544, 300, 20], "conf": 0.96},
    ])
    provider = FrozenFrameOcrProvider(reader=reader)

    result = PerceptionBroker().resolve(_request(tmp_path), [provider])

    assert result.context is not None
    assert result.context.content == "明天下午三点开会"
    assert result.context.adapter == "local_ocr"
    assert result.context.artifacts["ocr_block_count_total"] == 3
    assert result.context.artifacts["ocr_block_count_selected"] == 1
    assert result.context.artifacts["captured_rects"] == [[200, 502, 320, 20]]
    assert result.trace["pixelFallbackUsed"] is True
    assert result.selected is not None
    assert result.selected.covers_mark is True


def test_a_busy_worker_is_not_an_empty_screen(tmp_path: Path) -> None:
    provider = FrozenFrameOcrProvider(reader=_reader([], OCR_WORKER_BUSY_ENGINE))

    result = PerceptionBroker().resolve(_request(tmp_path), [provider])

    assert result.selected is None
    assert result.observations[0].status is EvidenceStatus.BUSY
    assert result.observations[0].reason == "ocr_worker_busy"
    assert result.trace["readState"] == "unread"


def test_recognised_text_away_from_the_mark_is_not_the_answer(tmp_path: Path) -> None:
    reader = _reader([
        {"text": "侧边栏联系人", "rect": [10, 100, 120, 20], "conf": 0.9},
    ])
    provider = FrozenFrameOcrProvider(reader=reader)

    result = PerceptionBroker().resolve(_request(tmp_path), [provider])

    assert result.selected is None
    assert result.observations[0].status is EvidenceStatus.EMPTY_CONFIRMED
    assert result.observations[0].reason == "ocr_no_text_at_mark"
    assert result.trace["readState"] == "empty_confirmed"


def test_block_geometry_is_reported_in_screen_pixels_not_artifact_pixels(
    tmp_path: Path,
) -> None:
    """A cropped artifact reads local coordinates; the stage draws screen ones."""
    reader = _reader([
        {"text": "被划中的一行", "rect": [40, 62, 320, 20], "conf": 0.95},
    ])
    provider = FrozenFrameOcrProvider(reader=reader)

    result = PerceptionBroker().resolve(
        _request(tmp_path, frozen_artifact_bbox=(160, 440, 1360, 1340)),
        [provider],
    )

    assert reader.calls[0]["strokes"] == [[(40, 72), (200, 72), (360, 72)]]
    assert reader.calls[0]["selection"] == [40, 60, 320, 18]
    assert result.context is not None
    assert result.context.artifacts["captured_rects"] == [[200, 502, 320, 20]]


def test_without_a_frozen_artifact_the_recogniser_is_never_reached(tmp_path: Path) -> None:
    """No frozen pixels means no read — never a live grab of the screen now."""
    reader = _reader([{"text": "live screen", "rect": [200, 502, 320, 20]}])
    provider = FrozenFrameOcrProvider(reader=reader)

    result = PerceptionBroker().resolve(
        _request(tmp_path, frozen_artifact_path=None),
        [provider],
    )

    assert reader.calls == []
    assert result.observations[0].status is EvidenceStatus.UNSUPPORTED
    assert result.observations[0].reason == "frozen_pixels_unavailable"
