
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from app.visual_annotation import make_pointer_annotated_image  # noqa: E402

SURFACE = (0, 0, 800, 600)
FIRST = [(60, 60), (200, 60)]
SECOND = [(560, 500), (700, 500)]
BETWEEN = (380, 280, 420, 320)


def _blank(path: Path) -> Path:
    Image.new("RGB", (SURFACE[2], SURFACE[3]), "white").save(path)
    return path


def _changed_box(annotated: Path, box: tuple[int, int, int, int]) -> bool:
    with Image.open(annotated).convert("RGB") as image:
        region = image.crop(box)
        return any(pixel != (255, 255, 255) for pixel in region.getdata())


def _render(tmp_path: Path, name: str, **kwargs) -> Path:
    raw = _blank(tmp_path / f"{name}-raw.png")
    out = tmp_path / f"{name}.png"
    make_pointer_annotated_image(raw, out, SURFACE, kwargs.pop("points", []), **kwargs)
    return out


def test_no_points_and_no_polylines_writes_a_copy(tmp_path) -> None:
    raw = _blank(tmp_path / "raw.png")
    out = tmp_path / "copy.png"
    make_pointer_annotated_image(raw, out, SURFACE, [])
    assert out.is_file()
    with Image.open(out) as image:
        assert image.size == (SURFACE[2], SURFACE[3])


def test_the_single_stroke_path_still_tags_the_mark_this(tmp_path) -> None:
    out = _render(tmp_path, "single", points=list(FIRST), style="locator")
    assert _changed_box(out, (40, 20, 240, 100))


def test_each_stroke_is_drawn_where_it_was_drawn(tmp_path) -> None:
    out = _render(
        tmp_path, "two",
        points=FIRST + SECOND, style="locator",
        stroke_polylines=[FIRST, SECOND],
    )
    assert _changed_box(out, (40, 20, 240, 100))
    assert _changed_box(out, (540, 460, 740, 540))


def test_two_strokes_do_not_get_one_box_around_both(tmp_path) -> None:
    out = _render(
        tmp_path, "no-union-box",
        points=FIRST + SECOND, style="locator",
        stroke_polylines=[FIRST, SECOND],
    )
    assert not _changed_box(out, BETWEEN), "两笔之间被画上了包围全部笔迹的大框"


def test_a_stroke_with_no_points_does_not_shift_the_later_tags(tmp_path) -> None:
    both = _render(
        tmp_path, "both",
        points=FIRST + SECOND, style="locator",
        stroke_polylines=[FIRST, SECOND],
    )
    hollow_first = _render(
        tmp_path, "hollow",
        points=list(SECOND), style="locator",
        stroke_polylines=[[], SECOND],
    )
    tag = (540, 456, 600, 480)
    with Image.open(both).convert("RGB") as left, Image.open(hollow_first).convert("RGB") as right:
        assert left.crop(tag).tobytes() == right.crop(tag).tobytes()
    assert not _changed_box(hollow_first, (40, 20, 240, 100))


def test_the_pointer_style_is_untouched_by_polylines(tmp_path) -> None:
    raw = _blank(tmp_path / "raw.png")
    out = tmp_path / "pointer.png"
    make_pointer_annotated_image(
        raw, out, SURFACE, [], stroke_polylines=[[], []], style="pointer",
    )
    assert out.is_file()
