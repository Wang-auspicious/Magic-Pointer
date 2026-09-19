"""标注图上的笔迹必须和材料对得上号。

一次手势可以有好几笔，材料是一个笔画一份（`_capture_stroke_materials` 用
`enumerate` 发 `stroke_index`，`_initial_task_context` 再把第 index 笔命名为
`chr(ord("A") + index)`）。图上标错一个字母，模型就会拿着一处像素去说另一处
对象——而且说得非常自信，因为图和材料各自看都是对的。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from app.visual_annotation import make_pointer_annotated_image  # noqa: E402

SURFACE = (0, 0, 800, 600)
# 两笔离得足够远，任何「罩住全部笔迹」的大框都会横穿中间那块空地。
FIRST = [(60, 60), (200, 60)]
SECOND = [(560, 500), (700, 500)]
# 中间这块地在两笔的包围盒之内，但离每一条线都很远。
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
    """老调用方（`points=` + `locator`）逐像素不变形。"""
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
    """跨窗口的一次手势会让包围框罩住整屏，框本身就是噪声。"""
    out = _render(
        tmp_path, "no-union-box",
        points=FIRST + SECOND, style="locator",
        stroke_polylines=[FIRST, SECOND],
    )
    assert not _changed_box(out, BETWEEN), "两笔之间被画上了包围全部笔迹的大框"


def test_a_stroke_with_no_points_does_not_shift_the_later_tags(tmp_path) -> None:
    """第 index 笔没点，后面每一笔的字母都不能整体前移。

    前移之后图和材料对不上，而且对不上的时候看起来完全正常——这正是最难发现
    的那一类错误。所以这里直接比对两笔各自的标签像素：把第一笔掏空，第二笔的
    标签必须和它原来一模一样。
    """
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
    # 掏空的第一笔不能留下任何痕迹。
    assert not _changed_box(hollow_first, (40, 20, 240, 100))


def test_the_pointer_style_is_untouched_by_polylines(tmp_path) -> None:
    """pointer 风格只有落点可指，多笔调用方不该把它炸掉。"""
    raw = _blank(tmp_path / "raw.png")
    out = tmp_path / "pointer.png"
    make_pointer_annotated_image(
        raw, out, SURFACE, [], stroke_polylines=[[], []], style="pointer",
    )
    assert out.is_file()
