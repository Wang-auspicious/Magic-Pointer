from __future__ import annotations

from app.agent_runtime.next_prompt import (
    MAX_SUGGESTION_CHARS,
    SOURCE_CAP_CHARS,
    _clean_suggestion,
    suggest_next_prompt,
)


def test_clean_suggestion_keeps_one_bare_line() -> None:
    assert _clean_suggestion("01和07各给我一版完整的intro第一段差异句") == (
        "01和07各给我一版完整的intro第一段差异句"
    )
    # 多行输出只取第一行：联想词是一句话，不是一段。
    assert _clean_suggestion("先跑测试\n然后再改样式") == "先跑测试"
    assert _clean_suggestion("  前后有空白  ") == "前后有空白"


def test_clean_suggestion_strips_model_wrapping() -> None:
    """引号和列表前缀是模型在「引用」那句话，不是用户要打的字。"""
    assert _clean_suggestion('"把 diff 卡按参考重画"') == "把 diff 卡按参考重画"
    assert _clean_suggestion("「把 diff 卡按参考重画」") == "把 diff 卡按参考重画"
    assert _clean_suggestion("“继续核对第二张图”") == "继续核对第二张图"
    assert _clean_suggestion("1. 把 diff 卡按参考重画") == "把 diff 卡按参考重画"
    assert _clean_suggestion("- 把 diff 卡按参考重画") == "把 diff 卡按参考重画"


def test_clean_suggestion_rejects_what_is_not_a_suggestion() -> None:
    assert _clean_suggestion("") == ""
    assert _clean_suggestion("   ") == ""
    # 超长的输出是段落，不是能按回车发出去的一句话。
    assert _clean_suggestion("长" * (MAX_SUGGESTION_CHARS + 1)) == ""
    assert len(_clean_suggestion("长" * MAX_SUGGESTION_CHARS)) == MAX_SUGGESTION_CHARS
    # 只有一个引号字符的输入不该被剥成空串以外的怪东西。
    assert _clean_suggestion("「」") == "「」"


def test_suggest_next_prompt_returns_empty_without_history() -> None:
    """空历史不发请求——没有对话就没有「下一步」。"""
    assert suggest_next_prompt("") == ""
    assert suggest_next_prompt("   \n  ") == ""


def test_suggestion_source_reads_the_tail_of_the_conversation() -> None:
    """建议是关于下一步的，取尾部：开头的上下文对这件事没有帮助。"""
    assert SOURCE_CAP_CHARS > 0
    head = "开" * SOURCE_CAP_CHARS
    tail = "最新的那一轮"
    captured: dict[str, str] = {}

    import app.ai_client as ai_client

    original = ai_client.ask_text_model

    def fake_ask(_prompt, context_text=None, **_kwargs):  # noqa: ANN001, ANN003
        captured["context"] = str(context_text or "")
        return "把这一轮写成测试"

    ai_client.ask_text_model = fake_ask
    try:
        assert suggest_next_prompt(head + tail) == "把这一轮写成测试"
    finally:
        ai_client.ask_text_model = original

    assert captured["context"].endswith(tail)
    assert len(captured["context"]) == SOURCE_CAP_CHARS


def test_a_failed_model_call_is_not_a_suggestion() -> None:
    """ask_text_model 把失败当成句子返回；照抄就会把报错当成用户的下一个问题。"""
    import app.ai_client as ai_client
    from app.ai_client import AI_FAILURE_PREFIX

    original = ai_client.ask_text_model

    def fake_ask(*_args, **_kwargs):  # noqa: ANN002, ANN003
        return f"{AI_FAILURE_PREFIX}连接超时"

    ai_client.ask_text_model = fake_ask
    try:
        assert suggest_next_prompt("用户：改一下按钮\n助手：好") == ""
    finally:
        ai_client.ask_text_model = original


def test_a_raising_model_call_is_not_a_suggestion() -> None:
    """联想词是装饰：任何异常都只能退化成「没有建议」。"""
    import app.ai_client as ai_client

    original = ai_client.ask_text_model

    def fake_ask(*_args, **_kwargs):  # noqa: ANN002, ANN003
        raise RuntimeError("gateway down")

    ai_client.ask_text_model = fake_ask
    try:
        assert suggest_next_prompt("用户：改一下按钮") == ""
    finally:
        ai_client.ask_text_model = original
