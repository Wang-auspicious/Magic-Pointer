from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.actions.history import ActionHistoryStore, make_word_undo_proposal
from app.actions.office import clean_replacement_text, make_word_replace_selection_proposal, wants_word_rewrite
from app.adapters import default_adapter_registry, format_adapter_context
from app.ai_client import ask_text_model
from app.system_context import list_visible_windows

MAGIC_WINDOW_MARKERS = ("Magic Pointer", "Electron Overlay")


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().lstrip("\ufeff").strip()
    return json.loads(raw) if raw else {}


def _window_dicts() -> list[dict[str, Any]]:
    windows = []
    for item in list_visible_windows():
        title = str(item.get("title") or "")
        if any(marker in title for marker in MAGIC_WINDOW_MARKERS):
            continue
        windows.append(dict(item))
    return windows


def _wants_undo(command: str) -> bool:
    normalized = str(command or "").lower()
    return any(token in normalized for token in ("undo", "restore", "revert", "撤回", "撤销", "还原"))


def _selection_context_text(app_ctx: Any, target_window: dict[str, Any] | None) -> str:
    target_title = str((target_window or {}).get("title") or "当前应用")
    if app_ctx is None:
        return (
            "Observer selection context v1:\n"
            f"Foreground application: {target_title}\n"
            "No native selection adapter is available for this foreground application."
        )
    return (
        "Observer selection context v1:\n"
        "The user selected text in the real application before opening this command panel.\n"
        f"Foreground application: {target_title}\n\n"
        + format_adapter_context(app_ctx)
    )


def _read_target_context(windows: list[dict[str, Any]], command: str) -> tuple[dict[str, Any] | None, Any]:
    target_window = windows[0] if windows else None
    if target_window is None:
        return None, None
    registry = default_adapter_registry()
    adapter = registry.matching_adapter(target_window)
    if adapter is None:
        return target_window, None
    return target_window, adapter.read_context(target_window, command=command)


def main() -> int:
    payload = read_payload()
    command = str(payload.get("command") or "").strip()
    if not command:
        print(json.dumps({"ok": False, "error": "missing command"}, ensure_ascii=False))
        return 2

    if _wants_undo(command):
        record = ActionHistoryStore().recent_undoable(app="word")
        if record is None:
            print(json.dumps({
                "ok": False,
                "prompt": command,
                "error": "没有找到可撤回的 Magic Pointer Word/WPS 修改。",
                "actionProposals": [],
            }, ensure_ascii=False))
            return 1
        proposal = make_word_undo_proposal(record)
        print(json.dumps({
            "ok": True,
            "prompt": command,
            "answer": f"已找到最近一次 Magic Pointer 文档修改：{record.document or 'Word/WPS 文档'}。确认后将精确恢复该次修改，不会调用全局 Ctrl+Z。",
            "actionProposals": [proposal.to_dict()],
        }, ensure_ascii=False))
        return 0

    windows = _window_dicts()
    target_window, app_ctx = _read_target_context(windows, command)
    context_text = _selection_context_text(app_ctx, target_window)
    action_proposals = []

    if app_ctx and app_ctx.app == "word" and wants_word_rewrite(command) and (app_ctx.content or "").strip():
        replacement = ask_text_model(
            command,
            context_text=(
                context_text
                + "\n\nWord write-back proposal mode:\n"
                + "Return ONLY the replacement text for the selected Word text. No headings, labels, markdown, or explanation."
            ),
            system_prompt="You rewrite selected Word text. Return only the replacement text; no explanation.",
        )
        replacement = clean_replacement_text(replacement)
        proposal = make_word_replace_selection_proposal(app_ctx, command=command, replacement_text=replacement)
        if proposal is not None:
            action_proposals.append(proposal.to_dict())
            before_preview = str(proposal.parameters.get("expected_text_excerpt") or "")[:700]
            after_preview = str(proposal.parameters.get("replacement_text_excerpt") or "")[:700]
            document = str(proposal.parameters.get("document") or "Word document")
            answer = (
                "已生成文档选区替换预览。\n"
                f"文档：{document}\n"
                f"替换前：{before_preview}\n"
                f"替换后：{after_preview}\n"
                "确认时会重新校验活动文档、选区位置和原文哈希；完成后可用 Magic Pointer 精确撤回。"
            )
        else:
            answer = "当前选区无法生成可靠的替换动作；没有修改任何内容。"
    elif app_ctx and app_ctx.app == "word" and wants_word_rewrite(command):
        answer = "没有检测到真实文本选区。请先在 Word 或 WPS 中选中文字，再打开 Magic Pointer。"
    elif app_ctx and (app_ctx.content or "").strip():
        answer = ask_text_model(command, context_text=context_text)
    else:
        target_title = str((target_window or {}).get("title") or "当前应用")
        answer = f"暂时无法从“{target_title}”读取真实选区，因此没有把屏幕内容交给模型，也没有修改任何内容。"

    print(json.dumps({
        "ok": True,
        "prompt": command,
        "answer": answer,
        "selectionContext": None if app_ctx is None else app_ctx.to_dict(),
        "sourceWindow": target_window,
        "actionProposals": action_proposals,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
