"""圈选磁铁语义：笔迹凸包内的元素 = 选中，穿越规则保留。

用户真机症状（8·29）：圈住两行文字，只有第一行被识别——旧规则要求
笔画线物理穿过元素矩形，圈住文字时笔只擦过边缘，容差一抖就漏。
凸包规则统一「圈选」和「下划线」两种手势，没有形状 if-else：
闭合圈 → 凸包是面 → 罩住的所有块全中；下划线 → 凸包是细带 → 只有
被压的行中。
"""

from __future__ import annotations

from scripts.selection_snapshot_bridge import _select_region_elements_by_strokes


def _element(text: str, rect: list[int], control_type: str = "Text") -> dict:
    return {"text": text, "rect": rect, "control_type": control_type}


def test_loop_around_two_lines_selects_both_without_touching_them():
    """圈住两行：笔只擦过边缘，凸包罩住内部 → 两行都选中。"""
    line1 = _element("第一行内容", [100, 100, 400, 30])
    line2 = _element("第二行内容", [100, 140, 400, 30])
    # 圆圈的近似：四角点，笔画本身只在矩形边缘经过
    loop = [[(90, 90), (510, 90), (510, 180), (90, 180), (90, 90)]]
    selected, segments = _select_region_elements_by_strokes([line1, line2], loop)
    names = [e["text"] for e in selected]
    assert names == ["第一行内容", "第二行内容"], f"got {names}"
    assert segments and len(segments) == 1


def test_underline_still_selects_only_the_crossed_line():
    """下划线（细带凸包）：只选中被压的那一行。"""
    line1 = _element("第一行", [100, 100, 400, 30])
    line2 = _element("第二行", [100, 140, 400, 30])
    underline = [[(90, 115), (510, 115)]]
    selected, _ = _select_region_elements_by_strokes([line1, line2], underline)
    assert [e["text"] for e in selected] == ["第一行"]


def test_element_far_outside_the_loop_stays_out():
    inside1 = _element("圈内", [100, 100, 400, 30])
    outside = _element("圈外", [100, 800, 400, 30])
    loop = [[(90, 90), (510, 90), (510, 180), (90, 180), (90, 90)]]
    selected, _ = _select_region_elements_by_strokes([inside1, outside], loop)
    assert [e["text"] for e in selected] == ["圈内"]


def test_multi_stroke_selection_stays_separate():
    a = _element("甲", [100, 100, 200, 30])
    b = _element("乙", [100, 400, 200, 30])
    strokes = [
        [(90, 90), (310, 150), (90, 150), (90, 90)],
        [(90, 390), (310, 450), (90, 450), (90, 390)],
    ]
    selected, segments = _select_region_elements_by_strokes([a, b], strokes)
    assert [e["text"] for e in selected] == ["甲", "乙"]
    assert len(segments) == 2, "两条笔画各自成段，不并成一个大框"
