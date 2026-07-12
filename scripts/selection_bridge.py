from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.actions.history import ActionHistoryStore, make_word_undo_proposal
from app.actions.office import clean_replacement_text, make_word_replace_selection_proposal, wants_word_rewrite
from app.actions.shopping_list import make_shopping_list_add_proposal, wants_shopping_list_add
from app.actions.calendar_draft import parse_calendar_draft, wants_calendar_draft
from app.actions.route_draft import parse_route_draft, wants_route_draft
from app.adapters import AdapterReadContext, default_adapter_registry, format_adapter_context
from app.ai_client import ask_text_model
from app.actions.draft_delivery import DraftDeliveryError, make_draft_delivery_proposal
from app.review import ReviewSessionError, ReviewSessionStore, compile_review_prompt, write_prompt_artifact
from app.system_context import list_visible_windows

MAGIC_WINDOW_MARKERS = ("Magic Pointer", "Electron Overlay")
REVIEW_RECORD_PREFIXES = ("验收：", "验收:", "记录问题：", "记录问题:", "批注：", "批注:", "review:")
REVIEW_COMPILE_COMMANDS = ("整理验收意见", "生成改进提示词", "compile review")
REVIEW_DELIVERY_COMMANDS = ("把验收意见填到这里", "填入这里", "写到这个输入框", "deliver review here")


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
    return any(token in normalized for token in ("undo", "restore", "revert", "\u64a4\u56de", "\u64a4\u9500", "\u8fd8\u539f"))


def _review_instruction(command: str) -> str | None:
    value = str(command or "").strip()
    lowered = value.lower()
    for prefix in REVIEW_RECORD_PREFIXES:
        if lowered.startswith(prefix.lower()):
            return value[len(prefix):].strip()
    return None


def _wants_review_compile(command: str) -> bool:
    value = str(command or "").strip().lower()
    return any(token in value for token in REVIEW_COMPILE_COMMANDS)


def _wants_review_delivery(command: str) -> bool:
    value = str(command or "").strip().lower()
    return any(token in value for token in REVIEW_DELIVERY_COMMANDS)


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


def _interaction_episode_context(payload: Any) -> str:
    if not isinstance(payload, dict) or payload.get("version") != 1:
        return ""
    slots = payload.get("slots")
    if not isinstance(slots, dict):
        return ""
    lines = [
        "Interaction episode v1:",
        f"episode_id={str(payload.get('episodeId') or '')!r}",
        "Resolve THIS, THAT, THESE, and HERE only from the bound slots below; never infer them from global history.",
    ]

    def append_object(alias: str, item: Any) -> None:
        if not isinstance(item, dict) or not str(item.get("objectId") or "").strip():
            lines.append(f"{alias}: null")
            return
        lines.append(
            f"{alias}: id={str(item.get('objectId'))!r}, app={str(item.get('app') or '')!r}, "
            f"window={str(item.get('windowTitle') or '')!r}, label={str(item.get('label') or '')!r}"
        )
        content = str(item.get("content") or "").strip()
        if content:
            lines.append(f"{alias}_content:\n---\n{content[:12000]}\n---")

    append_object("THIS", slots.get("this"))
    append_object("THAT", slots.get("that"))
    these = slots.get("these")
    if isinstance(these, list) and these:
        for index, item in enumerate(these[:12], 1):
            append_object(f"THESE[{index}]", item)
    else:
        lines.append("THESE: []")
    append_object("HERE", slots.get("here"))
    return "\n".join(lines)


def _read_target_context(windows: list[dict[str, Any]], command: str) -> tuple[dict[str, Any] | None, Any]:
    target_window = windows[0] if windows else None
    if target_window is None:
        return None, None
    registry = default_adapter_registry()
    adapter = registry.matching_adapter(target_window)
    if adapter is None:
        return target_window, None
    return target_window, adapter.read_context(target_window, command=command)


def _parse_timestamp(value: Any) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _context_from_snapshot(
    payload: dict[str, Any],
) -> tuple[dict[str, Any] | None, AdapterReadContext | None, dict[str, Any] | None, str | None]:
    snapshot = payload.get("selectionSnapshot")
    if not isinstance(snapshot, dict):
        return None, None, None, "missing selection snapshot"
    expires_at = _parse_timestamp(snapshot.get("expires_at"))
    if expires_at is None or expires_at <= datetime.now(timezone.utc):
        return None, None, snapshot, "selection snapshot expired"
    target_window = snapshot.get("source_window")
    if target_window is not None and not isinstance(target_window, dict):
        return None, None, snapshot, "invalid selection source window"
    context_data = snapshot.get("context")
    if context_data is None:
        return dict(target_window or {}), None, snapshot, None
    if not isinstance(context_data, dict):
        return dict(target_window or {}), None, snapshot, "invalid selection context"
    try:
        app_ctx = AdapterReadContext.from_dict(context_data)
    except Exception as exc:
        return dict(target_window or {}), None, snapshot, f"invalid selection context: {type(exc).__name__}: {exc}"
    return dict(target_window or {}), app_ctx, snapshot, None


def _review_response(
    payload: dict[str, Any],
    target_window: dict[str, Any] | None,
    snapshot: dict[str, Any] | None,
) -> dict[str, Any] | None:
    command = str(payload.get("command") or "").strip()
    instruction = _review_instruction(command)
    wants_delivery = _wants_review_delivery(command)
    wants_compile = _wants_review_compile(command)
    if instruction is None and not wants_delivery and not wants_compile:
        return None
    selection_session_id = str(payload.get("selectionSessionId") or "").strip() or None
    selection_snapshot_id = str((snapshot or {}).get("snapshot_id") or "").strip() or None
    store = ReviewSessionStore()
    try:
        if instruction is not None:
            recorded = store.record(snapshot, instruction)
            anchor = recorded["anchor"]
            location = (
                f"第 {anchor['page_number']} 页"
                if anchor.get("page_number")
                else (anchor.get("document_label") or anchor.get("app") or "当前对象")
            )
            verb = "已记录" if recorded["recorded"] else "这条意见已存在"
            return {
                "ok": True,
                "prompt": command,
                "answer": (
                    f"{verb} · 第 {recorded['anchor_count']} 条 · {location}\n"
                    "继续翻页批注；完成后说“整理验收意见”或在目标输入框说“把验收意见填到这里”。"
                ),
                "actionProposals": [],
                "intentKind": "review_anchor_recorded",
                "reviewSession": {
                    "session_id": recorded["session_id"],
                    "anchor_count": recorded["anchor_count"],
                    "last_anchor": anchor,
                },
                "selectionSessionId": selection_session_id,
                "selectionSnapshotId": selection_snapshot_id,
            }

        active = store.active()
        if active is None or not active.get("anchors"):
            return {
                "ok": False,
                "prompt": command,
                "error": "当前没有验收批注。请先在交付物中选中或指向问题位置，并说“验收：你的意见”。",
                "actionProposals": [],
                "intentKind": "review_draft_delivery" if wants_delivery else "review_prompt_compiled",
                "selectionSessionId": selection_session_id,
                "selectionSnapshotId": selection_snapshot_id,
            }

        prompt = compile_review_prompt(active)
        artifact = write_prompt_artifact(active, prompt)
        if wants_delivery:
            proposal = make_draft_delivery_proposal(
                prompt,
                target_window=target_window or {},
                target_point=payload.get("targetPoint") or (snapshot or {}).get("target_point"),
                review_session_id=str(active.get("session_id") or ""),
                prompt_artifact=str(artifact),
            )
            return {
                "ok": True,
                "prompt": command,
                "answer": f"正在把 {len(active['anchors'])} 条验收意见组成的完整草稿填入目标输入框；不会发送。",
                "actionProposals": [proposal.to_dict()],
                "autoExecuteProposalId": proposal.id,
                "intentKind": "review_draft_delivery",
                "reviewSession": {
                    "session_id": active["session_id"],
                    "anchor_count": len(active["anchors"]),
                },
                "promptArtifact": str(artifact),
                "selectionSessionId": selection_session_id,
                "selectionSnapshotId": selection_snapshot_id,
            }

        return {
            "ok": True,
            "prompt": command,
            "answer": prompt,
            "reviewPrompt": prompt,
            "actionProposals": [],
            "intentKind": "review_prompt_compiled",
            "reviewSession": {
                "session_id": active["session_id"],
                "anchor_count": len(active["anchors"]),
            },
            "promptArtifact": str(artifact),
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }
    except (ReviewSessionError, DraftDeliveryError, ValueError) as exc:
        return {
            "ok": False,
            "prompt": command,
            "error": str(exc),
            "actionProposals": [],
            "intentKind": (
                "review_draft_delivery"
                if wants_delivery
                else ("review_prompt_compiled" if wants_compile else "review_anchor_recorded")
            ),
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }


def _shopping_list_response(
    payload: dict[str, Any],
    target_window: dict[str, Any] | None,
    app_ctx: AdapterReadContext | None,
    snapshot: dict[str, Any] | None,
) -> dict[str, Any] | None:
    command = str(payload.get("command") or "").strip()
    if not wants_shopping_list_add(command):
        return None
    selection_session_id = str(payload.get("selectionSessionId") or "").strip() or None
    selection_snapshot_id = str((snapshot or {}).get("snapshot_id") or "").strip() or None
    if app_ctx is None or not (app_ctx.content or "").strip():
        return {
            "ok": False,
            "prompt": command,
            "answer": "",
            "error": "没有读取到可靠的明确条目，未写入购物清单。",
            "actionProposals": [],
            "intentKind": "shopping_list_add",
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }
    proposal = make_shopping_list_add_proposal(
        app_ctx,
        command=command,
        selection_session_id=selection_session_id,
        selection_snapshot_id=selection_snapshot_id,
    )
    if proposal is None:
        return {
            "ok": False,
            "prompt": command,
            "answer": "",
            "error": "请选择 1—160 个字符、最多两行的明确条目后重试。",
            "actionProposals": [],
            "intentKind": "shopping_list_add",
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }
    return {
        "ok": True,
        "prompt": command,
        "answer": "正在加入购物清单…",
        "selectionContext": app_ctx.to_dict(),
        "sourceWindow": target_window,
        "actionProposals": [proposal.to_dict()],
        "autoExecuteProposalId": proposal.id,
        "intentKind": "shopping_list_add",
        "selectionSessionId": selection_session_id,
        "selectionSnapshotId": selection_snapshot_id,
    }


def _calendar_response(
    payload: dict[str, Any],
    target_window: dict[str, Any] | None,
    app_ctx: AdapterReadContext | None,
    snapshot: dict[str, Any] | None,
) -> dict[str, Any] | None:
    command = str(payload.get("command") or "").strip()
    if not wants_calendar_draft(command):
        return None
    selection_session_id = str(payload.get("selectionSessionId") or "").strip() or None
    selection_snapshot_id = str((snapshot or {}).get("snapshot_id") or "").strip() or None
    if app_ctx is None or not (app_ctx.content or "").strip() or not selection_snapshot_id:
        return {
            "ok": False,
            "prompt": command,
            "error": "没有读取到可靠的活动文本，未创建日历草稿。",
            "actionProposals": [],
            "intentKind": "calendar_event_draft",
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }
    draft = parse_calendar_draft(app_ctx, selection_snapshot_id=selection_snapshot_id)
    return {
        "ok": True,
        "prompt": command,
        "answer": "日历草稿已打开，请核对时间后创建。",
        "selectionContext": app_ctx.to_dict(),
        "sourceWindow": target_window,
        "actionProposals": [],
        "calendarDraft": draft,
        "intentKind": "calendar_event_draft",
        "selectionSessionId": selection_session_id,
        "selectionSnapshotId": selection_snapshot_id,
    }


def _route_response(payload: dict[str, Any]) -> dict[str, Any] | None:
    command = str(payload.get("command") or "").strip()
    if not wants_route_draft(command):
        return None
    draft = parse_route_draft(payload.get("interactionEpisode"))
    selection_session_id = str(payload.get("selectionSessionId") or "").strip() or None
    if draft["missing_fields"]:
        return {
            "ok": False,
            "prompt": command,
            "error": "当前对象会话没有两个可靠地点。请依次选中起点和终点后再规划路线。",
            "actionProposals": [],
            "routeDraft": draft,
            "intentKind": "route_draft",
            "selectionSessionId": selection_session_id,
        }
    return {
        "ok": True,
        "prompt": command,
        "answer": "路线卡已打开，请核对起点和终点。",
        "actionProposals": [],
        "routeDraft": draft,
        "intentKind": "route_draft",
        "selectionSessionId": selection_session_id,
    }


def main() -> int:
    payload = read_payload()
    command = str(payload.get("command") or "").strip()
    selection_session_id = str(payload.get("selectionSessionId") or "").strip()
    if not command:
        print(json.dumps({"ok": False, "error": "missing command"}, ensure_ascii=False))
        return 2

    if _wants_undo(command):
        record = (
            ActionHistoryStore().recent_undoable_for_session(selection_session_id, app="word")
            if selection_session_id
            else None
        )
        if record is None:
            print(json.dumps({
                "ok": False,
                "prompt": command,
                "error": "当前对象会话里没有可撤回的修改。请使用修改结果旁的“撤回”动作。",
                "actionProposals": [],
                "selectionSessionId": selection_session_id or None,
            }, ensure_ascii=False))
            return 1
        proposal = make_word_undo_proposal(record)
        print(json.dumps({
            "ok": True,
            "prompt": command,
            "answer": f"已找到本次对象会话的文档修改：{record.document or 'Word/WPS 文档'}。确认后只恢复这一处修改。",
            "actionProposals": [proposal.to_dict()],
            "selectionSessionId": selection_session_id or None,
            "selectionSnapshotId": record.selection_snapshot_id,
        }, ensure_ascii=False))
        return 0

    target_window, app_ctx, snapshot, snapshot_error = _context_from_snapshot(payload)
    if snapshot_error:
        print(json.dumps({
            "ok": False,
            "prompt": command,
            "error": snapshot_error,
            "actionProposals": [],
            "selectionSessionId": selection_session_id or None,
        }, ensure_ascii=False))
        return 1

    review_response = _review_response(payload, target_window, snapshot)
    if review_response is not None:
        print(json.dumps(review_response, ensure_ascii=False))
        return 0 if review_response.get("ok") is True else 1

    shopping_response = _shopping_list_response(payload, target_window, app_ctx, snapshot)
    if shopping_response is not None:
        print(json.dumps(shopping_response, ensure_ascii=False))
        return 0 if shopping_response.get("ok") is True else 1

    calendar_response = _calendar_response(payload, target_window, app_ctx, snapshot)
    if calendar_response is not None:
        print(json.dumps(calendar_response, ensure_ascii=False))
        return 0 if calendar_response.get("ok") is True else 1

    route_response = _route_response(payload)
    if route_response is not None:
        print(json.dumps(route_response, ensure_ascii=False))
        return 0 if route_response.get("ok") is True else 1

    episode_context = _interaction_episode_context(payload.get("interactionEpisode"))
    context_text = _selection_context_text(app_ctx, target_window)
    if episode_context:
        context_text += "\n\n" + episode_context
    action_proposals = []
    selection_snapshot_id = str((snapshot or {}).get("snapshot_id") or "").strip() or None

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
        proposal = make_word_replace_selection_proposal(
            app_ctx,
            command=command,
            replacement_text=replacement,
            selection_session_id=selection_session_id or None,
            selection_snapshot_id=selection_snapshot_id,
        )
        if proposal is not None:
            action_proposals.append(proposal.to_dict())
            before_preview = str(proposal.parameters.get("expected_text_excerpt") or "")[:700]
            after_preview = str(proposal.parameters.get("replacement_text_excerpt") or "")[:700]
            document = str(proposal.parameters.get("document") or "Word document")
            answer = (
                "已生成当前 THIS 的替换预览。\n"
                f"文档：{document}\n"
                f"替换前：{before_preview}\n"
                f"替换后：{after_preview}\n"
                "确认时会重新校验文档、窗口、选区位置和原文哈希。"
            )
        else:
            answer = "当前 THIS 无法生成可靠的替换动作；没有修改任何内容。"
    elif app_ctx and app_ctx.app == "word" and wants_word_rewrite(command):
        answer = "没有检测到真实文本选区。请先在 Word 或 WPS 中选中文字，再激活 Magic Pointer。"
    elif app_ctx and (app_ctx.content or "").strip():
        answer = ask_text_model(command, context_text=context_text)
    else:
        target_title = str((target_window or {}).get("title") or "当前应用")
        answer = f"暂时无法从“{target_title}”读取可靠对象，因此没有把屏幕内容交给模型，也没有修改任何内容。"

    print(json.dumps({
        "ok": True,
        "prompt": command,
        "answer": answer,
        "selectionContext": None if app_ctx is None else app_ctx.to_dict(),
        "sourceWindow": target_window,
        "actionProposals": action_proposals,
        "selectionSessionId": selection_session_id or None,
        "selectionSnapshotId": selection_snapshot_id,
        "interactionEpisodeId": (payload.get("interactionEpisode") or {}).get("episodeId") if isinstance(payload.get("interactionEpisode"), dict) else None,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
