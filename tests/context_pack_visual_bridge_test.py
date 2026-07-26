from __future__ import annotations

from pathlib import Path

from app.context_pack.intent import ContextIntentKind, parse_context_intent
from app.context_pack.session import ContextSessionStore
from scripts.electron_bridge import _prompt_for, _visual_context_capture


def test_visual_collect_command_sends_only_the_explanation_to_vision_model() -> None:
    assert _prompt_for({"command": "收集：这是红色报错卡片"}) == "这是红色报错卡片"
    assert _prompt_for({"command": "context: compare this state"}) == "compare this state"
    assert _prompt_for({"command": "解释这个按钮"}) == "解释这个按钮"


def test_visual_capture_preserves_images_geometry_grounding_and_source(tmp_path: Path) -> None:
    capture = _visual_context_capture(
        object_id="object-1",
        payload={"sourceApp": "Chrome", "screenBounds": {"x": 0, "y": 0, "width": 1920, "height": 1080}},
        selection_point=(420, 260),
        selection_bbox=(400, 240, 580, 330),
        capture_bbox=(0, 0, 900, 500),
        image_path=Path(r"D:\tmp\raw.png"),
        pointer_image_path=Path(r"D:\tmp\pointer.png"),
        windows=[{
            "title": "Broken checkout - Chrome",
            "hwnd": 201,
            "pid": 202,
            "class_name": "Chrome_WidgetWin_1",
            "bbox": [0, 0, 1200, 800],
        }],
        grounding={"grounding": {"primary_object_id": "row-1"}, "proposals": []},
        local_file_context={"path": r"D:\repo\checkout.html", "method": "html:bs4", "text": "Payment failed"},
        app_adapter_context={"app": "browser", "artifacts": {"url": "https://example.test/checkout"}},
        vision_observation="A red Payment failed card is visible.",
        vision_error="",
    )

    assert capture["object_id"] == "object-1"
    assert capture["source_window"]["process_id"] == 202
    assert capture["source_window"]["process_name"] == "Chrome"
    assert capture["point"] == [420, 260]
    assert capture["bbox"] == [400, 240, 580, 330]
    assert capture["capture_bbox"] == [0, 0, 900, 500]
    assert capture["raw_image_path"] == str(Path(r"D:\tmp\raw.png"))
    assert capture["grounding"]["grounding"]["primary_object_id"] == "row-1"
    assert capture["file_context"]["path"] == r"D:\repo\checkout.html"
    assert capture["app_context"]["artifacts"]["url"] == "https://example.test/checkout"
    assert capture["vision_observation"].startswith("A red")
    assert capture["source_confidence"] == "point_hit"


def test_visual_capture_does_not_guess_source_window_when_point_hits_none(tmp_path: Path) -> None:
    capture = _visual_context_capture(
        object_id="object-outside",
        payload={},
        selection_point=(1400, 900),
        selection_bbox=(1390, 890, 1420, 920),
        capture_bbox=(1300, 800, 1500, 1000),
        image_path=tmp_path / "raw.png",
        pointer_image_path=tmp_path / "pointer.png",
        windows=[{"title": "Other window", "hwnd": 1, "pid": 2, "bbox": [0, 0, 800, 600]}],
        grounding={},
        local_file_context=None,
        app_adapter_context=None,
        vision_observation="",
        vision_error="",
    )

    assert capture["source_window"] == {}
    assert capture["source_confidence"] == "unknown"


def test_visual_capture_with_failed_vision_is_still_recordable(tmp_path: Path) -> None:
    capture = _visual_context_capture(
        object_id="object-2",
        payload={"sourceApp": "Design app"},
        selection_point=(12, 34),
        selection_bbox=(10, 30, 80, 90),
        capture_bbox=(0, 0, 200, 200),
        image_path=tmp_path / "raw.png",
        pointer_image_path=tmp_path / "pointer.png",
        windows=[],
        grounding={},
        local_file_context=None,
        app_adapter_context=None,
        vision_observation="",
        vision_error="TimeoutError: vision unavailable",
    )
    store = ContextSessionStore(root=tmp_path, id_factory=iter(["context-1", "item-1"]).__next__)

    recorded = store.record_visual(capture, "这个状态需要交给纯文本模型")

    assert recorded["recorded"] is True
    assert recorded["item"]["vision_observation"] == ""
    assert recorded["item"]["vision_error"] == "TimeoutError: vision unavailable"
    assert recorded["item"]["images"]["raw"].endswith("raw.png")
    assert recorded["item"]["geometry"]["point"] == [12, 34]


def test_collect_intent_is_explicit_before_visual_capture() -> None:
    intent = parse_context_intent("收集：这个图标代表失败")

    assert intent is not None
    assert intent.kind == ContextIntentKind.COLLECT
