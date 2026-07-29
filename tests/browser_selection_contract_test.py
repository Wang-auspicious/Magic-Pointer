from __future__ import annotations

import hashlib

import pytest

from app.adapters.browser_devtools_adapter import BrowserDevToolsAdapter, ChromeDevToolsProbe, DevToolsProbeResult


def _window() -> dict[str, object]:
    return {
        "hwnd": 42,
        "pid": 314,
        "class_name": "Chrome_WidgetWin_1",
        "title": "Example - Microsoft Edge",
        "bbox": [100, 200, 1300, 1000],
    }


def _dom_context() -> dict:
    return {
        "schemaVersion": 1,
        "state": "resolved",
        "method": "cdp:dom-point",
        "page": {"title": "Example", "url": "https://example.test/article"},
        "node": {
            "tag": "button",
            "id": "pointer-node",
            "classes": [],
            "role": "button",
            "accessibleName": "Pointer node",
            "text": "Pointer DOM text",
            "attributes": {},
        },
        "selector": "#pointer-node",
        "coordinates": {
            "pointerScreenPhysical": {"x": 640, "y": 520},
            "pointerViewportCss": {"x": 524, "y": 241},
            "elementViewportCss": {"x": 500, "y": 220, "width": 120, "height": 44},
            "elementScreenPhysical": {"x": 616, "y": 499, "width": 120, "height": 44},
            "devicePixelRatio": 1,
        },
        "networkFailures": [],
        "provenance": {"endpoint": "http://127.0.0.1:9222", "targetId": "page-1", "structural": True},
        "componentHints": {"framework": "unknown", "owners": []},
        "selection_rectangles_coordinate_space": "physical_screen_pixels",
        "uncertainty": [],
    }


def _adapter(raw: dict) -> BrowserDevToolsAdapter:
    return BrowserDevToolsAdapter(probe=lambda *_args: DevToolsProbeResult(True, raw))


def test_browser_selection_uses_only_a_noncollapsed_range_hit_at_the_pointer() -> None:
    raw = _dom_context()
    raw["selection"] = {
        "state": "valid",
        "nonCollapsed": True,
        "text": "Only this highlighted sentence.",
        "rectangles": [{"x": 610, "y": 500, "width": 80, "height": 24}],
    }

    ctx = _adapter(raw).read_context(_window(), target_point={"x": 640, "y": 520})

    assert ctx.content == "Only this highlighted sentence."
    assert ctx.label == "Browser selection"
    assert ctx.artifacts["selection_rectangles"] == [[610, 500, 80, 24]]
    assert ctx.artifacts["selection_rectangles_coordinate_space"] == "physical_screen_pixels"
    assert ctx.artifacts["selection_rectangles_format"] == "xywh"
    assert ctx.artifacts["selection_text_chars"] == len(ctx.content)
    assert ctx.artifacts["selection_text_sha256"] == hashlib.sha256(ctx.content.encode()).hexdigest()


@pytest.mark.parametrize(
    "selection",
    [
        {"state": "valid", "nonCollapsed": False, "text": "stale", "rectangles": [{"x": 610, "y": 500, "width": 80, "height": 24}]},
        {"state": "valid", "nonCollapsed": True, "text": "   ", "rectangles": [{"x": 610, "y": 500, "width": 80, "height": 24}]},
        {"state": "valid", "nonCollapsed": True, "text": "wrong location", "rectangles": [{"x": 700, "y": 500, "width": 80, "height": 24}]},
    ],
)
def test_browser_selection_falls_back_to_the_pointer_dom_node_when_not_trusted(selection: dict) -> None:
    raw = _dom_context()
    raw["selection"] = selection

    ctx = _adapter(raw).read_context(_window(), target_point={"x": 640, "y": 520})

    assert ctx.content == "Pointer DOM text"
    assert ctx.label == "Pointer node"
    assert ctx.artifacts["selection_rectangles"] == [[616, 499, 120, 44]]
    assert "selection_text_chars" not in ctx.artifacts


@pytest.mark.parametrize(
    "selection",
    [
        {"state": "valid", "nonCollapsed": True, "text": "x" * 4001, "rectangles": [{"x": 610, "y": 500, "width": 80, "height": 24}]},
        {"state": "valid", "nonCollapsed": True, "text": "too many rectangles", "rectangles": [{"x": 610, "y": 500, "width": 1, "height": 1}] * 33},
        {"state": "valid", "nonCollapsed": True, "text": "huge rectangle", "rectangles": [{"x": 610, "y": 500, "width": 10001, "height": 24}]},
    ],
)
def test_browser_selection_rejects_oversized_text_or_rectangles(selection: dict) -> None:
    raw = _dom_context()
    raw["selection"] = selection

    ctx = _adapter(raw).read_context(_window(), target_point={"x": 640, "y": 520})

    assert ctx.content == "Pointer DOM text"
    assert ctx.artifacts["selection_rectangles"] == [[616, 499, 120, 44]]


def test_browser_selection_requires_a_physical_screen_coordinate_declaration() -> None:
    raw = _dom_context()
    raw.pop("selection_rectangles_coordinate_space")
    raw["selection"] = {
        "state": "valid",
        "nonCollapsed": True,
        "text": "Selection with unknown coordinates",
        "rectangles": [{"x": 610, "y": 500, "width": 80, "height": 24}],
    }

    ctx = _adapter(raw).read_context(_window(), target_point={"x": 640, "y": 520})

    assert ctx.content == "Pointer DOM text"


def test_single_debug_target_never_overrides_a_different_foreground_page() -> None:
    probe = ChromeDevToolsProbe(endpoints=[])
    target = ("http://127.0.0.1:9222", {"title": "Debug Fixture", "url": "https://wrong.test"})

    assert probe._select_target([target], "Bank Account - Microsoft Edge") is None
    assert probe._select_target([target], "Debug Fixture - Microsoft Edge") == target
