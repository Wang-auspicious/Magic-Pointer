from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.ocr_resident_worker import (
    _select_boxes,
    _split_wide_box,
    _stroke_is_closed,
    boxes_to_xywh,
)


def test_split_wide_box_slices_into_overlapping_chunks() -> None:
    box = [[0.0, 0.0], [1200.0, 0.0], [1200.0, 40.0], [0.0, 40.0]]
    parts = _split_wide_box(box, max_width=520.0, overlap=40.0)
    assert len(parts) >= 3
    widths = [round(max(p[0] for p in part) - min(p[0] for p in part)) for part in parts]
    assert all(width <= 520 for width in widths)
    # chunks overlap and together cover the full line
    assert parts[0][1][0] == 520.0
    assert parts[-1][0][0] < 1200.0 and parts[-1][1][0] == 1200.0


def test_split_wide_box_keeps_narrow_box_untouched() -> None:
    box = [[10.0, 0.0], [300.0, 0.0], [300.0, 40.0], [10.0, 40.0]]
    assert _split_wide_box(box) == [box]


def test_stroke_is_closed_detects_loop_with_short_tail() -> None:
    loop = [[0, 0], [100, 0], [100, 50], [0, 50], [2, 1]]
    assert _stroke_is_closed(loop) is True
    open_line = [[0, 0], [100, 5], [200, 10]]
    assert _stroke_is_closed(open_line) is False


def test_select_boxes_loop_collects_inside_not_outside() -> None:
    boxes = [
        [[100.0, 100.0], [300.0, 100.0], [300.0, 130.0], [100.0, 130.0]],   # inside
        [[100.0, 200.0], [300.0, 200.0], [300.0, 230.0], [100.0, 230.0]],   # inside
        [[900.0, 900.0], [1100.0, 900.0], [1100.0, 930.0], [900.0, 930.0]], # outside
    ]
    loop = [[90, 90], [350, 92], [352, 240], [88, 238], [90, 90]]
    kept = _select_boxes(boxes, [loop], None)
    assert len(kept) == 2
    assert boxes_to_xywh(kept[0])[0] == 100
    assert boxes_to_xywh(kept[1])[1] == 200


def test_select_boxes_open_stroke_keeps_only_crossed() -> None:
    boxes = [
        [[100.0, 100.0], [300.0, 100.0], [300.0, 130.0], [100.0, 130.0]],
        [[100.0, 400.0], [300.0, 400.0], [300.0, 430.0], [100.0, 430.0]],
    ]
    line = [[0, 110], [200, 108], [500, 110]]
    kept = _select_boxes(boxes, [line], None)
    assert len(kept) == 1
    assert boxes_to_xywh(kept[0])[1] == 100
