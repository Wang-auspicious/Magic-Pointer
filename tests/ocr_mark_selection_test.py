from app.grounding.ocr_mark_selection import select_open_stroke_rect_indexes


def test_underline_prefers_the_nearest_text_row_above_the_mark() -> None:
    rectangles = [
        [32, 18, 552, 30],
        [32, 58, 800, 30],
        [32, 98, 810, 30],
    ]
    stroke = [(32, 90), (780, 90)]

    assert select_open_stroke_rect_indexes(rectangles, stroke) == [1]


def test_strikethrough_selects_the_row_it_actually_crosses() -> None:
    rectangles = [[32, 58, 800, 30], [32, 98, 810, 30]]

    assert select_open_stroke_rect_indexes(rectangles, [(32, 114), (780, 114)]) == [1]


def test_wide_ocr_slices_on_the_same_row_are_kept_together() -> None:
    rectangles = [
        [32, 58, 500, 30],
        [492, 59, 350, 29],
        [32, 98, 810, 30],
    ]

    assert select_open_stroke_rect_indexes(rectangles, [(32, 90), (840, 90)]) == [0, 1]


def test_same_row_fragments_survive_even_when_one_box_contains_the_stroke_more_deeply() -> None:
    rectangles = [[30, 54, 292, 36], [316, 54, 526, 40], [32, 98, 810, 30]]

    assert select_open_stroke_rect_indexes(rectangles, [(32, 90), (780, 90)]) == [0, 1]


def test_distant_rows_are_not_selected_by_a_generous_tolerance() -> None:
    rectangles = [[32, 20, 500, 26], [32, 120, 500, 26]]

    assert select_open_stroke_rect_indexes(rectangles, [(32, 80), (530, 80)]) == []
