from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PIL import Image, ImageGrab

from app.adapters import default_adapter_registry, format_adapter_context
from app.actions.office import clean_replacement_text, make_word_replace_selection_proposal, wants_word_rewrite
from app.ai_client import ask_vision_model
from app.context_pack import (
    ContextIntentKind,
    ContextSessionConflict,
    ContextSessionError,
    ContextSessionStore,
    build_context_capture_policy,
    build_stored_object_capture_policy,
    compile_context_prompt,
    parse_context_intent,
    write_context_prompt_artifact,
)
from app.fabric.settings import SettingsStore
from app.fabric.capture_policy import CaptureDecision, CapturePolicyEngine
from app.fabric.executors import FabricExecutors
from app.object_store import ObjectStore, PointerObject, new_object_id
from app.file_context import format_local_file_context, read_local_file_context, wants_file_content
from app.pointer_operator import MagicPointerOperator, format_grounding_for_prompt, wants_copy_path
from app.screen_context import build_screen_context
from app.task_context import TaskContextStore
from app.grounding.schema import PointerSelection
from app.visual_annotation import make_pointer_annotated_image
from app.system_context import list_visible_windows

CAPTURE_DIR = ROOT / "data" / "captures"
OBJECT_DIR = ROOT / "data" / "objects"
RUNTIME_DIR = ROOT / "data" / "runtime"

ACTION_PROMPTS = {
    "add": "Add the marked item to the relevant target, or turn it into an addable item.",
    "merge": "Merge the marked items into a concise usable result.",
    "compare": "Compare the marked item with the previous object in the current task.",
    "explain": "Explain the marked on-screen item.",
    "capture": "Explain the marked on-screen item.",
    "command": "Explain the marked on-screen item.",
}


def _runtime_issue_mode(payload: dict[str, Any]) -> bool:
    return str(payload.get("workflow") or "").strip() == "runtime_issue"


def _capture_settings():
    """Read the complete capture policy; fail closed if settings are unreadable."""
    settings_path = (
        Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or RUNTIME_DIR)
        / "fabric-settings.json"
    )
    try:
        return SettingsStore(settings_path).load()
    except Exception:
        from app.fabric.settings import FabricSettings

        return FabricSettings.defaults()


def _window_at_point(
    windows: list[dict[str, Any]],
    point: tuple[int, int],
) -> dict[str, Any]:
    px, py = point
    matches: list[dict[str, Any]] = []
    for candidate in windows:
        title = str(candidate.get("title") or "") if isinstance(candidate, dict) else ""
        if title.startswith("Magic Pointer"):
            continue
        bbox = candidate.get("bbox") if isinstance(candidate, dict) else None
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            left, top, right, bottom = (float(value) for value in bbox)
        except (TypeError, ValueError):
            continue
        if left <= px < right and top <= py < bottom:
            matches.append(dict(candidate))
    matches.sort(key=lambda item: int(item.get("z_order") or 1_000_000))
    return matches[0] if matches else {}


def _same_capture_target(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
    if not expected or not actual:
        return False
    expected_pid = int(expected.get("process_id") or expected.get("pid") or 0)
    actual_pid = int(actual.get("process_id") or actual.get("pid") or 0)
    return (
        int(expected.get("hwnd") or 0) == int(actual.get("hwnd") or 0)
        and expected_pid == actual_pid
        and str(expected.get("title") or "") == str(actual.get("title") or "")
    )


def _capture_decision_for_target(
    settings: Any,
    payload: dict[str, Any],
    windows: list[dict[str, Any]],
    point: tuple[int, int],
) -> tuple[dict[str, Any], CaptureDecision]:
    target = _window_at_point(windows, point)
    decision = CapturePolicyEngine(
        settings.privacy.upload_screenshots,
        settings.privacy.default_capture_mode,
        settings.privacy.sensitive_apps,
        settings.privacy.app_capture_modes,
    ).decide({
        "id": "electron-pointer-target",
        "kind": "foreground_window",
        "source": {
            "app": str(payload.get("sourceApp") or ""),
            "processName": str(target.get("process_name") or ""),
            "title": str(target.get("title") or ""),
        },
    })
    return target, decision


def _record_runtime_issue(
    capture: dict[str, Any],
    statement: str,
    *,
    store: ContextSessionStore | None = None,
    artifact_root: Path | str | None = None,
    allow_screenshot_upload: bool | None = None,
) -> dict[str, Any]:
    active_store = store or ContextSessionStore()
    capture_settings = _capture_settings() if allow_screenshot_upload is None else None
    recorded = active_store.record_runtime_visual(capture, statement)
    updated: dict[str, Any] | None = None
    prompt = ""
    artifact: Path | None = None
    for attempt in range(3):
        active = active_store.active()
        if active is None or active.get("workflow_kind") != "runtime_issue":
            raise ContextSessionError("runtime issue session disappeared before compilation")
        task_instruction = str(active.get("task_instruction") or "")
        prompt = compile_context_prompt(
            active,
            task_instruction=task_instruction,
            target_profile="generic",
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
                target_profile="generic",
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
    if updated is None or artifact is None:
        raise ContextSessionError("runtime issue prompt was not compiled")

    role = str(recorded["item"].get("role") or "reference")
    role_text = "待修现场" if role == "issue" else "期望参考"
    answer = (
        f"已记录{role_text} · {updated['item_count']} 条现场证据\n"
        "切到 Agent 输入框，把鼠标放进空白输入区，按 Ctrl+Alt+Enter 填入任务；不会自动发送。"
    )
    if str(recorded["item"].get("vision_error") or ""):
        answer += "\n视觉转译不可用；截图、指针、窗口和结构化现场仍已保留。"
    return {
        "ok": True,
        "answer": answer,
        "intentKind": "runtime_issue_recorded",
        "contextSession": {
            "session_id": updated["session_id"],
            "workflow_kind": updated.get("workflow_kind") or "runtime_issue",
            "item_count": updated["item_count"],
            "task_instruction": updated.get("task_instruction") or "",
            "last_item": recorded["item"],
        },
        "promptArtifact": str(artifact),
        "runtimePrompt": prompt,
        "autoDismissMs": 2600,
        "actionProposals": [],
    }


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().lstrip("\ufeff").strip()
    if not raw:
        return {}
    return json.loads(raw)


def _coord_scale(payload: dict[str, Any]) -> float:
    """Electron renderer sends CSS/DIP coordinates; PIL ImageGrab uses physical pixels.

    On high-DPI Windows this is the difference between the user sweeping a file row
    and the backend cropping the toolbar above it. Prefer Electron display scale;
    fall back to renderer DPR for older payloads.
    """

    try:
        scale = float(payload.get("scaleFactor") or 0)
    except Exception:
        scale = 0.0
    if scale <= 0:
        try:
            scale = float((payload.get("viewport") or {}).get("dpr") or 1.0)
        except Exception:
            scale = 1.0
    return max(0.5, min(4.0, scale))


def _capture_pad_px(payload: dict[str, Any]) -> int:
    # capturePad is expressed in overlay/DIP units. Convert it with the same DPI
    # scale as the pointer coordinates, otherwise the context crop is asymmetric.
    try:
        pad = float(payload.get("capturePad") or 54)
    except Exception:
        pad = 54.0
    return int(round(pad * _coord_scale(payload)))


def _global_bbox(payload: dict[str, Any]) -> tuple[int, int, int, int]:
    bbox = payload.get("bbox") or {}
    bounds = payload.get("screenBounds") or {}
    scale = _coord_scale(payload)
    ox = float(bounds.get("x") or 0)
    oy = float(bounds.get("y") or 0)
    pad = _capture_pad_px(payload)
    x1 = int(round((float(bbox.get("x1", 0)) + ox) * scale)) - pad
    y1 = int(round((float(bbox.get("y1", 0)) + oy) * scale)) - pad
    x2 = int(round((float(bbox.get("x2", bbox.get("x1", 0) + 1)) + ox) * scale)) + pad
    y2 = int(round((float(bbox.get("y2", bbox.get("y1", 0) + 1)) + oy) * scale)) + pad
    left, right = sorted((x1, x2))
    top, bottom = sorted((y1, y2))
    return left, top, right, bottom


def _global_points(payload: dict[str, Any]) -> list[tuple[int, int]]:
    bounds = payload.get("screenBounds") or {}
    scale = _coord_scale(payload)
    ox = float(bounds.get("x") or 0)
    oy = float(bounds.get("y") or 0)
    out: list[tuple[int, int]] = []
    for p in payload.get("points") or []:
        try:
            x = (float(p.get("x", 0)) + ox) * scale
            y = (float(p.get("y", 0)) + oy) * scale
            out.append((int(round(x)), int(round(y))))
        except Exception:
            continue
    return out


def _display_rect_px(payload: dict[str, Any]) -> tuple[int, int, int, int] | None:
    bounds = payload.get("screenBounds") or {}
    try:
        scale = _coord_scale(payload)
        x = int(round(float(bounds.get("x") or 0) * scale))
        y = int(round(float(bounds.get("y") or 0) * scale))
        w = int(round(float(bounds.get("width") or 0) * scale))
        h = int(round(float(bounds.get("height") or 0) * scale))
    except Exception:
        return None
    if w <= 0 or h <= 0:
        return None
    return (x, y, x + w, y + h)


def _expand_capture_bbox(selection_bbox: tuple[int, int, int, int], payload: dict[str, Any]) -> tuple[int, int, int, int]:
    """Use a broader model crop than the exact stroke bbox.

    A Magic Pointer stroke is a semantic target signal, not a screenshot rectangle.
    Tiny filename/word sweeps need surrounding UI context for vision models to read
    the whole row/line reliably. Keep object bbox precise, but send a wider crop.
    """

    x1, y1, x2, y2 = selection_bbox
    scale = _coord_scale(payload)
    w = max(1, x2 - x1)
    h = max(1, y2 - y1)
    cx = (x1 + x2) / 2
    cy = (y1 + y2) / 2
    target_w = max(w + int(round(180 * scale)), int(round(760 * scale)))
    target_h = max(h + int(round(120 * scale)), int(round(220 * scale)))
    left = int(round(cx - target_w / 2))
    top = int(round(cy - target_h / 2))
    right = int(round(cx + target_w / 2))
    bottom = int(round(cy + target_h / 2))

    display = _display_rect_px(payload)
    if display:
        dx1, dy1, dx2, dy2 = display
        # Preserve requested size as much as possible while staying on-screen.
        if left < dx1:
            right += dx1 - left
            left = dx1
        if right > dx2:
            left -= right - dx2
            right = dx2
        if top < dy1:
            bottom += dy1 - top
            top = dy1
        if bottom > dy2:
            top -= bottom - dy2
            bottom = dy2
        left = max(dx1, left)
        top = max(dy1, top)
        right = min(dx2, right)
        bottom = min(dy2, bottom)

    if right - left < 8 or bottom - top < 8:
        return selection_bbox
    return left, top, right, bottom


def _prompt_for(payload: dict[str, Any]) -> str:
    command = str(payload.get("command") or "").strip()
    if command:
        intent = parse_context_intent(command)
        if intent is not None and intent.kind == ContextIntentKind.COLLECT:
            return intent.instruction
        return command
    action = str(payload.get("action") or "capture").strip().lower()
    return ACTION_PROMPTS.get(action, ACTION_PROMPTS["capture"])


def _visual_context_capture(
    *,
    object_id: str,
    payload: dict[str, Any],
    selection_point: tuple[int, int],
    selection_bbox: tuple[int, int, int, int],
    capture_bbox: tuple[int, int, int, int],
    image_path: Path,
    pointer_image_path: Path,
    windows: list[dict[str, Any]],
    grounding: dict[str, Any],
    local_file_context: dict[str, Any] | None,
    app_adapter_context: dict[str, Any] | None,
    vision_observation: str,
    vision_error: str,
    capture_attestation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    px, py = selection_point
    point_hits: list[dict[str, Any]] = []
    for candidate in windows:
        bbox = candidate.get("bbox") if isinstance(candidate, dict) else None
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            left, top, right, bottom = (float(value) for value in bbox)
        except (TypeError, ValueError):
            continue
        if left <= px < right and top <= py < bottom:
            point_hits.append(dict(candidate))
    point_hits.sort(key=lambda item: int(item.get("z_order") or 1_000_000))
    primary_window = point_hits[0] if point_hits else {}
    source_window = ({
        "title": str(primary_window.get("title") or ""),
        "hwnd": int(primary_window.get("hwnd") or 0),
        "process_id": int(primary_window.get("process_id") or primary_window.get("pid") or 0),
        "process_name": str(primary_window.get("process_name") or payload.get("sourceApp") or ""),
        "class_name": str(primary_window.get("class_name") or ""),
    } if primary_window else {})
    return {
        "object_id": str(object_id),
        "captured_at": datetime.now().astimezone().isoformat(timespec="microseconds"),
        "app": str((app_adapter_context or {}).get("app") or payload.get("sourceApp") or "application"),
        "source_window": source_window,
        "source_confidence": "point_hit" if primary_window else "unknown",
        "raw_image_path": str(image_path),
        "pointer_image_path": str(pointer_image_path),
        "point": [int(selection_point[0]), int(selection_point[1])],
        "bbox": [int(value) for value in selection_bbox],
        "capture_bbox": [int(value) for value in capture_bbox],
        "grounding": dict(grounding or {}),
        "file_context": dict(local_file_context or {}),
        "app_context": dict(app_adapter_context or {}),
        "vision_observation": str(vision_observation or ""),
        "vision_error": str(vision_error or ""),
        "capture_attestation": dict(capture_attestation or {}),
    }


def _point_in_polygon(point: tuple[float, float], polygon: list[tuple[int, int]]) -> bool:
    if len(polygon) < 3:
        return False
    x, y = point
    inside = False
    j = len(polygon) - 1
    for i in range(len(polygon)):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / max((yj - yi), 1e-6) + xi):
            inside = not inside
        j = i
    return inside


def _dist_point_to_rect(p: tuple[float, float], r: tuple[int, int, int, int]) -> float:
    x, y = p
    dx = max(r[0] - x, 0, x - r[2])
    dy = max(r[1] - y, 0, y - r[3])
    return (dx * dx + dy * dy) ** 0.5


def _rect_center(r: tuple[int, int, int, int]) -> tuple[float, float]:
    return ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)


def _estimate_row_candidates(raw_path: Path, bbox: tuple[int, int, int, int]) -> list[dict[str, Any]]:
    """Dependency-free row/object candidates for list-like UIs.

    This is not OCR. It finds horizontal bands with enough visual ink, which works
    well for file lists, menus, tables, and document lines. OmniParser/OCR should
    replace this later, but this already gives local stroke-aware grounding.
    """

    import numpy as np

    with Image.open(raw_path).convert("L") as img:
        arr = np.array(img)
    h, w = arr.shape
    # Edge/ink density: text/icons differ from background.
    gx = np.abs(np.diff(arr.astype("int16"), axis=1))
    row_score = gx.mean(axis=1)
    if row_score.max() <= 0:
        return []
    threshold = max(float(row_score.mean() + row_score.std() * 0.55), float(row_score.max() * 0.18))
    active = row_score > threshold
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for i, flag in enumerate(active):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            if i - start >= 5:
                bands.append((start, i))
            start = None
    if start is not None and h - start >= 5:
        bands.append((start, h))

    # Merge close fragments into UI rows.
    merged: list[tuple[int, int]] = []
    for a, b in bands:
        if merged and a - merged[-1][1] <= 10:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))

    candidates: list[dict[str, Any]] = []
    for idx, (a, b) in enumerate(merged, 1):
        if b - a > 95:  # likely large toolbar/panel, not a row
            continue
        # Expand to a comfortable row height so stroke/center tests are stable.
        cy = (a + b) / 2
        row_h = max(28, min(58, (b - a) + 18))
        y1 = int(max(0, cy - row_h / 2))
        y2 = int(min(h, cy + row_h / 2))
        candidates.append({
            "id": f"row_{idx}",
            "kind": "visual_row_candidate",
            "bbox_local": (0, y1, w, y2),
            "bbox_global": (bbox[0], bbox[1] + y1, bbox[2], bbox[1] + y2),
        })
    return candidates[:30]


def _score_stroke_candidates(points: list[tuple[int, int]], bbox: tuple[int, int, int, int], candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not points or not candidates:
        return []
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    stroke_box = (min(xs), min(ys), max(xs), max(ys))
    stroke_center = _rect_center(stroke_box)
    end = points[-1]
    closed = len(points) >= 8 and ((points[0][0] - points[-1][0]) ** 2 + (points[0][1] - points[-1][1]) ** 2) ** 0.5 < max(80, min(stroke_box[2]-stroke_box[0], stroke_box[3]-stroke_box[1]) * 0.35)

    scored: list[dict[str, Any]] = []
    for c in candidates:
        r = c["bbox_global"]
        assert isinstance(r, tuple)
        # How many stroke samples hit the candidate row.
        hits = sum(1 for p in points if r[0] <= p[0] <= r[2] and r[1] <= p[1] <= r[3])
        hit_ratio = hits / max(1, len(points))
        center_dist = _dist_point_to_rect(stroke_center, r)
        end_dist = _dist_point_to_rect(end, r)
        inside = _point_in_polygon(_rect_center(r), points) if closed else False
        score = hit_ratio * 8.0
        if inside:
            score += 4.0
        score += max(0.0, 2.5 - center_dist / 70.0)
        score += max(0.0, 1.8 - end_dist / 60.0)
        # Prefer rows not spanning the very top toolbar if center is lower.
        if r[3] < stroke_box[1] - 20:
            score -= 2.0
        item = dict(c)
        item.update({
            "score": round(score, 3),
            "hit_ratio": round(hit_ratio, 3),
            "center_distance": round(center_dist, 1),
            "end_distance": round(end_dist, 1),
            "inside_closed_stroke": inside,
        })
        scored.append(item)
    scored.sort(key=lambda x: float(x.get("score", 0)), reverse=True)
    return scored[:8]


def _candidate_context(scored: list[dict[str, Any]]) -> str:
    if not scored:
        return ""
    lines = [
        "Local stroke-aware candidate picking:",
        "These are dependency-free visual row candidates scored by the user's blue stroke. Higher score is more likely to be THIS.",
        "Use candidate #1 as THIS unless the image clearly contradicts it.",
    ]
    for i, c in enumerate(scored[:5], 1):
        lines.append(
            f"{i}. id={c.get('id')}, kind={c.get('kind')}, bbox_global={c.get('bbox_global')}, "
            f"score={c.get('score')}, hit_ratio={c.get('hit_ratio')}, "
            f"inside_closed_stroke={c.get('inside_closed_stroke')}, center_distance={c.get('center_distance')}, end_distance={c.get('end_distance')}"
        )
    return "\n".join(lines)

def main() -> int:
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    OBJECT_DIR.mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    payload = _read_payload()
    if not payload:
        print(json.dumps({"ok": False, "error": "empty payload"}, ensure_ascii=True))
        return 2

    runtime_issue_mode = _runtime_issue_mode(payload)
    runtime_statement = str(payload.get("command") or "").strip()
    if runtime_issue_mode and not runtime_statement:
        print(json.dumps({
            "ok": False,
            "error": "请描述你在运行界面中看到的问题或期望效果。",
            "intentKind": "runtime_issue_recorded",
            "actionProposals": [],
        }, ensure_ascii=True))
        return 2
    context_intent = None if runtime_issue_mode else parse_context_intent(runtime_statement)
    if context_intent is not None and context_intent.kind == ContextIntentKind.COLLECT and not context_intent.instruction:
        print(json.dumps({
            "ok": False,
            "error": "请在“收集：”后补充一句这个对象是什么、为什么重要或希望 Agent 如何使用它。",
            "intentKind": "context_item_recorded",
        }, ensure_ascii=True))
        return 2

    selection_bbox = _global_bbox(payload)
    if selection_bbox[2] - selection_bbox[0] < 8 or selection_bbox[3] - selection_bbox[1] < 8:
        print(json.dumps({"ok": False, "error": "bbox too small", "bbox": selection_bbox}, ensure_ascii=True))
        return 2

    stroke_points = _global_points(payload)
    capture_bbox = _expand_capture_bbox(selection_bbox, payload)
    obj_id = new_object_id()
    selection_point = stroke_points[-1] if stroke_points else (
        (selection_bbox[0] + selection_bbox[2]) // 2,
        (selection_bbox[1] + selection_bbox[3]) // 2,
    )
    capture_settings = _capture_settings()
    before_windows = [dict(item) for item in list_visible_windows()]
    policy_target, capture_decision = _capture_decision_for_target(
        capture_settings,
        payload,
        before_windows,
        selection_point,
    )
    if capture_decision.mode == "deny":
        print(json.dumps({
            "ok": False,
            "error": "当前应用已设为永不捕获；未读取结构、未执行 OCR、未创建截图。",
            "capturePolicy": capture_decision.to_dict(),
            "imagePath": None,
            "pointerImagePath": None,
            "actionProposals": [],
        }, ensure_ascii=True))
        return 0
    if not capture_decision.allow_local_pixels:
        structured_selection = PointerSelection(
            id=obj_id,
            point=selection_point,
            bbox=selection_bbox,
            selected_at=datetime.now().isoformat(timespec="seconds"),
            source="electron_overlay",
            metadata={"capture_bbox": capture_bbox},
        )
        structured_context = default_adapter_registry().read_first_context(
            before_windows,
            selection=structured_selection,
            command=_prompt_for(payload),
        )
        print(json.dumps({
            "ok": True,
            "answer": (
                format_adapter_context(structured_context)
                if structured_context is not None
                else "当前应用仅允许 UIA / AX / DOM；未读取到可用结构，未执行 OCR 或截图。"
            ),
            "capturePolicy": capture_decision.to_dict(),
            "imagePath": None,
            "pointerImagePath": None,
            "actionProposals": [],
        }, ensure_ascii=True))
        return 0

    image_path = CAPTURE_DIR / f"{obj_id}.png"
    pointer_image_path = CAPTURE_DIR / f"{obj_id}.pointer.png"
    image = ImageGrab.grab(bbox=capture_bbox, all_screens=True)
    after_windows = [dict(item) for item in list_visible_windows()]
    after_target = next(
        (
            item for item in after_windows
            if int(item.get("hwnd") or 0) == int(policy_target.get("hwnd") or 0)
        ),
        {},
    )
    capture_attestation = {
        "status": "verified" if _same_capture_target(policy_target, after_target) else "target_mismatch",
        "phase": "complete" if _same_capture_target(policy_target, after_target) else "after_capture",
        "expected": policy_target,
        "before": policy_target,
        "after": after_target,
    }
    if capture_attestation["status"] != "verified":
        print(json.dumps({
            "ok": False,
            "error": "目标窗口在截图前后发生变化；未保存或外发任何图像。",
            "captureAttestation": capture_attestation,
            "imagePath": None,
            "pointerImagePath": None,
            "actionProposals": [],
        }, ensure_ascii=True))
        return 0
    image.save(image_path)

    model_image_path = make_pointer_annotated_image(image_path, pointer_image_path, capture_bbox, stroke_points)
    row_candidates = _estimate_row_candidates(image_path, capture_bbox)
    stroke_candidates = _score_stroke_candidates(stroke_points, capture_bbox, row_candidates)
    candidate_text = _candidate_context(stroke_candidates)

    prompt = _prompt_for(payload)
    screen_ctx = build_screen_context(capture_bbox, image_path)
    window_dicts = [w.__dict__ for w in screen_ctx.windows]
    pointer_selection = PointerSelection(
        id=obj_id,
        point=selection_point,
        bbox=selection_bbox,
        selected_at=datetime.now().isoformat(timespec="seconds"),
        source="electron_overlay",
        metadata={
            "capture_bbox": capture_bbox,
            "screen_bounds": payload.get("screenBounds"),
            "scale_factor": _coord_scale(payload),
        },
    )
    pointer_operator = MagicPointerOperator()
    pointer_result = pointer_operator.observe(
        selection=pointer_selection,
        command=prompt,
        windows=window_dicts,
        stroke_points=stroke_points,
        row_candidates=stroke_candidates,
    )
    grounding_text = format_grounding_for_prompt(pointer_result)
    local_file_context = None
    primary_grounded = pointer_result.grounding.primary
    primary_path = str((primary_grounded.metadata or {}).get("path") or "") if primary_grounded else ""
    if primary_path and not wants_copy_path(prompt) and (wants_file_content(prompt) or (primary_grounded and primary_grounded.kind in {"file", "folder", "archive"})):
        local_file_context = read_local_file_context(primary_path)
    local_file_text = format_local_file_context(local_file_context)
    app_adapter_context = default_adapter_registry().read_first_context(window_dicts, selection=pointer_selection, command=prompt)
    app_adapter_text = format_adapter_context(app_adapter_context)
    word_rewrite_mode = bool(
        not runtime_issue_mode
        and context_intent is None
        and
        app_adapter_context
        and app_adapter_context.app == "word"
        and wants_word_rewrite(prompt)
        and (app_adapter_context.content or "").strip()
    )
    tasks = TaskContextStore(OBJECT_DIR)
    store = ObjectStore(OBJECT_DIR)
    task_result = tasks.active_task(auto_rollover=True)
    task_id = str(task_result.task.get("id"))

    context = (
        "This request comes from the Electron Magic Pointer overlay.\n"
        "IMPORTANT: The blue pointer stroke/loop drawn on IMAGE A is the user's semantic selection. "
        "Do NOT treat the rectangular crop as the target. Focus on the item touched, underlined, circled, or enclosed by the blue stroke. "
        "If the crop contains many unrelated UI elements, ignore anything not indicated by the blue stroke. "
        "If the blue stroke encloses multiple candidates, identify the most central/most likely target and mention ambiguity briefly.\n"
        "Reply as a concise action card, not a long chat.\n\n"
        + screen_ctx.to_prompt_context()
        + ("\n\n" + grounding_text if grounding_text else "")
        + ("\n\n" + local_file_text if local_file_text else "")
        + ("\n\n" + app_adapter_text if app_adapter_text else "")
        + ("\n\n" + candidate_text if candidate_text else "")
        + "\n\n"
        + tasks.build_reference_context(
            store,
            task_id,
            obj_id,
            selection_bbox,
            object_policy=build_stored_object_capture_policy(capture_settings),
        )
    )

    if word_rewrite_mode:
        context += (
            "\n\nWord write-back proposal mode:\n"
            "The user is asking to transform the currently selected Word text. "
            "Return ONLY the replacement text that should replace the selection. "
            "Do not add explanations, markdown headings, bullets, quotes, or labels. "
            "The app will show a separate confirmation preview before any write occurs."
        )

    action_proposals = [] if runtime_issue_mode or context_intent is not None else list(pointer_result.proposals)
    vision_error = ""

    if pointer_result.proposals and not runtime_issue_mode:
        answer = '\u5df2\u8bc6\u522b\u5230\u672c\u5730\u6587\u4ef6\u5bf9\u8c61\u3002\u70b9\u51fb\u4e0b\u65b9\u786e\u8ba4\u6309\u94ae\u540e\uff0c\u6211\u4f1a\u628a\u5b8c\u6574\u8def\u5f84\u590d\u5236\u5230\u526a\u8d34\u677f\u3002'
    elif not capture_decision.allow_upload:
        if capture_decision.mode == "local_ocr":
            local_ocr = FabricExecutors(root=RUNTIME_DIR)
            try:
                answer = str(local_ocr.ocr_reader(image_path) or "").strip()
                vision_error = "" if answer else "local_ocr_returned_empty"
            except Exception as exc:
                answer = ""
                vision_error = f"local_ocr_failed:{type(exc).__name__}:{exc}"
        else:
            answer = app_adapter_text or "截图已按逐应用策略仅保留在本机，未发送到模型。"
            vision_error = f"vision_withheld_by_capture_policy:{capture_decision.mode}"
    else:
        try:
            answer = ask_vision_model(
                model_image_path,
                prompt,
                context_text=context,
                labeled_extra_images=[("IMAGE RAW / raw crop without pointer stroke", image_path)],
            )
        except Exception as exc:
            if (
                not runtime_issue_mode
                and (context_intent is None or context_intent.kind != ContextIntentKind.COLLECT)
            ):
                raise
            answer = ""
            vision_error = f"{type(exc).__name__}: {exc}"
        if word_rewrite_mode and app_adapter_context is not None:
            replacement_text = clean_replacement_text(answer)
            word_proposal = make_word_replace_selection_proposal(app_adapter_context, command=prompt, replacement_text=replacement_text)
            if word_proposal is not None:
                action_proposals.append(word_proposal)
                before_preview = str(word_proposal.parameters.get("expected_text_excerpt") or "")[:420]
                after_preview = str(word_proposal.parameters.get("replacement_text_excerpt") or "")[:420]
                document = str(word_proposal.parameters.get("document") or "Word document")
                answer = (
                    "\u5df2\u751f\u6210 Word \u9009\u4e2d\u6587\u672c\u66ff\u6362\u9884\u6848\uff0c\u5c1a\u672a\u5199\u5165\u3002\n"
                    f"\u6587\u6863\uff1a{document}\n"
                    f"\u539f\u6587\u9884\u89c8\uff1a{before_preview}\n"
                    f"\u66ff\u6362\u4e3a\uff1a{after_preview}\n"
                    "\u786e\u8ba4\u540e\u4f1a\u518d\u6b21\u6821\u9a8c\u5f53\u524d Word \u6587\u6863\u548c\u9009\u533a\uff0c\u5339\u914d\u624d\u6267\u884c\uff1b\u6267\u884c\u540e\u4f1a\u7ed9\u51fa\u64a4\u56de\u6309\u94ae\u3002"
                )
        if wants_copy_path(prompt):
            answer = (
                '\u6211\u6ca1\u6709\u5b89\u5168\u62ff\u5230\u8fd9\u4e2a\u6587\u4ef6\u7684\u5b8c\u6574\u8def\u5f84\uff0c\u6240\u4ee5\u6ca1\u6709\u6267\u884c\u3002'
                '\u8fd9\u6b21\u4e0d\u4f1a\u8ba9\u4f60\u81ea\u5df1\u6309\u5feb\u6377\u952e\u5192\u5145\u5b8c\u6210\uff1b\u8bf7\u91cd\u8bd5\u5e76\u5c3d\u91cf\u5212\u4e2d\u6587\u4ef6\u540d/\u6587\u4ef6\u884c\u3002'
            )

    vision_observation = answer
    context_session = None
    context_record_error = ""
    runtime_issue_result: dict[str, Any] | None = None
    if runtime_issue_mode:
        capture = _visual_context_capture(
            object_id=obj_id,
            payload=payload,
            selection_point=selection_point,
            selection_bbox=selection_bbox,
            capture_bbox=capture_bbox,
            image_path=image_path.resolve(),
            pointer_image_path=pointer_image_path.resolve(),
            windows=window_dicts,
            grounding=pointer_result.to_dict(),
            local_file_context=local_file_context.to_dict() if local_file_context else None,
            app_adapter_context=app_adapter_context.to_dict() if app_adapter_context else None,
            vision_observation=vision_observation,
            vision_error=vision_error,
            capture_attestation=capture_attestation,
        )
        try:
            runtime_issue_result = _record_runtime_issue(capture, runtime_statement)
            context_session = runtime_issue_result["contextSession"]
            answer = str(runtime_issue_result["answer"])
        except ContextSessionError as exc:
            context_record_error = str(exc)
            answer = f"未能记录运行现场：{exc}"
    elif context_intent is not None and context_intent.kind == ContextIntentKind.COLLECT:
        capture = _visual_context_capture(
            object_id=obj_id,
            payload=payload,
            selection_point=selection_point,
            selection_bbox=selection_bbox,
            capture_bbox=capture_bbox,
            image_path=image_path.resolve(),
            pointer_image_path=pointer_image_path.resolve(),
            windows=window_dicts,
            grounding=pointer_result.to_dict(),
            local_file_context=local_file_context.to_dict() if local_file_context else None,
            app_adapter_context=app_adapter_context.to_dict() if app_adapter_context else None,
            vision_observation=vision_observation,
            vision_error=vision_error,
            capture_attestation=capture_attestation,
        )
        try:
            recorded = ContextSessionStore().record_visual(capture, context_intent.instruction)
            context_session = {
                "session_id": recorded["session_id"],
                "item_count": recorded["item_count"],
                "last_item": recorded["item"],
            }
            verb = "已收集" if recorded["recorded"] else "这条上下文已存在"
            answer = f"{verb} · {recorded['item_count']} 条 · 视觉对象"
            if vision_error:
                answer += "\n视觉转译暂时失败；截图、指向坐标和结构化来源已经保留。"
            else:
                answer += "\n已保留截图、指向坐标、结构化来源和视觉观察。继续指向，或到 Agent 输入框说“发送到这里：最终任务”。"
        except ContextSessionError as exc:
            context_record_error = str(exc)
            answer = f"未能收集这条视觉上下文：{exc}"

    obj = PointerObject(
        id=obj_id,
        alias="this",
        kind="electron_pointer_sweep",
        bbox=selection_bbox,
        image_path=str(image_path.relative_to(ROOT)),
        app_title=str(payload.get("sourceApp") or "Electron Overlay"),
        prompt=prompt,
        answer=vision_observation or answer,
        created_at=datetime.now().isoformat(timespec="seconds"),
        screen_context={
            "selection_bbox": selection_bbox,
            "capture_bbox": capture_bbox,
            "pointer_annotated_image_path": str(pointer_image_path.relative_to(ROOT)),
            "annotated_image_path": str(screen_ctx.annotated_image_path.relative_to(ROOT)) if screen_ctx.annotated_image_path else None,
            "windows": window_dicts,
            "grounding": pointer_result.to_dict(),
            "local_file_context": local_file_context.to_dict() if local_file_context else None,
            "app_adapter_context": app_adapter_context.to_dict() if app_adapter_context else None,
            "capture_policy": capture_decision.to_dict(),
            "capture_attestation": capture_attestation,
            "electron_payload": {
                "action": payload.get("action"),
                "bbox": payload.get("bbox"),
                "selection_bbox": selection_bbox,
                "capture_bbox": capture_bbox,
                "screenBounds": payload.get("screenBounds"),
                "scaleFactor": _coord_scale(payload),
                "viewport": payload.get("viewport"),
                "points_count": len(stroke_points),
                "stroke_candidates": stroke_candidates[:5],
            },
        },
    )
    store.append(obj)
    updated_task = tasks.add_interaction(task_id, obj.id, prompt, vision_observation or answer)

    print(json.dumps({
        "ok": not bool(context_record_error),
        "objectId": obj.id,
        "taskId": updated_task.get("id"),
        "imagePath": str(image_path.relative_to(ROOT)),
        "pointerImagePath": str(pointer_image_path.relative_to(ROOT)),
        "bbox": selection_bbox,
        "captureBbox": capture_bbox,
        "capturePolicy": capture_decision.to_dict(),
        "captureAttestation": capture_attestation,
        "prompt": prompt,
        "answer": answer,
        "error": context_record_error or None,
        "intentKind": (
            "runtime_issue_recorded"
            if runtime_issue_result is not None
            else ("context_item_recorded" if context_session is not None else None)
        ),
        "contextSession": context_session,
        "promptArtifact": (
            runtime_issue_result.get("promptArtifact")
            if runtime_issue_result is not None
            else None
        ),
        "runtimePrompt": (
            runtime_issue_result.get("runtimePrompt")
            if runtime_issue_result is not None
            else None
        ),
        "autoDismissMs": (
            runtime_issue_result.get("autoDismissMs")
            if runtime_issue_result is not None
            else None
        ),
        "strokeCandidates": stroke_candidates[:5],
        "grounding": pointer_result.to_dict(),
        "localFileContext": local_file_context.to_dict() if local_file_context else None,
        "appAdapterContext": app_adapter_context.to_dict() if app_adapter_context else None,
        "actionProposals": [proposal.to_dict() for proposal in action_proposals],
    }, ensure_ascii=True))
    return 1 if context_record_error else 0


if __name__ == "__main__":
    raise SystemExit(main())
