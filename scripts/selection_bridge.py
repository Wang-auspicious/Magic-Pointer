from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.actions.history import ActionHistoryStore, make_word_undo_proposal
from app.actions.office import clean_replacement_text, make_word_replace_selection_proposal, wants_word_rewrite
from app.actions.shopping_list import (
    make_shopping_list_add_many_proposal,
    make_shopping_list_add_proposal,
    wants_shopping_list_add,
)
from app.actions.calendar_draft import parse_calendar_draft, wants_calendar_draft
from app.actions.route_draft import parse_route_draft, wants_route_draft
from app.adapters import AdapterReadContext, default_adapter_registry, format_adapter_context
from app.ai_client import ask_text_model, ask_vision_model
from app.actions.draft_delivery import (
    DraftDeliveryError,
    make_draft_delivery_proposal,
    make_prompt_delivery_proposal,
)
from app.context_pack import (
    ContextIntentKind,
    ContextSessionConflict,
    ContextSessionError,
    ContextSessionStore,
    build_context_capture_policy,
    compile_context_prompt,
    detect_agent_profile,
    parse_context_intent,
    write_context_prompt_artifact,
)
from app.review import ReviewSessionError, ReviewSessionStore, compile_review_prompt, write_prompt_artifact
from app.system_context import list_visible_windows
from app.fabric.action import make_fabric_action_proposal
from app.fabric.workflow_task_store import WorkflowTaskStore
from app.fabric.catalog import get_recipe
from app.fabric.engine import FabricEngine
from app.fabric.executors import FabricExecutors
from app.fabric.settings import SettingsStore
from scripts._bridge_common import (
    PayloadTooLargeError,
    read_bounded_json_payload,
)


def _configure_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


MAGIC_WINDOW_MARKERS = ("Magic Pointer", "Electron Overlay")
REVIEW_RECORD_PREFIXES = ("验收：", "验收:", "记录问题：", "记录问题:", "批注：", "批注:", "review:")
REVIEW_COMPILE_COMMANDS = ("整理验收意见", "生成改进提示词", "compile review")
REVIEW_DELIVERY_COMMANDS = ("把验收意见填到这里", "填入这里", "写到这个输入框", "deliver review here")


def _capture_settings():
    """Read the complete capture policy; fail closed if settings are unreadable."""
    settings_path = (
        Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime")
        / "fabric-settings.json"
    )
    try:
        return SettingsStore(settings_path).load()
    except Exception:
        from app.fabric.settings import FabricSettings

        return FabricSettings.defaults()


def read_payload() -> dict[str, Any]:
    return read_bounded_json_payload()


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


def _reference_label_response(payload: dict[str, Any]) -> dict[str, Any] | None:
    command = str(payload.get("command") or "").strip()
    match = re.search(
        r"(?:这是|这个是|标记为|标为|叫做)\s*([A-Z])(?:\b|$)|"
        r"\b(?:label|mark(?:\s+this)?\s+as|this\s+is)\s+([A-Z])\b",
        command,
        re.IGNORECASE,
    )
    if match is None:
        return None
    reference_label = str(match.group(1) or match.group(2) or "").upper()
    episode = payload.get("interactionEpisode")
    episode = dict(episode) if isinstance(episode, dict) else {}
    slots = episode.get("slots")
    slots = dict(slots) if isinstance(slots, dict) else {}
    current = slots.get("this")
    current = dict(current) if isinstance(current, dict) else {}
    object_id = str(current.get("objectId") or "").strip()
    bound_label = str(current.get("referenceLabel") or "").strip().upper()
    labels = episode.get("labels")
    labels = dict(labels) if isinstance(labels, dict) else {}
    if not object_id or bound_label != reference_label or str(labels.get(reference_label) or "") != object_id:
        return {
            "ok": False,
            "prompt": command,
            "error": "reference_label_binding_failed",
            "intentKind": "reference_label_failed",
            "actionProposals": [],
            "selectionSessionId": str(payload.get("selectionSessionId") or "") or None,
        }
    bound_labels = sorted(
        str(label).upper()
        for label, value in labels.items()
        if re.fullmatch(r"[A-Z]", str(label).upper()) and str(value or "").strip()
    )
    return {
        "ok": True,
        "prompt": command,
        "answer": f"已将当前冻结对象标记为 {reference_label}。现有标签：{'、'.join(bound_labels)}。",
        "intentKind": "reference_label_bound",
        "referenceLabel": reference_label,
        "objectId": object_id,
        "boundLabels": bound_labels,
        "actionProposals": [],
        "selectionSessionId": str(payload.get("selectionSessionId") or "") or None,
        "selectionSnapshotId": str(current.get("snapshotId") or "") or None,
        "interactionEpisodeId": str(episode.get("episodeId") or "") or None,
    }


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
        source = item.get("source")
        if isinstance(source, dict):
            lines.append(
                f"{alias}_source: path={str(source.get('path') or '')!r}, "
                f"url={str(source.get('url') or '')!r}, page={source.get('page')!r}, "
                f"bbox={item.get('bbox')!r}"
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


def _read_local_ocr(capture_path: str | Path) -> tuple[str | None, str]:
    """Read a saved screen capture locally; never uploads the image."""
    path = Path(capture_path)
    if not path.is_file():
        return None, "capture_missing"
    try:
        executor = FabricExecutors(root=ROOT)
        text = str(executor._default_ocr(path) or "").strip()
        if not text:
            return None, "ocr_empty"
        return text, str(executor.last_ocr_engine or "local_ocr")
    except Exception as exc:
        return None, f"ocr_failed:{type(exc).__name__}"


def _enrich_screen_region_context(
    target_window: dict[str, Any] | None,
    app_ctx: AdapterReadContext | None,
    snapshot: dict[str, Any] | None,
) -> AdapterReadContext | None:
    """Attach local OCR text to a pixel fallback before any model routing."""
    if str((snapshot or {}).get("source_kind") or "") != "screen_region":
        return app_ctx
    # A screen fallback always carries capture paths in artifacts. Those are
    # evidence pointers, not semantic content; OCR must still run when the
    # actual text field is empty.
    if app_ctx is not None and str(app_ctx.content or "").strip():
        return app_ctx
    capture_path = str((snapshot or {}).get("capture_path") or "").strip()
    if not capture_path:
        return app_ctx
    text, engine = _read_local_ocr(capture_path)
    if not text:
        return app_ctx
    artifacts = dict(app_ctx.artifacts if app_ctx is not None else {})
    artifacts.update({
        "capture_path": capture_path,
        "annotated_path": str((snapshot or {}).get("annotated_path") or ""),
        "ocr_engine": engine,
        "perception_trace": (snapshot or {}).get("perception_trace"),
    })
    return AdapterReadContext(
        adapter="local_ocr",
        app="screen",
        window=dict(target_window or {}),
        content=text,
        label="THIS",
        method=f"local:{engine}",
        artifacts=artifacts,
    )


def _screen_region_vision_answer(
    command: str,
    target_window: dict[str, Any] | None,
    app_ctx: AdapterReadContext | None,
    snapshot: dict[str, Any] | None,
) -> str | None:
    """Use the configured visual model only after an explicit upload opt-in."""
    if _capture_settings().privacy.upload_screenshots is not True:
        return None
    image_path = Path(str((snapshot or {}).get("capture_path") or "").strip())
    if not image_path.is_file():
        return None
    locator_path = Path(str((snapshot or {}).get("annotated_path") or "").strip())
    locator_images = [
        ("IMAGE A LOCATOR / user-marked target", locator_path)
    ] if locator_path.is_file() else []
    selection_bbox = (snapshot or {}).get("selection_bbox")
    context_text = _selection_context_text(app_ctx, target_window)
    if selection_bbox:
        context_text += f"\n\nUser-marked target bbox in physical screen pixels: {selection_bbox!r}"
    return ask_vision_model(
        image_path,
        command,
        context_text=context_text,
        labeled_extra_images=locator_images,
    )


def _context_pack_response(
    payload: dict[str, Any],
    target_window: dict[str, Any] | None,
    snapshot: dict[str, Any] | None,
    *,
    store: ContextSessionStore | None = None,
    review_store: Any | None = None,
    artifact_root: Path | str | None = None,
    allow_screenshot_upload: bool | None = None,
) -> dict[str, Any] | None:
    command = str(payload.get("command") or "").strip()
    intent = parse_context_intent(command)
    if intent is None:
        return None
    active_store = store or ContextSessionStore()
    selection_session_id = str(payload.get("selectionSessionId") or "").strip() or None
    selection_snapshot_id = str((snapshot or {}).get("snapshot_id") or "").strip() or None
    intent_kind = {
        ContextIntentKind.COLLECT: "context_item_recorded",
        ContextIntentKind.COMPILE: "context_prompt_compiled",
        ContextIntentKind.DELIVER: "context_prompt_delivery",
        ContextIntentKind.CLEAR: "context_clear_confirmation",
    }[intent.kind]

    if intent.kind == ContextIntentKind.CLEAR:
        active = active_store.active()
        return {
            "ok": False,
            "prompt": command,
            "error": (
                f"清空会永久结束当前 {int((active or {}).get('item_count') or 0)} 条上下文会话；"
                "需要在后续确认界面中明确确认，本命令没有删除任何内容。"
            ),
            "requiresConfirmation": True,
            "actionProposals": [],
            "intentKind": intent_kind,
            "contextSession": active,
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }

    try:
        if intent.kind == ContextIntentKind.COLLECT:
            if not intent.instruction:
                return {
                    "ok": False,
                    "prompt": command,
                    "error": "请在“收集：”后补充一句这个对象是什么、为什么重要或希望 Agent 如何使用它。",
                    "actionProposals": [],
                    "intentKind": intent_kind,
                    "selectionSessionId": selection_session_id,
                    "selectionSnapshotId": selection_snapshot_id,
                }
            recorded = active_store.record_native(snapshot, intent.instruction)
            item = recorded["item"]
            source = item.get("source") if isinstance(item.get("source"), dict) else {}
            location = source.get("document_label") or (source.get("window") or {}).get("title") or "当前对象"
            verb = "已收集" if recorded["recorded"] else "这条上下文已存在"
            return {
                "ok": True,
                "prompt": command,
                "answer": (
                    f"{verb} · {recorded['item_count']} 条 · {location}\n"
                    "继续选择并说“收集：…”，完成后说“生成提示词：最终任务”或在 Agent 输入框说“发送到这里：最终任务”。"
                ),
                "actionProposals": [],
                "intentKind": intent_kind,
                "contextSession": {
                    "session_id": recorded["session_id"],
                    "item_count": recorded["item_count"],
                    "last_item": item,
                },
                "selectionSessionId": selection_session_id,
                "selectionSnapshotId": selection_snapshot_id,
            }

        active = active_store.active()
        if active is None or not active.get("items"):
            if intent.kind == ContextIntentKind.DELIVER and command.casefold() == "填入这里":
                return None
            return {
                "ok": False,
                "prompt": command,
                "error": "当前没有已收集的上下文。请先选中或指向对象，并说“收集：这个对象如何用于后续任务”。",
                "actionProposals": [],
                "intentKind": intent_kind,
                "selectionSessionId": selection_session_id,
                "selectionSnapshotId": selection_snapshot_id,
            }

        if intent.kind == ContextIntentKind.DELIVER and command.casefold() == "填入这里":
            active_review = (review_store or ReviewSessionStore()).active()
            if isinstance(active_review, dict) and (
                active_review.get("anchors") or active_review.get("anchor_count")
            ):
                return {
                    "ok": False,
                    "prompt": command,
                    "error": (
                        "同时存在通用 Context Pack 和验收会话。请明确说“发送到这里”"
                        "或“把验收意见填到这里”，本次没有写入任何输入框。"
                    ),
                    "actionProposals": [],
                    "intentKind": intent_kind,
                    "selectionSessionId": selection_session_id,
                    "selectionSnapshotId": selection_snapshot_id,
                }

        target_profile = detect_agent_profile(target_window or {})
        capture_settings = _capture_settings() if allow_screenshot_upload is None else None
        for attempt in range(3):
            active = active_store.active()
            if active is None or not active.get("items"):
                raise ContextSessionError("there is no active context session")
            task_instruction = intent.instruction or str(active.get("task_instruction") or "")
            prompt = compile_context_prompt(
                active,
                task_instruction=task_instruction,
                target_profile=target_profile,
                allow_screenshot_upload=bool(allow_screenshot_upload),
                capture_policy=(
                    build_context_capture_policy(capture_settings)
                    if capture_settings is not None
                    else None
                ),
            )
            artifact = write_context_prompt_artifact(active, prompt, root=artifact_root)
            try:
                updated = active_store.save_compilation(
                    task_instruction=task_instruction,
                    target_profile=str(target_profile["id"]),
                    prompt=prompt,
                    prompt_artifact=str(artifact),
                    expected_session_id=str(active["session_id"]),
                    expected_revision=int(active["store_revision"]),
                    expected_items_digest=str(active["items_digest"]),
                )
                break
            except ContextSessionConflict:
                if attempt == 2:
                    raise
        context_summary = {
            "session_id": updated["session_id"],
            "item_count": updated["item_count"],
            "task_instruction": updated.get("task_instruction") or "",
            "target_profile": updated.get("target_profile") or "generic",
        }

        if intent.kind == ContextIntentKind.DELIVER:
            proposal = make_prompt_delivery_proposal(
                prompt,
                target_window=target_window or {},
                target_point=payload.get("targetPoint") or (snapshot or {}).get("target_point"),
                target_point_space=(
                    payload.get("targetPointSpace") or (snapshot or {}).get("target_point_space")
                ),
                context_session_id=str(active.get("session_id") or ""),
                prompt_artifact=str(artifact),
                target_profile=str(target_profile["id"]),
                workflow_kind=str(active.get("workflow_kind") or "context_pack"),
            )
            return {
                "ok": True,
                "prompt": command,
                "answer": (
                    f"正在把 {updated['item_count']} 条上下文编译成 {target_profile['label']} prompt 并填入目标输入框；"
                    "尚未发送。"
                ),
                "actionProposals": [proposal.to_dict()],
                "autoExecuteProposalId": proposal.id,
                "intentKind": intent_kind,
                "contextSession": context_summary,
                "promptArtifact": str(artifact),
                "selectionSessionId": selection_session_id,
                "selectionSnapshotId": selection_snapshot_id,
            }

        return {
            "ok": True,
            "prompt": command,
            "answer": prompt,
            "contextPrompt": prompt,
            "actionProposals": [],
            "intentKind": intent_kind,
            "contextSession": context_summary,
            "promptArtifact": str(artifact),
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }
    except (ContextSessionError, DraftDeliveryError, ValueError) as exc:
        return {
            "ok": False,
            "prompt": command,
            "error": str(exc),
            "actionProposals": [],
            "intentKind": intent_kind,
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }


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
                target_point_space=(
                    payload.get("targetPointSpace") or (snapshot or {}).get("target_point_space")
                ),
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


def _shopping_list_episode_response(payload: dict[str, Any]) -> dict[str, Any] | None:
    command = str(payload.get("command") or "").strip()
    episode = payload.get("interactionEpisode")
    if not isinstance(episode, dict) or episode.get("pendingIntent") != "add":
        return None
    slots = episode.get("slots") if isinstance(episode.get("slots"), dict) else {}
    sources = slots.get("these") if isinstance(slots.get("these"), list) else []
    if not sources or not isinstance(slots.get("here"), dict) or not wants_shopping_list_add(command):
        return None
    selection_session_id = str(payload.get("selectionSessionId") or "").strip() or None
    proposal = make_shopping_list_add_many_proposal(
        sources,
        command=command,
        selection_session_id=selection_session_id,
    )
    if proposal is None:
        return {
            "ok": False,
            "prompt": command,
            "error": "The source set did not contain any bounded shopping-list items.",
            "actionProposals": [],
            "intentKind": "shopping_list_add_many",
            "selectionSessionId": selection_session_id,
        }
    return {
        "ok": True,
        "prompt": command,
        "answer": f"Adding {len(proposal.parameters['items'])} grounded items to the shopping list.",
        "actionProposals": [proposal.to_dict()],
        "autoExecuteProposalId": proposal.id,
        "intentKind": "shopping_list_add_many",
        "interactionEpisodeId": str(episode.get("episodeId") or "") or None,
        "selectionSessionId": selection_session_id,
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


_FABRIC_SYSTEM_RECIPES = {
    "activate.wiggle",
    "ground.this",
    "ground.references",
    "voice.short_command",
    "integration.mcp",
    "governance.dashboard",
}


def _fabric_objects(
    payload: dict[str, Any],
    target_window: dict[str, Any] | None,
    app_ctx: AdapterReadContext | None,
    snapshot: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    seen: set[str] = set()

    def append(value: dict[str, Any]) -> None:
        object_id = str(value.get("id") or "").strip()
        if not object_id or object_id in seen:
            return
        seen.add(object_id)
        objects.append(value)

    snapshot_id = str((snapshot or {}).get("snapshot_id") or "").strip()
    episode = payload.get("interactionEpisode")
    slots = episode.get("slots") if isinstance(episode, dict) else None

    def from_episode(item: Any) -> dict[str, Any] | None:
        if not isinstance(item, dict):
            return None
        object_id = str(item.get("objectId") or "").strip()
        if not object_id:
            return None
        source = dict(item.get("source") or {})
        return {
            "id": object_id,
            "referenceLabel": str(item.get("referenceLabel") or "").strip().upper(),
            "kind": str(item.get("kind") or "episode_object"),
            "label": str(item.get("label") or "THAT"),
            "content": str(item.get("content") or ""),
            "bbox": item.get("bbox"),
            "source": {
                **source,
                "app": str(item.get("app") or source.get("app") or ""),
                "title": str(item.get("windowTitle") or source.get("title") or ""),
                "capturedAt": item.get("capturedAt"),
            },
        }

    these = slots.get("these") if isinstance(slots, dict) else None
    command = str(payload.get("command") or "")
    if isinstance(these, list) and len(these) >= 2:
        labels = [
            str(item.get("referenceLabel") or "").strip().upper()
            for item in these
            if isinstance(item, dict) and str(item.get("referenceLabel") or "").strip()
        ]
        mentioned = [
            label for label in labels
            if re.search(rf"(?<![A-Za-z]){re.escape(label)}(?![A-Za-z])", command, re.IGNORECASE)
        ]
        collection_requested = any(token in command.casefold() for token in ("这些", "those", "these", "them", "both")) or len(set(mentioned)) >= 2
        if collection_requested:
            for item in these[:12]:
                value = from_episode(item)
                if value is not None:
                    append(value)
            return objects

    if app_ctx is not None and app_ctx.has_content:
        artifacts = dict(app_ctx.artifacts or {})
        rectangles = artifacts.get("rectangles") or artifacts.get("selection_rectangles") or []
        append({
            "id": snapshot_id or f"selection-{len(objects) + 1}",
            "kind": str((snapshot or {}).get("source_kind") or "native_selection"),
            "label": app_ctx.label or "THIS",
            "content": app_ctx.content or "",
            "bbox": rectangles[0] if isinstance(rectangles, list) and rectangles else None,
            "source": {
                "app": app_ctx.app,
                "title": str((target_window or {}).get("title") or ""),
                "hwnd": (target_window or {}).get("hwnd"),
                "processId": (target_window or {}).get("process_id"),
                "path": artifacts.get("document_path") or artifacts.get("path"),
                "url": artifacts.get("url"),
                "page": artifacts.get("page"),
                "bbox": rectangles[0] if isinstance(rectangles, list) and rectangles else None,
                "fileSha256": artifacts.get("file_sha256"),
                "perceptionTrace": (snapshot or {}).get("perception_trace"),
                "terminalEvidence": artifacts.get("terminal_evidence"),
                "browserContext": artifacts.get("browser_context"),
            },
        })
    elif snapshot_id:
        append({
            "id": snapshot_id,
            "kind": str((snapshot or {}).get("source_kind") or "screen_region"),
            "label": "THIS",
            "content": "",
            "bbox": (snapshot or {}).get("selection_bbox"),
            "source": {
                "app": str((target_window or {}).get("process_name") or ""),
                "title": str((target_window or {}).get("title") or ""),
                "hwnd": (target_window or {}).get("hwnd"),
                "processId": (target_window or {}).get("process_id") or (target_window or {}).get("pid"),
                "path": (snapshot or {}).get("capture_path"),
                "screenshotPath": (snapshot or {}).get("capture_path"),
                "annotatedPath": (snapshot or {}).get("annotated_path"),
                "captureAttestation": (snapshot or {}).get("capture_attestation"),
                "perceptionTrace": (snapshot or {}).get("perception_trace"),
            },
        })

    if isinstance(slots, dict):
        candidates: list[Any] = [slots.get("that"), slots.get("here")]
        if isinstance(slots.get("these"), list):
            candidates.extend(slots["these"])
        for item in candidates:
            if not isinstance(item, dict):
                continue
            value = from_episode(item)
            if value is not None:
                append(value)
    return objects


def _fabric_response(
    payload: dict[str, Any],
    target_window: dict[str, Any] | None,
    app_ctx: AdapterReadContext | None,
    snapshot: dict[str, Any] | None,
    *,
    engine: FabricEngine | None = None,
) -> dict[str, Any] | None:
    command = str(payload.get("command") or "").strip()
    if not command:
        return None
    if app_ctx and app_ctx.app == "word" and wants_word_rewrite(command):
        return None
    objects = _fabric_objects(payload, target_window, app_ctx, snapshot)
    active_engine = engine or FabricEngine()
    planned = active_engine.plan(
        command,
        objects=objects,
        parameters={
            "cwd": str(payload.get("workspaceRoot") or ROOT),
            "selectionSessionId": str(payload.get("selectionSessionId") or ""),
            "sessionId": str(payload.get("agentSessionId") or payload.get("targetAgentSessionId") or ""),
            "terminalExcerpt": str(payload.get("terminalExcerpt") or ""),
            "attachments": [
                str(value)
                for value in (
                    (snapshot or {}).get("capture_path"),
                    (snapshot or {}).get("annotated_path"),
                )
                if value
            ],
        },
    )
    if planned.get("ok") is not True:
        return None
    plan = dict(planned["plan"])
    recipe_id = str(plan.get("recipeId") or "")
    if recipe_id in _FABRIC_SYSTEM_RECIPES:
        return None
    recipe = get_recipe(recipe_id)
    provider = str(plan.get("provider") or "")
    if provider.startswith("unavailable:"):
        missing = provider.split(":", 1)[1]
        return {
            "ok": False,
            "prompt": command,
            "answer": f"{recipe.title_zh} 已进入统一 Recipe，但当前机器缺少真实 provider：{missing}。没有执行，也没有伪造结果。",
            "error": missing,
            "intentKind": "fabric_recipe_unavailable",
            "recipe": recipe.to_public_dict(),
            "plan": plan,
            "actionProposals": [],
            "selectionSessionId": str(payload.get("selectionSessionId") or "") or None,
            "selectionSnapshotId": str((snapshot or {}).get("snapshot_id") or "") or None,
        }
    workflow_task = WorkflowTaskStore(active_engine.root / "workflow-tasks").create(
        plan,
        surface="gui",
    )
    proposal = make_fabric_action_proposal(
        plan,
        workflow_task_id=workflow_task["taskId"],
    )
    proposal_dict = proposal.to_dict()
    auto_execute = (
        plan.get("requiresConfirmation") is not True
        and (
            provider == "internal"
            or provider.startswith("artifact.")
            or provider.startswith("local.")
        )
    )
    return {
        "ok": True,
        "prompt": command,
        "answer": f"{recipe.title_zh}：已锁定 {len(objects)} 个对象，provider={provider}。"
        + (" 将直接执行并验证。" if auto_execute else " 请核对动作后确认。"),
        "intentKind": "fabric_recipe",
        "recipe": recipe.to_public_dict(),
        "plan": plan,
        "workflowTask": workflow_task,
        "actionProposals": [proposal_dict],
        "autoExecuteProposalId": proposal.id if auto_execute else None,
        "selectionSessionId": str(payload.get("selectionSessionId") or "") or None,
        "selectionSnapshotId": str((snapshot or {}).get("snapshot_id") or "") or None,
    }


def main() -> int:
    _configure_stdio()
    try:
        payload = read_payload()
    except PayloadTooLargeError as exc:
        print(json.dumps({
            "ok": False,
            "error": "payload_too_large",
            "maxPayloadBytes": exc.max_bytes,
        }, ensure_ascii=False))
        return 2
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

    # Screen fallback remains local-first: OCR enriches the snapshot before
    # any recipe or text-model routing, while the saved image stays local.
    app_ctx = _enrich_screen_region_context(target_window, app_ctx, snapshot)

    reference_response = _reference_label_response(payload)
    if reference_response is not None:
        print(json.dumps(reference_response, ensure_ascii=False))
        return 0 if reference_response.get("ok") is True else 1

    context_response = _context_pack_response(payload, target_window, snapshot)
    if context_response is not None:
        print(json.dumps(context_response, ensure_ascii=False))
        return 0 if context_response.get("ok") is True else 1

    review_response = _review_response(payload, target_window, snapshot)
    if review_response is not None:
        print(json.dumps(review_response, ensure_ascii=False))
        return 0 if review_response.get("ok") is True else 1

    shopping_response = _shopping_list_episode_response(payload)
    if shopping_response is None:
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

    fabric_response = _fabric_response(payload, target_window, app_ctx, snapshot)
    if fabric_response is not None:
        print(json.dumps(fabric_response, ensure_ascii=False))
        return 0 if fabric_response.get("ok") is True else 1

    episode_context = _interaction_episode_context(payload.get("interactionEpisode"))
    context_text = _selection_context_text(app_ctx, target_window)
    if episode_context:
        context_text += "\n\n" + episode_context
    action_proposals = []
    selection_snapshot_id = str((snapshot or {}).get("snapshot_id") or "").strip() or None

    vision_answer = _screen_region_vision_answer(command, target_window, app_ctx, snapshot)

    if vision_answer:
        answer = vision_answer
    elif app_ctx and app_ctx.app == "word" and wants_word_rewrite(command) and (app_ctx.content or "").strip():
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
