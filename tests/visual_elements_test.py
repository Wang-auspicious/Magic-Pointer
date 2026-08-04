"""把 OCR 的一行行文字，还原成人真正会去指的那个东西。

2026-08-05 实测：微信 4.x 整个窗口只暴露 8 个 UIA 节点，聊天区是一整块没有子节点的
`MMUIRenderSubWindowHW`。所以"指着那条消息"在结构层上无解——而微信不是特例，Qt、
Flutter、GPU 合成的 Electron 全是这个形状。

我们手里有的是 OCR：一堆带矩形的文字行。但**没有人会指着"某一行"**——他指的是那个
气泡。所以这里要做的是把行重新拼回它们本来属于的对象。

合并方向上宁可保守：多框一块比少框一块糟糕得多，因为它会悄悄扩大后续动作的作用范围。
"""

from __future__ import annotations

from app.vision.visual_elements import (
    MAX_ELEMENTS,
    element_at_point,
    group_blocks_into_elements,
)

# 一个 1490×1894 的微信窗口，聊天区在右侧。
WINDOW = [626, 60, 2120, 1956]


def _block(x, y, w, h, text):
    return {"rect": [x, y, w, h], "text": text}


def test_lines_of_one_bubble_become_one_element() -> None:
    elements = group_blocks_into_elements([
        _block(860, 500, 300, 34, "今上午我不用"),
        _block(860, 540, 280, 34, "我就下午用一下"),
    ], window_bbox=WINDOW)
    assert len(elements) == 1
    assert elements[0].line_count == 2
    assert elements[0].text == "今上午我不用\n我就下午用一下"
    assert elements[0].rect == [860, 500, 300, 74]


def test_two_bubbles_far_apart_stay_two_elements() -> None:
    elements = group_blocks_into_elements([
        _block(860, 500, 300, 34, "今上午我不用"),
        _block(860, 900, 280, 34, "另一条消息"),
    ], window_bbox=WINDOW)
    assert len(elements) == 2


def test_the_two_columns_of_a_chat_are_never_merged() -> None:
    """左右两栏是你说的和对方说的。合并它们会把两个人的话算成一句。"""
    elements = group_blocks_into_elements([
        _block(700, 500, 260, 34, "对方说的话"),
        _block(1700, 520, 260, 34, "我说的话"),
    ], window_bbox=WINDOW)
    assert len(elements) == 2
    texts = {element.text for element in elements}
    assert texts == {"对方说的话", "我说的话"}


def test_text_from_other_windows_is_dropped() -> None:
    """整屏截图里有别的窗口。把它们框进来等于把别人的话算作这个对象的内容。"""
    elements = group_blocks_into_elements([
        _block(860, 500, 300, 34, "微信里的消息"),
        _block(100, 500, 300, 34, "终端里的输出"),
    ], window_bbox=WINDOW)
    assert len(elements) == 1
    assert elements[0].text == "微信里的消息"


def test_a_block_spanning_the_window_is_the_background_not_an_object() -> None:
    elements = group_blocks_into_elements(
        [_block(630, 500, 1480, 40, "横跨整个窗口的东西")],
        window_bbox=WINDOW,
    )
    assert elements == []


def test_reading_order_is_preserved() -> None:
    elements = group_blocks_into_elements([
        _block(860, 900, 200, 30, "第三"),
        _block(860, 300, 200, 30, "第一"),
        _block(860, 600, 200, 30, "第二"),
    ], window_bbox=WINDOW)
    assert [element.text for element in elements] == ["第一", "第二", "第三"]


def test_a_paragraph_of_many_lines_stays_one_element() -> None:
    blocks = [_block(860, 300 + index * 38, 400, 34, f"第{index}行") for index in range(6)]
    elements = group_blocks_into_elements(blocks, window_bbox=WINDOW)
    assert len(elements) == 1
    assert elements[0].line_count == 6


def test_no_window_bounds_still_groups() -> None:
    """不是每条路径都知道窗口范围；没有它时只是不做窗口过滤，而不是罢工。"""
    elements = group_blocks_into_elements([
        _block(10, 10, 100, 20, "a"),
        _block(10, 34, 100, 20, "b"),
    ])
    assert len(elements) == 1


def test_junk_input_produces_no_elements() -> None:
    assert group_blocks_into_elements(None) == []
    assert group_blocks_into_elements([]) == []
    assert group_blocks_into_elements([{}, {"rect": [1, 2]}, {"text": "无矩形"}]) == []
    assert group_blocks_into_elements([_block(1, 1, 10, 10, "   ")]) == []


def test_the_element_count_is_bounded() -> None:
    blocks = [_block(860, index * 200, 200, 30, f"块{index}") for index in range(MAX_ELEMENTS + 30)]
    assert len(group_blocks_into_elements(blocks)) == MAX_ELEMENTS


def test_serialisation_says_where_it_came_from() -> None:
    [element] = group_blocks_into_elements([_block(860, 500, 300, 34, "消息")], window_bbox=WINDOW)
    payload = element.to_dict()
    assert payload["rect"] == [860, 500, 300, 34]
    assert payload["lineCount"] == 1
    # 像素来源必须一路带到界面，高亮带才能用不同颜色画它。
    assert payload["source"] == "pixel"


# --- 点选 -------------------------------------------------------------------


def test_pointing_inside_a_bubble_returns_it() -> None:
    elements = group_blocks_into_elements([
        _block(860, 500, 300, 34, "今上午我不用"),
        _block(860, 900, 280, 34, "另一条"),
    ], window_bbox=WINDOW)
    hit = element_at_point(elements, {"x": 900, "y": 515})
    assert hit is not None and hit.text == "今上午我不用"


def test_pointing_at_nothing_returns_nothing() -> None:
    elements = group_blocks_into_elements([_block(860, 500, 300, 34, "消息")], window_bbox=WINDOW)
    assert element_at_point(elements, {"x": 100, "y": 100}) is None
    assert element_at_point(elements, None) is None
    assert element_at_point(elements, {"x": "x", "y": 1}) is None


def test_the_most_specific_element_wins_when_they_nest() -> None:
    from app.vision.visual_elements import VisualElement

    outer = VisualElement(rect=[800, 400, 600, 400], text="外层", line_count=1)
    inner = VisualElement(rect=[860, 500, 300, 34], text="内层", line_count=1)
    hit = element_at_point([outer, inner], {"x": 900, "y": 515})
    assert hit is not None and hit.text == "内层"
