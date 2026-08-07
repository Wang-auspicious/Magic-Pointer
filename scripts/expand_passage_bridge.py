"""把回答里的一段就地展开。

这不是第二轮对话。用户在已经出来的那张卡上划中一段字，点一下「展开讲讲」，
回来的字**换掉那一段**——轮次不变，问题不变，卡还是那张卡。所以这条桥不碰
选区会话、不碰屏幕上下文、不产生动作提案，它只做一件事：

    一段字进来 → 同一段字、更长 → 出去

**源就是那一段字。** 上一版这件事是靠界面把手势翻译成「把这个回答扩写到 6 行」
再走正常提交路径的，于是 selection_bridge 拿屏幕上划的那块当源去扩写——扩的
是错的东西，而且因为「行」在两边指的不是一回事（渲染出来的折行 vs 文本里的
换行符），比值虚高，必然撞上「四倍以上只能靠编造」那条护栏。两个毛病在这里
都不存在。

上下文（这段字所在的整段回答）只读不写：它让展开出来的话接得上前后文，不会
把已经说过的结论再说一遍。它不会被当成要扩写的东西。
"""

from __future__ import annotations

from typing import Any

from _bridge_common import (
    PayloadTooLargeError,
    ensure_root_on_path,
    force_utf8_stdio,
    read_bounded_json_payload,
    write_json,
)

ensure_root_on_path()

from app.actions.office import clean_replacement_text  # noqa: E402
from app.ai_client import ask_text_model  # noqa: E402
from app.text_actions.length_target import (  # noqa: E402
    MIN_MEANINGFUL_CHARS,
    auto_expand_target,
    build_instruction,
    measure,
)

PROMPT = "展开讲讲"

# 用户盯着一张卡在等，所以预算按交互路径给，不是批处理那套 120s×2。
EXPAND_TIMEOUT_S = 45.0

# 一次最多展开这么多原文。再多就不是「这句没看懂」了，是整张卡重写。
MAX_PASSAGE_CHARS = 4000

# 喂给模型的前后文上限。它只是用来对齐语气和避免重复的，不需要全文。
MAX_CONTEXT_CHARS = 3000


def _fail(message: str, *, detail: str = "") -> dict[str, Any]:
    return {"ok": False, "prompt": PROMPT, "error": message, "detail": detail}


def expand(passage: str, context: str = "") -> dict[str, Any]:
    """纯逻辑：一段字进，展开后的字出。模型调用是这里唯一的副作用。"""
    source = str(passage or "").strip()
    if not source:
        return _fail("没有选中任何文字。")
    _, source_chars = measure(source)
    if source_chars < MIN_MEANINGFUL_CHARS:
        return _fail("选中的太短了，展开它只会变成重写。多选一点再点。")
    if source_chars > MAX_PASSAGE_CHARS:
        return _fail(f"选中了 {source_chars} 字，一次最多展开 {MAX_PASSAGE_CHARS} 字。分几段来。")

    target = auto_expand_target(source)
    surrounding = str(context or "").strip()[:MAX_CONTEXT_CHARS]
    note = (
        "这段话是一整段回答里的一小截，展开后要能原样嵌回原处："
        "不要加开场白、不要加总结句、不要重复前后文已经说过的结论。"
    )
    context_text = f"原文：\n{source}"
    if surrounding:
        context_text = f"这段话所在的整段回答（只作参考，不要改写它）：\n{surrounding}\n\n{context_text}"

    result = clean_replacement_text(ask_text_model(
        build_instruction(target, user_note=note),
        context_text=context_text,
        system_prompt=(
            "你把一段话展开讲得更细。只输出展开后的那段话本身，不要任何解释。"
            "补充的内容必须来自原文已有的意思，不要引入原文没有的事实、数字或来源。"
        ),
        timeout_s=EXPAND_TIMEOUT_S,
        attempts=1,
    ))
    if not result or result.startswith("AI 调用失败"):
        return _fail(result or "模型没有返回内容，那一段没有被改动。")
    # 展开后反而更短，说明模型理解成了「概括」。与其把一段更短的字塞回去让
    # 用户以为自己点错了按钮，不如说清楚什么都没换。
    _, result_chars = measure(result)
    if result_chars <= source_chars:
        return _fail("这次没能展开得更细（回来的比原文还短），那一段保持原样。")
    return {
        "ok": True,
        "prompt": PROMPT,
        "text": result,
        "sourceChars": source_chars,
        "resultChars": result_chars,
    }


def main() -> int:
    force_utf8_stdio()
    try:
        payload = read_bounded_json_payload()
    except PayloadTooLargeError as exc:
        write_json(_fail("选中的内容太大了，分几段来。", detail=str(exc)))
        return 2
    except ValueError as exc:
        write_json(_fail("请求格式不对。", detail=f"invalid payload: {exc}"))
        return 2

    reply = expand(str(payload.get("passage") or ""), str(payload.get("context") or ""))
    write_json(reply)
    return 0 if reply.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
