from __future__ import annotations

from pathlib import Path

from PIL import Image

from app import screen_context


def test_screen_context_excludes_magic_pointer_surfaces_before_occlusion(
    tmp_path: Path,
    monkeypatch,
) -> None:
    image_path = tmp_path / "capture.png"
    Image.new("RGB", (400, 300), "white").save(image_path)
    monkeypatch.setattr(
        screen_context,
        "list_visible_windows",
        lambda: [
            {
                "hwnd": 10,
                "z_order": 1,
                "title": "Magic Pointer Overlay",
                "class_name": "Chrome_WidgetWin_1",
                "pid": 100,
                "bbox": (0, 0, 400, 300),
            },
            {
                "hwnd": 20,
                "z_order": 2,
                "title": "Checkout failure - Google Chrome",
                "class_name": "Chrome_WidgetWin_1",
                "pid": 200,
                "bbox": (0, 0, 400, 300),
            },
        ],
    )

    context = screen_context.build_screen_context((100, 80, 260, 200), image_path)

    assert [window.title for window in context.windows] == ["Checkout failure - Google Chrome"]
    assert context.windows[0].estimated_visible_selection_coverage == 1.0
