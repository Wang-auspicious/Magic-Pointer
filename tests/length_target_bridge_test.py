"""拉伸把手必须真的按目标长度改写，并诚实报告有没有命中。

这个功能最容易的失败方式不是崩，是"看起来对"：模型返回一段通顺的文字，
长度差得远，但界面报成功。所以这里钉的重点是——没命中就要说没命中。
"""

from __future__ import annotations

import scripts.selection_bridge as bridge
from app.adapters import AdapterReadContext

FIVE_LINES = "\n".join(f"第 {index} 行的内容，长度足够构成一句话。" for index in range(1, 6))
TWO_LINES = "第一句话在这里。\n第二句话也在这里。"


def _ctx(content: str) -> AdapterReadContext:
    return AdapterReadContext(
        adapter="uia",
        app="application",
        window={"title": "Editor", "hwnd": 7},
        content=content,
        label="THIS",
        method="uia:text-pattern.selection",
    )


def _payload(command: str) -> dict:
    return {"command": command, "selectionSessionId": "session-1"}


def test_a_command_that_is_not_a_length_target_falls_through() -> None:
    # 返回 None 才能让原来的改写/问答链路继续走。
    assert bridge._length_target_response(_payload("改得更正式"), {}, _ctx(TWO_LINES), {}) is None
    assert bridge._length_target_response(_payload("OCR一下"), {}, _ctx(TWO_LINES), {}) is None


def test_no_readable_content_falls_through_instead_of_guessing() -> None:
    assert bridge._length_target_response(_payload("扩写到 5 行"), {}, _ctx(""), {}) is None
    assert bridge._length_target_response(_payload("扩写到 5 行"), {}, None, {}) is None


def test_an_impossible_target_stops_before_spending_a_model_call(monkeypatch) -> None:
    called = []
    monkeypatch.setattr(bridge, "ask_text_model", lambda *a, **k: called.append(1) or "不该被调用")
    result = bridge._length_target_response(_payload("扩写到 5 行"), {}, _ctx("短"), {})
    assert result is not None
    assert result["ok"] is False
    assert "太短" in result["error"]
    assert called == [], "在明知做不到的时候还是调用了模型"


def test_a_result_that_hit_the_target_reports_the_measurement(monkeypatch) -> None:
    monkeypatch.setattr(bridge, "ask_text_model", lambda *a, **k: FIVE_LINES)
    result = bridge._length_target_response(_payload("扩写到 5 行"), {}, _ctx(TWO_LINES), {})
    assert result["ok"] is True
    assert result["lengthHit"] is True
    assert result["answer"] == FIVE_LINES
    assert "目标 5 行" in result["detail"]
    assert result["lengthTarget"]["direction"] == "expand"
    assert result["route"]["recipeId"] == "selection.expand"


def test_a_result_that_missed_the_target_says_so_rather_than_claiming_success(monkeypatch) -> None:
    # 通顺但长度不对的回答，是这个功能最危险的情况。
    monkeypatch.setattr(bridge, "ask_text_model", lambda *a, **k: "只有一行，但读起来很像成功了。")
    result = bridge._length_target_response(_payload("扩写到 8 行"), {}, _ctx(TWO_LINES), {})
    assert result["ok"] is True
    assert result["lengthHit"] is False
    assert "没有正好命中" in result["detail"]


def test_the_answer_carries_no_preamble_because_it_gets_pasted(monkeypatch) -> None:
    monkeypatch.setattr(bridge, "ask_text_model", lambda *a, **k: "好的，以下是改写后的内容：\n真正的正文在这里。")
    result = bridge._length_target_response(_payload("压缩到 1 行"), {}, _ctx(FIVE_LINES), {})
    assert "好的" not in result["answer"]
    assert "以下是" not in result["answer"]


def test_a_failed_model_call_is_reported_and_changes_nothing(monkeypatch) -> None:
    monkeypatch.setattr(bridge, "ask_text_model", lambda *a, **k: "AI 调用失败：模型端点余额不足。")
    result = bridge._length_target_response(_payload("压缩到 2 行"), {}, _ctx(FIVE_LINES), {})
    assert result["ok"] is False
    assert "余额不足" in result["error"]
    assert result["actionProposals"] == []


def test_condensing_routes_to_the_condense_recipe(monkeypatch) -> None:
    monkeypatch.setattr(bridge, "ask_text_model", lambda *a, **k: TWO_LINES)
    result = bridge._length_target_response(_payload("压缩到 2 行"), {}, _ctx(FIVE_LINES), {})
    assert result["lengthTarget"]["direction"] == "condense"
    assert result["route"]["recipeId"] == "selection.condense"


def test_the_stretch_handles_command_shape_is_the_one_python_parses() -> None:
    """把手发出的命令必须能被这里解析，否则手势就是装饰。

    命令文本由 electron/stage_stretch_policy.js 的 stretchCommand 生成。
    """
    from app.text_actions.length_target import target_from_command

    for command, expected_lines in (
        ("把这个回答扩写到 6 行", 6),
        ("把这个回答压缩到 2 行", 2),
    ):
        target = target_from_command(command, FIVE_LINES)
        assert target is not None, command
        assert target.target_lines == expected_lines
