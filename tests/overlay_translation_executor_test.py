"""悬浮翻译的执行器：模型不听话时，宁可不盖，也不能盖错。

覆盖式翻译最危险的失败不是"没翻译"，而是**把第 3 句的译文盖在第 5 句上**——
屏幕上留下一个看起来毫无破绽的错译。模型少给一行、多给一句开场白、或者自己重新编号，
都会造成这个结果。所以配对必须按编号，认领不到的槽位就空着、不覆盖。
"""

from __future__ import annotations

from app.fabric.executors import FabricExecutors, _numbered_lines
from app.fabric.schema import OperationPlan, RiskLevel


def _plan(blocks, **parameters):
    return OperationPlan(
        id="plan-1",
        recipe_id="screen.translate",
        command="翻译这块",
        risk=RiskLevel.READ,
        provider="overlay.translation",
        object_ids=("obj-1",),
        idempotency_key="abcdef0123456789",
        parameters={"objects": [{"id": "obj-1", "blocks": blocks}], **parameters},
    )


def _blocks(*texts):
    return [
        {"text": text, "rect": [100, 200 + index * 40, 400, 30]}
        for index, text in enumerate(texts)
    ]


def _executors(tmp_path, reply):
    return FabricExecutors(root=tmp_path, model_transform=lambda instruction, source, recipe: reply)


# --- 编号解析 ---------------------------------------------------------------


def test_numbered_lines_land_in_their_own_slots() -> None:
    assert _numbered_lines("1. 一\n2. 二\n3. 三", 3) == ["一", "二", "三"]


def test_a_missing_line_leaves_a_hole_rather_than_shifting_everything() -> None:
    """这是本文件存在的理由：少一行不能让后面全部错位。"""
    assert _numbered_lines("1. 一\n3. 三", 3) == ["一", "", "三"]


def test_a_preamble_does_not_become_a_translation() -> None:
    assert _numbered_lines("好的，翻译如下：\n1. 一\n2. 二", 2) == ["一", "二"]


def test_an_unnumbered_reply_is_used_only_when_the_count_matches_exactly() -> None:
    assert _numbered_lines("一\n二", 2) == ["一", "二"]
    assert _numbered_lines("一\n二", 3) == ["", "", ""]


def test_out_of_range_numbers_are_ignored() -> None:
    assert _numbered_lines("9. 越界\n1. 一", 2) == ["一", ""]


def test_full_width_and_alternative_separators_are_accepted() -> None:
    assert _numbered_lines("1、一\n2．二", 2) == ["一", "二"]


def test_junk_reply_produces_empty_slots() -> None:
    assert _numbered_lines("", 2) == ["", ""]
    assert _numbered_lines(None, 2) == ["", ""]
    assert _numbered_lines("1. 一", 0) == []


# --- 执行器 -----------------------------------------------------------------


def test_a_region_is_translated_block_by_block(tmp_path) -> None:
    receipt = _executors(tmp_path, "1. 你好\n2. 世界").execute(_plan(_blocks("Hello", "World")))
    assert receipt.status == "succeeded"
    assert receipt.verified is True
    overlay = receipt.output["overlay"]
    assert [item["text"] for item in overlay] == ["你好", "世界"]
    # 每块译文必须落在自己那块的矩形上。
    assert overlay[0]["rect"] == [100, 200, 400, 30]
    assert overlay[1]["rect"] == [100, 240, 400, 30]
    assert receipt.verification["covered"] == "2"


def test_a_dropped_line_covers_the_others_and_leaves_that_one_alone(tmp_path) -> None:
    receipt = _executors(tmp_path, "1. 你好\n3. 第三").execute(_plan(_blocks("Hello", "World", "Third")))
    overlay = receipt.output["overlay"]
    assert [item["text"] for item in overlay] == ["你好", "第三"]
    assert [item["rect"][1] for item in overlay] == [200, 280]
    assert receipt.verification["covered"] == "2"


def test_a_region_already_in_the_target_language_covers_nothing(tmp_path) -> None:
    receipt = _executors(tmp_path, "1. 你好\n2. 世界").execute(_plan(_blocks("你好", "世界")))
    assert receipt.status == "succeeded"
    assert receipt.output["overlay"] == []
    assert "已经是目标语言" in receipt.output["coverage"]


def test_a_region_with_no_text_says_so_instead_of_succeeding_emptily(tmp_path) -> None:
    receipt = _executors(tmp_path, "1. 你好").execute(_plan([]))
    assert receipt.status == "capability_unavailable"
    assert receipt.error == "region_has_no_readable_text"
    assert "没有读到文字" in receipt.output["coverage"]


def test_no_model_configured_is_reported_not_faked(tmp_path) -> None:
    receipt = FabricExecutors(root=tmp_path).execute(_plan(_blocks("Hello")))
    assert receipt.status == "capability_unavailable"
    assert receipt.error == "text_model_not_configured"


def test_a_failing_model_does_not_raise(tmp_path) -> None:
    def explode(*_args):
        raise RuntimeError("gateway down")

    receipt = FabricExecutors(root=tmp_path, model_transform=explode).execute(_plan(_blocks("Hello")))
    assert receipt.status == "failed"
    assert "text_model_failed" in receipt.error


def test_the_target_language_is_carried_through(tmp_path) -> None:
    captured = {}

    def transform(instruction, source, recipe):
        captured["instruction"] = instruction
        return "1. Hallo"

    executors = FabricExecutors(root=tmp_path, model_transform=transform)
    receipt = executors.execute(_plan(_blocks("Hello"), targetLanguage="德语"))
    assert "德语" in captured["instruction"]
    assert receipt.output["targetLanguage"] == "德语"


def test_truncation_is_reported_in_the_receipt(tmp_path) -> None:
    blocks = [{"text": "x", "rect": [0, 0, 60, 16]}]
    receipt = _executors(tmp_path, "1. 这是一段远远超出这个小方框能容纳范围的很长很长的译文").execute(_plan(blocks))
    assert receipt.verification["truncated"] == "1"
    assert "截断" in receipt.output["coverage"]
