"""Suggest the follow-up the user most plausibly wants, one line, no side effects.

This is the input-box ghost text: after a turn settles, the composer shows what
the user would most likely type next. It is a *suggestion*, never state — a
failed or empty suggestion is the normal case and simply leaves the composer's
own placeholder in place.

Two properties matter more than quality here:

* ``max_tokens`` is small on purpose. Measured against a relay, the ceiling is
  the wait: the same one-line question cost 26.9 s at a 1200-token cap and
  12.1 s at 120. A suggestion that arrives after the user has started typing is
  worth nothing, so the budget is sized for one sentence.
* Failure is reported as ``""``, never as prose. ``ask_text_model`` returns its
  failures as a sentence, and a caller that does not check would show
  "AI 调用失败：…" as if it were the user's own next question. See
  :func:`app.ai_client.is_ai_failure`.
"""

from __future__ import annotations

from typing import Final

#: The tail of the conversation is what the suggestion is about; the head is
#: context the model does not need to name the next move.
SOURCE_CAP_CHARS: Final = 12_000

NEXT_PROMPT_MAX_TOKENS: Final = 80

#: One attempt. The suggestion is decorative: a retry that lands 20 s later is
#: worse than no suggestion at all.
NEXT_PROMPT_ATTEMPTS: Final = 1

NEXT_PROMPT_TIMEOUT_S: Final = 20.0

#: A suggestion longer than this is a paragraph, not something to type.
MAX_SUGGESTION_CHARS: Final = 120

_SYSTEM_PROMPT: Final = (
    "你是一个输入法的联想引擎。你读一段用户与助手的对话，然后写出用户接下来"
    "最可能打出来的那一句话。\n"
    "\n"
    "只输出那句话本身：不要引号、不要编号、不要解释、不要换行。\n"
    "用对话本身的语言。\n"
    "要具体：可以带着对话里出现过的名字、数字、文件名。不要写「继续」"
    "「还有呢」「下一步怎么做」这种放到任何对话里都成立的空话。\n"
    "不要重复用户最后已经说过的话。\n"
    f"{MAX_SUGGESTION_CHARS} 字以内。"
)


def _clean_suggestion(raw: str) -> str:
    """Reduce model output to one short line, or ``""`` when there is none."""
    text = str(raw or "").strip()
    if not text:
        return ""
    # 只取第一行：一个会写小作文的模型不该把整段塞进输入框。
    text = text.splitlines()[0].strip()
    # 包了引号（中英文都算）就剥掉——引号是模型在「引用」那句话，不是用户要打的字。
    for opening, closing in (('"', '"'), ("'", "'"), ("「", "」"), ("“", "”"), ("《", "》")):
        if text.startswith(opening) and text.endswith(closing) and len(text) > 2:
            text = text[1:-1].strip()
            break
    # 「1. 」「- 」这类列表前缀同样是包装，不是内容。
    for prefix in ("1. ", "1、", "- ", "* ", "> "):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
            break
    text = " ".join(text.split())
    if len(text) > MAX_SUGGESTION_CHARS:
        return ""
    return text


def suggest_next_prompt(history_text: str) -> str:
    """Return a one-line suggestion for what the user types next, or ``""``.

    ``""`` is the contract: no history, no configured model, a failed call, or
    output that is not a usable sentence all mean "leave the placeholder alone".
    """
    from app.ai_client import ask_text_model, is_ai_failure

    # 取尾部：建议是关于「下一步」的，开头的上下文对这件事没有帮助。
    source = str(history_text or "")[-SOURCE_CAP_CHARS:]
    if not source.strip():
        return ""
    try:
        raw = ask_text_model(
            _SYSTEM_PROMPT,
            context_text=source,
            timeout_s=NEXT_PROMPT_TIMEOUT_S,
            attempts=NEXT_PROMPT_ATTEMPTS,
            max_tokens=NEXT_PROMPT_MAX_TOKENS,
        )
    except Exception:  # noqa: BLE001 -- a suggestion must never fail a surface
        return ""
    if is_ai_failure(raw):
        return ""
    return _clean_suggestion(raw)
