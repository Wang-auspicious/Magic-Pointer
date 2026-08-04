"""[POINT] 指点动作：让回答一边解释一边指着屏幕。

「你要的按钮在右上角」是个差答案；一支箭头落在那个按钮上不是。

两条不能破的规矩：
1. **标记必须离开正文。** 用户复制走、读出来、粘进文档的必须是一句话，不是带坐标的一句话。
2. **信不过的坐标不画。** 模型会瞎编坐标；一支自信地指向空白桌面的箭头，比没有箭头糟得多。
"""

from __future__ import annotations

from app.text_actions.point_markers import MAX_POINTS, instruction_for_model, parse_points

SCREEN = [0, 0, 3120, 2080]


def test_a_marker_becomes_an_arrow_and_leaves_the_sentence() -> None:
    text, points = parse_points("先点 [POINT 1840,220] 这个齿轮。", bounds=SCREEN)
    assert text == "先点 这个齿轮。"
    assert [(p.x, p.y, p.order) for p in points] == [(1840, 220, 1)]


def test_several_points_are_numbered_in_reading_order() -> None:
    text, points = parse_points(
        "先点 [POINT 100,100] 这里，再选 [POINT 200,300] 那里。",
        bounds=SCREEN,
    )
    assert [p.order for p in points] == [1, 2]
    assert [(p.x, p.y) for p in points] == [(100, 100), (200, 300)]
    assert "POINT" not in text


def test_punctuation_variants_are_all_accepted() -> None:
    for marker in ("[POINT 10,20]", "[POINT: 10, 20]", "[point 10 20]", "[ POINT  10 , 20 ]"):
        _text, points = parse_points(f"看这里{marker}。", bounds=SCREEN)
        assert [(p.x, p.y) for p in points] == [(10, 20)], marker


def test_a_point_outside_the_screen_is_dropped_but_the_marker_still_goes() -> None:
    """指向空白桌面的箭头比没有箭头糟糕；但把 [POINT] 留在正文里更糟。"""
    text, points = parse_points("看这里 [POINT 99999,99999]。", bounds=SCREEN)
    assert points == []
    assert "POINT" not in text
    assert text == "看这里。"


def test_negative_coordinates_are_allowed_on_a_multi_monitor_desktop() -> None:
    _text, points = parse_points("[POINT -800,300]", bounds=[-1920, 0, 3120, 2080])
    assert [(p.x, p.y) for p in points] == [(-800, 300)]


def test_without_bounds_nothing_is_dropped() -> None:
    """不是每条路径都知道屏幕范围；不知道时不假装能校验。"""
    _text, points = parse_points("[POINT 99999,99999]")
    assert len(points) == 1


def test_the_number_of_arrows_is_bounded() -> None:
    markers = " ".join(f"[POINT {index * 10},{index * 10}]" for index in range(MAX_POINTS + 5))
    _text, points = parse_points(markers, bounds=SCREEN)
    assert len(points) == MAX_POINTS


def test_an_answer_with_no_markers_is_returned_unchanged() -> None:
    text, points = parse_points("这是一个普通回答。", bounds=SCREEN)
    assert text == "这是一个普通回答。"
    assert points == []


def test_spacing_left_behind_by_a_removed_marker_is_tidied() -> None:
    text, _ = parse_points("点这个 [POINT 10,20] ，然后确认。", bounds=SCREEN)
    assert "  " not in text
    assert text == "点这个，然后确认。"


def test_line_structure_is_preserved() -> None:
    text, _ = parse_points("第一步 [POINT 10,20]\n第二步 [POINT 30,40]", bounds=SCREEN)
    assert text.splitlines() == ["第一步", "第二步"]


def test_junk_input_is_safe() -> None:
    assert parse_points("") == ("", [])
    assert parse_points(None) == ("", [])
    assert parse_points("[POINT abc,def]", bounds=SCREEN)[1] == []
    # 畸形 bounds 视为没有 bounds，而不是全部丢弃。
    assert len(parse_points("[POINT 10,20]", bounds="nonsense")[1]) == 1
    assert len(parse_points("[POINT 10,20]", bounds=[5, 5, 1, 1])[1]) == 1


def test_the_model_is_told_where_it_may_point() -> None:
    line = instruction_for_model(SCREEN)
    assert "[POINT x,y]" in line
    assert "3120" in line
    # 而且被明确告知：拿不准就别指。
    assert "不确定" in line


def test_the_instruction_survives_missing_bounds() -> None:
    assert "[POINT x,y]" in instruction_for_model(None)
