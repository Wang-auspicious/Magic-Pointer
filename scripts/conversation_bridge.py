"""Continue a short Magic Pointer Studio conversation with the configured model."""

from __future__ import annotations

from time import perf_counter
from typing import Any

try:
    from scripts._bridge_common import (
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )
except ModuleNotFoundError:  # direct `python scripts/conversation_bridge.py`
    from _bridge_common import (  # type: ignore[no-redef]
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )

ensure_root_on_path()

from app.actions.office import clean_replacement_text  # noqa: E402
from app.ai_client import ask_text_model, request_ai_config  # noqa: E402

MAX_QUESTION_CHARS = 4000
MAX_CONTEXT_CHARS = 12000
MAX_TURNS = 12
CHAT_TIMEOUT_S = 45.0


def _history_text(turns: list[dict[str, Any]], obj: dict[str, Any]) -> str:
    object_label = " · ".join(
        str(obj.get(key) or "").strip() for key in ("app", "windowTitle", "label")
        if str(obj.get(key) or "").strip()
    )
    chunks = [f"当前对象：{object_label}"] if object_label else []
    for turn in turns[-MAX_TURNS:]:
        question = str(turn.get("question") or "").strip()[:2000]
        answer = str(turn.get("answer") or "").strip()[:4000]
        if question:
            chunks.append(f"用户：{question}")
        if answer:
            chunks.append(f"助手：{answer}")
    return "\n\n".join(chunks)[-MAX_CONTEXT_CHARS:]


def answer_conversation(
    question: str,
    turns: list[dict[str, Any]],
    obj: dict[str, Any],
) -> dict[str, Any]:
    prompt = str(question or "").strip()
    if not prompt:
        return {"ok": False, "error": "问题不能为空。"}
    if len(prompt) > MAX_QUESTION_CHARS:
        return {"ok": False, "error": f"问题最多 {MAX_QUESTION_CHARS} 字。"}

    started = perf_counter()
    answer = clean_replacement_text(ask_text_model(
        prompt,
        context_text=_history_text(turns if isinstance(turns, list) else [], obj if isinstance(obj, dict) else {}),
        system_prompt=(
            "你正在延续 Magic Pointer 里一段简短的日常对话。直接回答当前问题；"
            "沿用已有上下文，不重复开场，不声称看到了上下文里没有的屏幕内容。"
        ),
        timeout_s=CHAT_TIMEOUT_S,
        attempts=1,
    ))
    elapsed_ms = round((perf_counter() - started) * 1000)
    if not answer or answer.startswith("AI 调用失败"):
        return {
            "ok": False,
            "error": answer or "模型没有返回内容。",
            "usedBackend": "app.ai_client.ask_text_model",
            "timingMs": elapsed_ms,
        }
    return {
        "ok": True,
        "answer": answer,
        "usedBackend": "app.ai_client.ask_text_model",
        "timingMs": elapsed_ms,
    }


def main() -> int:
    force_utf8_stdio()
    try:
        payload = read_bounded_json_payload()
    except (PayloadTooLargeError, ValueError) as exc:
        write_json({"ok": False, "error": f"请求格式不对：{exc}"})
        return 2

    with request_ai_config(payload.get("modelRuntime")):
        result = answer_conversation(
            str(payload.get("question") or ""),
            payload.get("turns") if isinstance(payload.get("turns"), list) else [],
            payload.get("object") if isinstance(payload.get("object"), dict) else {},
        )
    write_json(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
