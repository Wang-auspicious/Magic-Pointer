"""图转提示词：给看不见图的模型装眼睛。

这个功能唯一致命的失败方式不是"描述得不够好"，而是**悄悄漏掉视觉层**——
用户把描述粘给 DeepSeek，DeepSeek 以为自己知道这张图长什么样，于是自信地
编造颜色、风格、构图。所以这里钉的核心是：**没有的东西必须说出来**。
"""

from __future__ import annotations

from app.vision.image_prompt import (
    MAX_PROMPT_CHARS,
    ImagePromptLayers,
    compose_prompt,
    describe_coverage,
)


def _text_only() -> ImagePromptLayers:
    return ImagePromptLayers(
        text="第一季度销售额 120 万\n第二季度 145 万",
        text_engine="rapidocr",
        width=1200,
        height=800,
        missing={"caption": "没有配置视觉模型", "elements": "没有安装 OmniParser"},
    )


def test_a_missing_visual_layer_is_stated_not_omitted() -> None:
    prompt = compose_prompt(_text_only())
    assert "未提供的信息" in prompt
    assert "颜色、风格、构图" in prompt
    assert "没有配置视觉模型" in prompt
    # 而且要明确禁止接收方推测——只说"缺少"不够，模型会照猜。
    assert "不要推测" in prompt


def test_a_complete_description_does_not_warn_about_the_visual_layer() -> None:
    layers = ImagePromptLayers(
        text="错误代码 0x80070005",
        text_engine="rapidocr",
        caption="一个 Windows 错误对话框，红色叉号图标，两个按钮。",
        caption_model="gpt-4o-mini",
        width=600,
        height=400,
    )
    prompt = compose_prompt(layers)
    assert "红色叉号" in prompt
    assert "颜色、风格、构图" not in prompt


def test_the_ocr_engine_and_size_are_named_so_the_reader_can_judge_reliability() -> None:
    prompt = compose_prompt(_text_only())
    assert "1200×800" in prompt
    assert "rapidocr" in prompt


def test_elements_carry_their_kind_label_and_position() -> None:
    layers = ImagePromptLayers(
        elements=[
            {"kind": "Button", "label": "确定", "rect": [100, 200, 80, 32]},
            {"kind": "Edit", "label": "", "rect": [10, 40, 300, 28]},
        ],
        element_engine="omniparser",
    )
    prompt = compose_prompt(layers)
    assert "Button：确定 位置 100,200 尺寸 80×32" in prompt
    # 没有标签的元件也要出现——它的存在和位置本身就是信息。
    assert "Edit 位置 10,40" in prompt
    assert "omniparser" in prompt


def test_nothing_readable_produces_no_prompt_rather_than_an_empty_shell() -> None:
    # 交出一个"这是一张图"的空壳比什么都不给更糟：用户会以为它有用。
    assert compose_prompt(ImagePromptLayers()) == ""
    assert compose_prompt(ImagePromptLayers(missing={"text": "OCR 失败"})) == ""


def test_the_users_question_rides_along_when_there_is_one() -> None:
    assert "这是什么错误？" in compose_prompt(_text_only(), question="这是什么错误？")
    assert "用户的问题" not in compose_prompt(_text_only(), question="   ")


def test_a_huge_image_is_truncated_and_says_so() -> None:
    layers = ImagePromptLayers(text="很长的一行文字。" * 3000, text_engine="rapidocr")
    prompt = compose_prompt(layers)
    assert len(prompt) <= MAX_PROMPT_CHARS + 40
    assert "截断" in prompt


def test_too_many_elements_are_capped_and_the_remainder_is_counted() -> None:
    layers = ImagePromptLayers(
        elements=[{"kind": "Button", "label": f"按钮{index}"} for index in range(60)],
        element_engine="omniparser",
    )
    prompt = compose_prompt(layers)
    assert "共 60 个" in prompt
    assert "还有 20 个元件未列出" in prompt


def test_the_coverage_line_says_what_the_description_rests_on() -> None:
    line = describe_coverage(_text_only())
    assert "已包含：文字" in line
    assert "缺少" in line and "视觉描述" in line
    assert describe_coverage(ImagePromptLayers()) == "没有从这张图里读到任何可用信息。"


def test_available_layers_reflect_content_not_intent() -> None:
    # 空白字符串不算一层——否则"有 OCR 结果"会因为一个空格而成立。
    layers = ImagePromptLayers(text="   ", caption="\n")
    assert layers.available_layers == []
    assert layers.has_anything is False


# --- 执行器接线 ---------------------------------------------------------------


def _plan(objects, question=""):
    from app.fabric.schema import OperationPlan, RiskLevel

    return OperationPlan(
        id="plan-1",
        recipe_id="image.to_prompt",
        command="这张图的提示词",
        risk=RiskLevel.LOCAL_WRITE,
        provider="artifact.visual_context",
        object_ids=("obj-1",),
        idempotency_key="abcdef0123456789",
        parameters={"question": question, "objects": objects},
    )


def _executors(tmp_path):
    from app.fabric.executors import FabricExecutors

    return FabricExecutors(root=tmp_path)


def test_the_recipe_produces_pasteable_text_and_a_truthful_receipt(tmp_path) -> None:
    receipt = _executors(tmp_path).execute(_plan([{
        "id": "obj-1",
        "kind": "image",
        "content": "错误代码 0x80070005",
        "bbox": [0, 0, 640, 480],
        "elements": [{"kind": "Button", "label": "确定", "rect": [100, 400, 80, 30]}],
        "artifacts": {"ocr_engine": "rapidocr-onnx"},
        "source": {"adapter": "uia"},
    }], question="这是什么错误？"))

    assert receipt.status == "succeeded"
    assert receipt.verified is True
    # 结果本身就是能粘的文字，不是一个 JSON 结构。
    assert "0x80070005" in receipt.output["text"]
    assert "这是什么错误？" in receipt.output["text"]
    # 缺什么必须进回执，不能只写在正文里。
    assert receipt.verification["missing"] == "caption"
    assert receipt.verification["layers"] == "text,elements"


def test_a_configured_vision_caption_is_used_and_stops_the_warning(tmp_path) -> None:
    receipt = _executors(tmp_path).execute(_plan([{
        "id": "obj-1",
        "kind": "image",
        "content": "销售额",
        "bbox": [0, 0, 300, 200],
        "artifacts": {
            "ocr_engine": "rapidocr-onnx",
            "vision_caption": "一张蓝色柱状图，四根柱子逐月上升。",
            "vision_caption_model": "gpt-4o-mini",
        },
    }]))
    assert "蓝色柱状图" in receipt.output["text"]
    assert "颜色、风格、构图" not in receipt.output["text"]
    assert "caption" in receipt.verification["layers"]


def test_an_unreadable_image_refuses_rather_than_shipping_an_empty_shell(tmp_path) -> None:
    receipt = _executors(tmp_path).execute(_plan([{"id": "obj-1", "kind": "image", "content": ""}]))
    assert receipt.status == "capability_unavailable"
    assert receipt.error == "image_has_no_readable_layer"
    assert receipt.verified is False
    # 而且要说清楚是什么都没读到，不是"成功但内容为空"。
    assert "没有从这张图里读到" in receipt.output["coverage"]


def test_no_objects_at_all_is_a_failure_not_a_silent_empty_prompt(tmp_path) -> None:
    receipt = _executors(tmp_path).execute(_plan([]))
    assert receipt.status == "failed"
    assert receipt.error == "no_visual_objects"


def test_the_older_structured_recipe_still_gets_its_json_packet(tmp_path) -> None:
    """image.to_prompt 和 vision.prompt_bridge 共用 provider，输出形态不同。

    改动前者不能把后者的契约改掉。
    """
    from app.fabric.schema import OperationPlan, RiskLevel

    plan = OperationPlan(
        id="plan-2",
        recipe_id="vision.prompt_bridge",
        command="视觉提示",
        risk=RiskLevel.LOCAL_WRITE,
        provider="artifact.visual_context",
        object_ids=("obj-1",),
        idempotency_key="fedcba9876543210",
        parameters={"objects": [{"id": "obj-1", "kind": "image", "content": "文字", "bbox": [0, 0, 10, 10]}]},
    )
    receipt = _executors(tmp_path).execute(plan)
    assert receipt.status == "succeeded"
    assert receipt.output["artifact"].endswith("-visual-context.json")
    assert "text" not in receipt.output
