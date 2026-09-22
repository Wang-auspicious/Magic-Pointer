
from __future__ import annotations

from typing import Final

SOURCE_CAP_CHARS: Final = 12_000

NEXT_PROMPT_MAX_TOKENS: Final = 80

NEXT_PROMPT_ATTEMPTS: Final = 1

NEXT_PROMPT_TIMEOUT_S: Final = 20.0

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
    text = str(raw or "").strip()
    if not text:
        return ""
    text = text.splitlines()[0].strip()
    for opening, closing in (('"', '"'), ("'", "'"), ("「", "」"), ("“", "”"), ("《", "》")):
        if text.startswith(opening) and text.endswith(closing) and len(text) > 2:
            text = text[1:-1].strip()
            break
    for prefix in ("1. ", "1、", "- ", "* ", "> "):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
            break
    text = " ".join(text.split())
    if len(text) > MAX_SUGGESTION_CHARS:
        return ""
    return text


def suggest_next_prompt(history_text: str) -> str:
    from app.ai_client import ask_text_model, is_ai_failure

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
