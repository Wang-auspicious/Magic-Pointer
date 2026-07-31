from __future__ import annotations

from PIL import Image, ImageDraw

from app.adapters.pdf_selection_recovery import (
    context_from_blocks,
    extend_highlight_rectangles,
    recover_local_pdf_selection,
    recovery_is_consistent,
    selected_text_from_rawdict,
)


def _chars(text: str, *, x: int, y: int, width: int = 10) -> list[dict[str, object]]:
    return [
        {
            "c": character,
            "bbox": [x + (index * width), y, x + ((index + 1) * width), y + 20],
        }
        for index, character in enumerate(text)
    ]


def test_highlight_extension_recovers_missing_prefix_and_drops_phantom_suffix() -> None:
    image = Image.new("RGB", (300, 120), "white")
    draw = ImageDraw.Draw(image)
    highlight = (153, 193, 218)
    draw.rectangle((20, 20, 239, 49), fill=highlight)

    rectangles = extend_highlight_rectangles(
        image,
        [[40, 20, 200, 30], [10, 50, 15, 30]],
        [0, 0, 300, 120],
    )

    assert rectangles == [
        (20.0, 20.0, 220.0, 30.0),
    ]


def test_highlight_extension_supports_negative_virtual_screen_coordinates() -> None:
    image = Image.new("RGB", (300, 120), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, 239, 49), fill=(153, 193, 218))

    rectangles = extend_highlight_rectangles(
        image,
        [[-60, -30, 200, 30]],
        [-100, -50, 300, 120],
        origin=(-100, -50),
    )

    assert rectangles == [(-80.0, -30.0, 220.0, 30.0)]


def test_solid_occluding_window_is_not_mistaken_for_a_highlight() -> None:
    image = Image.new("RGB", (300, 120), (32, 32, 32))

    rectangles = extend_highlight_rectangles(
        image,
        [[40, 20, 200, 30]],
        [0, 0, 300, 120],
    )

    assert rectangles == []


def test_pdf_character_geometry_recovers_exact_selection_and_context() -> None:
    rawdict = {
        "blocks": [{
            "type": 0,
            "lines": [
                {"spans": [{"chars": _chars("A multi-task", x=20, y=20)}]},
                {"spans": [{"chars": _chars("plaque", x=10, y=50)}]},
            ],
        }],
    }
    selection = [(20.0, 20.0, 120.0, 20.0), (10.0, 50.0, 10.0, 20.0)]
    text = selected_text_from_rawdict(rawdict, selection)
    context = context_from_blocks(
        [(10, 20, 140, 70, "A multi-task\nplaque", 0, 0)],
        selection,
    )

    assert text == "A multi-task\np"
    assert context == "A multi-task\nplaque"
    assert recovery_is_consistent("multi-task p", text, context) is True
    assert recovery_is_consistent("different text", text, context) is False


def test_boundary_only_uia_errors_are_allowed_but_internal_changes_are_not() -> None:
    recovered = "A multi-task learning framework for carotid"
    context = recovered + "\nplaque segmentation and classification"

    assert recovery_is_consistent(
        "multi-task learning framework for carotid p",
        recovered,
        context,
    ) is True
    assert recovery_is_consistent(
        "multi-task learning changed for carotid",
        recovered,
        context,
    ) is False


def test_real_pdf_screenshot_replay_recovers_visible_title_only() -> None:
    image_path = (
        __import__("pathlib").Path(__file__).resolve().parents[1]
        / "data"
        / "runtime"
        / "pdf_selection_aware_panel_v3_real_20260710_210615.png"
    )
    pdf_path = (
        __import__("pathlib").Path(__file__).resolve().parents[1]
        / "2307.00583v1.pdf"
    )
    if not image_path.is_file() or not pdf_path.is_file():
        return

    result = recover_local_pdf_selection(
        {
            "document_location": str(pdf_path),
            "page_number": 1,
            "page_selector_number": 1,
            "page_ancestor_number": 1,
            "page_rect": [42, 352, 1632, 2112],
            "rectangles": [[322, 528, 1133, 74], [237, 602, 35, 75]],
            "text": "multi-task learning framework for carotid p",
            "range_count": 1,
        },
        screen_capture=(Image.open(image_path).convert("RGB"), (0, 0)),
    )

    assert result.ok is True
    assert result.text == "A multi-task learning framework for carotid"
    assert result.context.startswith(
        "A multi-task learning framework for carotid\n"
        "plaque segmentation and classification from"
    )
    assert result.dropped_uia_rectangle_count == 1


def test_conflicting_toolbar_and_ancestor_pages_fail_closed() -> None:
    pdf_path = (
        __import__("pathlib").Path(__file__).resolve().parents[1]
        / "2307.00583v1.pdf"
    )
    if not pdf_path.is_file():
        return

    result = recover_local_pdf_selection({
        "document_location": str(pdf_path),
        "page_number": 1,
        "page_selector_number": 2,
        "page_ancestor_number": 1,
        "page_rect": [42, 352, 1632, 2112],
        "rectangles": [[322, 528, 1133, 74]],
        "text": "multi-task learning framework for carotid",
        "range_count": 1,
    })

    assert result.ok is False
    assert "page and selected page geometry disagreed" in str(result.error)


def test_live_recovery_rejects_an_occluded_background_pdf(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.adapters.pdf_selection_recovery._foreground_window_handle",
        lambda: 999,
    )
    pdf_path = __import__("pathlib").Path(__file__).resolve().parents[1] / "2307.00583v1.pdf"
    if not pdf_path.is_file():
        return
    result = recover_local_pdf_selection({
        "hwnd": 123,
        "document_location": __file__.replace(
            "tests\\pdf_selection_recovery_test.py",
            "2307.00583v1.pdf",
        ),
        "page_number": 1,
        "page_rect": [0, 0, 612, 792],
        "rectangles": [[10, 10, 100, 20]],
        "text": "selection",
        "range_count": 1,
    })

    assert result.ok is False
    assert "not foreground" in str(result.error)
