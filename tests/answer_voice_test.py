"""答案是给人看的，不是给人看我们怎么读到的。

用户 2026-08-05 的原话：「"UIA 取词失败、这是 OCR 近似"这种屁话就别说了哈。没意义。」

他是对的。他问的是屏幕上那句话是什么意思，不是问我们的感知栈今天过得怎么样。
之前每个回答都要免责一遍，是因为我们在上下文里**明确要求**模型这么做——
`format_adapter_context` 里写着"把 OCR 文本当作近似的视觉观察，不是应用真值"，
模型只是照办。

来源和可信度仍然要记录，但它们属于回执和诊断页。
"""

from __future__ import annotations

from app.adapters.base import AdapterCapability, AdapterReadContext, format_adapter_context


def _ocr_context() -> AdapterReadContext:
    return AdapterReadContext(
        adapter="local_ocr",
        app="screen",
        window={"title": "微信"},
        content="yy: 大家记得打卡",
        method="local:rapidocr-onnx",
        artifacts={"ocr_engine": "rapidocr-onnx"},
    )


def _native_context() -> AdapterReadContext:
    return AdapterReadContext(
        adapter="uia_text_selection",
        app="word",
        window={"title": "doc.docx - Word"},
        content="一段被选中的文字",
        method="uia:text-pattern.selection",
        capabilities=[AdapterCapability("replace_selection", "Replace selected text", "high", True, True)],
    )


def test_the_model_is_not_told_to_hedge_about_ocr() -> None:
    rendered = format_adapter_context(_ocr_context())
    for phrase in ("approximate", "not as native app truth", "visual guess"):
        assert phrase not in rendered, f"上下文仍在要求模型免责：{phrase}"


def test_the_model_is_told_not_to_narrate_how_it_read_the_screen() -> None:
    for context in (_ocr_context(), _native_context()):
        rendered = format_adapter_context(context)
        assert "Do not describe how this text was obtained" in rendered


def test_the_content_and_the_capabilities_still_come_through() -> None:
    rendered = format_adapter_context(_native_context())
    assert "一段被选中的文字" in rendered
    assert "replace_selection" in rendered
    assert "Native app adapter context v1" in rendered


def test_provenance_is_still_recorded_for_the_receipt_even_if_unspoken() -> None:
    """诊断要得到来源，只是别让它进答案。"""
    rendered = format_adapter_context(_ocr_context())
    assert "local_ocr" in rendered


def test_a_read_error_is_no_longer_handed_to_the_model_as_prose() -> None:
    context = AdapterReadContext(
        adapter="uia_text_selection",
        app="application",
        window={"title": "微信"},
        content="yy: 大家记得打卡",
        method="uia:region-elements",
        error="UI Automation selection probe failed: TimeoutExpired",
    )
    rendered = format_adapter_context(context)
    # 有内容时，读取过程中的失败与用户的问题无关，不该出现在模型的输入里。
    assert "TimeoutExpired" not in rendered


def test_a_read_error_with_nothing_read_is_still_visible_to_the_model() -> None:
    context = AdapterReadContext(
        adapter="uia_text_selection",
        app="application",
        window={"title": "微信"},
        content="",
        method="uia:region-elements",
        error="UI Automation selection probe failed: TimeoutExpired",
    )
    # 什么都没读到时模型必须知道，否则它会假装看得见。
    assert "read_error" in format_adapter_context(context)
