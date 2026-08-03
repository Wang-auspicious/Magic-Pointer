from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.bridge_progress import PhaseClock
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
from app.fabric.context_packet import build_agent_prompt, write_context_packet_artifact
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


def _crop_roi_for_ocr(
    capture_path: str | Path,
    selection_bbox: Any,
    capture_bbox: Any,
    padding: int = 12,
) -> Path | None:
    """Crop the gesture bbox (+padding) out of the full-screen capture.

    Returns a temporary ROI PNG path, or None when geometry is unusable so the
    caller falls back to the full capture. The full-screen image stays as the
    evidence artifact; only the OCR read is scoped to the user's mark.
    """
    if not selection_bbox or not capture_bbox:
        return None
    try:
        sel_x, sel_y, sel_w, sel_h = (int(round(float(value))) for value in selection_bbox)
        cap_left, cap_top, cap_right, cap_bottom = (int(round(float(value))) for value in capture_bbox)
    except (TypeError, ValueError):
        return None
    if sel_w <= 0 or sel_h <= 0 or cap_right <= cap_left or cap_bottom <= cap_top:
        return None
    capture = Path(capture_path)
    if not capture.is_file():
        return None
    try:
        from PIL import Image

        with Image.open(capture) as image:
            if image.width <= 0 or image.height <= 0:
                return None
            left = max(0, sel_x - cap_left - padding)
            top = max(0, sel_y - cap_top - padding)
            right = min(image.width, sel_x + sel_w - cap_left + padding)
            bottom = min(image.height, sel_y + sel_h - cap_top + padding)
            if right - left < 8 or bottom - top < 8:
                return None
            roi = image.crop((left, top, right, bottom))
            out = capture.with_name(f"{capture.stem}-roi-{uuid.uuid4().hex[:8]}.png")
            roi.save(out, format="PNG")
            return out
    except Exception:
        return None


def _gesture_strokes(gesture: Any) -> list[list[tuple[int, int]]]:
    """Independent stroke polylines in physical screen pixels."""
    if not isinstance(gesture, dict):
        return []
    strokes: list[list[tuple[int, int]]] = []
    for stroke in list(gesture.get("strokes") or [])[:8]:
        raw_points = list(stroke.get("points") or []) if isinstance(stroke, dict) else []
        points: list[tuple[int, int]] = []
        for raw in raw_points[:256]:
            if not isinstance(raw, dict):
                continue
            try:
                points.append((int(round(float(raw.get("x")))), int(round(float(raw.get("y"))))))
            except (TypeError, ValueError):
                continue
        if len(points) >= 2:
            strokes.append(points)
    return strokes


def _segment_hits_rect(
    ax: float,
    ay: float,
    bx: float,
    by: float,
    left: float,
    top: float,
    right: float,
    bottom: float,
) -> bool:
    """True when segment [a,b] intersects the axis-aligned rect (Liang-Barsky)."""

    def inside(x: float, y: float) -> bool:
        return left <= x <= right and top <= y <= bottom

    if inside(ax, ay) or inside(bx, by):
        return True
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return False
    p = [-dx, dx, -dy, dy]
    q = [ax - left, right - ax, ay - top, bottom - ay]
    u1, u2 = 0.0, 1.0
    for pi, qi in zip(p, q):
        if pi == 0:
            if qi < 0:
                return False
        else:
            ratio = qi / pi
            if pi < 0:
                if ratio > u2:
                    return False
                if ratio > u1:
                    u1 = ratio
            else:
                if ratio < u1:
                    return False
                if ratio < u2:
                    u2 = ratio
    return True


def _polyline_hits_rect(
    points: list[tuple[int, int]],
    rect_xywh: list[int] | tuple[int, int, int, int],
    tolerance: float = 8.0,
) -> bool:
    """True when any stroke segment crosses (or tightly covers) the rect."""
    if not points or len(rect_xywh) != 4:
        return False
    try:
        rx, ry, rw, rh = (float(value) for value in rect_xywh)
    except (TypeError, ValueError):
        return False
    if rw <= 0 or rh <= 0:
        return False
    left, top = rx - tolerance, ry - tolerance
    right, bottom = rx + rw + tolerance, ry + rh + tolerance
    for index in range(len(points) - 1):
        ax, ay = points[index]
        bx, by = points[index + 1]
        if _segment_hits_rect(ax, ay, bx, by, left, top, right, bottom):
            return True
    return False


def _stroke_is_closed(points: list[tuple[int, int]], tolerance: float = 26.0) -> bool:
    """A circle/freeform loop closes back near its start (short tails allowed)."""
    if len(points) < 5:
        return False
    ax, ay = points[0]
    bx, by = points[-1]
    return ((ax - bx) ** 2 + (ay - by) ** 2) ** 0.5 <= tolerance


def _block_center_in_region(rect: list[int], region_xywh: list[int], padding: float = 22.0) -> bool:
    try:
        rx, ry, rw, rh = (float(value) for value in rect)
        gx, gy, gw, gh = (float(value) for value in region_xywh)
    except (TypeError, ValueError):
        return True
    if rw <= 0 or rh <= 0 or gw <= 0 or gh <= 0:
        return False
    cx, cy = rx + rw / 2.0, ry + rh / 2.0
    return (
        gx - padding <= cx <= gx + gw + padding
        and gy - padding <= cy <= gy + gh + padding
    )


def _stroke_xywh(points: list[tuple[int, int]]) -> list[int]:
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    if not xs or not ys:
        return [0, 0, 0, 0]
    left, top = min(xs), min(ys)
    return [left, top, max(xs) - left, max(ys) - top]


def _block_overlap_ratio(rect: list[int], region_xywh: list[int]) -> float:
    """Fraction of the text block's own area covered by the mark region."""
    try:
        rx, ry, rw, rh = (float(value) for value in rect)
        gx, gy, gw, gh = (float(value) for value in region_xywh)
    except (TypeError, ValueError):
        return 0.0
    if rw <= 0 or rh <= 0 or gw <= 0 or gh <= 0:
        return 0.0
    inter_w = max(0.0, min(rx + rw, gx + gw) - max(rx, gx))
    inter_h = max(0.0, min(ry + rh, gy + gh) - max(ry, gy))
    return (inter_w * inter_h) / (rw * rh)


def _sort_blocks_reading_order(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Top-to-bottom, then left-to-right, using a row bucket so lines on the
    same visual row keep their horizontal order instead of jumping around."""
    return sorted(
        blocks,
        key=lambda block: (
            round(int(block.get("rect")[1]) / 22.0) if isinstance(block.get("rect"), (list, tuple)) and len(block.get("rect")) == 4 else 0,
            block.get("rect")[0] if isinstance(block.get("rect"), (list, tuple)) and len(block.get("rect")) == 4 else 0,
        ),
    )


def _filter_ocr_blocks_by_strokes(
    blocks: list[dict[str, Any]],
    strokes: list[list[tuple[int, int]]],
) -> tuple[list[dict[str, Any]], list[list[dict[str, Any]]]]:
    """Keep only OCR text blocks a stroke actually crosses.

    The user's mark is the stroke polyline itself (underline / strike-through
    semantics), not the min-max bounding box of all strokes, which would pull
    in everything between independent lines. Returns (selected, segments) where
    each segment holds the blocks hit by one stroke.
    """
    if not blocks or not strokes:
        return list(blocks), [list(blocks)]
    selected: list[dict[str, Any]] = []
    segments: list[list[dict[str, Any]]] = []
    seen_keys: set[str] = set()
    for stroke in strokes:
        closed = _stroke_is_closed(stroke)
        region = _stroke_xywh(stroke)
        segment_blocks: list[dict[str, Any]] = []
        for block in blocks:
            rect = block.get("rect")
            if not isinstance(rect, (list, tuple)) or len(rect) != 4:
                continue
            if closed:
                # Loop/selection-box semantics: any block whose center (or the
                # bulk of its area) falls inside the marked region counts, so
                # nested cards / middle lines are never dropped. A 30%+ area
                # overlap snaps the block in whole (hand-drawn loops rarely
                # cover a card perfectly).
                if (
                    not _block_center_in_region(list(rect), region)
                    and _block_overlap_ratio(list(rect), region) <= 0.30
                ):
                    continue
            else:
                # Underline/strike semantics: the line must actually cross the
                # block, or cover a substantial part of it (edge tolerance).
                if (
                    not _polyline_hits_rect(stroke, list(rect))
                    and _block_overlap_ratio(list(rect), region) <= 0.30
                ):
                    continue
            key = json.dumps(block, ensure_ascii=False, sort_keys=True)
            if key not in seen_keys:
                seen_keys.add(key)
                selected.append(block)
            segment_blocks.append(block)
        if segment_blocks:
            segments.append(_sort_blocks_reading_order(segment_blocks))
    if not selected:
        return [], []
    return _sort_blocks_reading_order(selected), segments


def _read_local_ocr_boxes(
    capture_path: str | Path,
    *,
    strokes_local: list[list[tuple[int, int]]] | None = None,
    selection_local: list[int] | None = None,
) -> tuple[list[dict[str, Any]], str] | None:
    worker_result = _ocr_worker_request(
        capture_path,
        strokes_local=strokes_local,
        selection_local=selection_local,
    )
    if worker_result is not None:
        return worker_result
    return _read_local_ocr_boxes_full(capture_path)


def _read_local_ocr_boxes_full(
    capture_path: str | Path,
) -> tuple[list[dict[str, Any]], str] | None:
    """Run local OCR over the FULL capture and return per-text-block boxes.

    The screen is read as a whole (full-context recognition, like clicky and
    UFO²); the caller filters blocks by the user's mark afterwards. Returns
    None when OCR produced nothing usable.
    """
    path = Path(capture_path)
    if not path.is_file():
        return None
    blocks: list[dict[str, Any]] = []
    try:
        import numpy as np

        result = _get_rapid_ocr()(str(path))
        txts = list(result.txts or ())
        boxes_arr = np.asarray(result.boxes) if getattr(result, "boxes", None) is not None else None
        scores = getattr(result, "scores", None)
        score_values: list[float] = []
        if scores is not None:
            try:
                score_values = [float(item) for item in list(scores)]
            except (TypeError, ValueError):
                score_values = []
        for index, raw_text in enumerate(txts):
            text = str(raw_text or "").strip()
            if not text:
                continue
            block: dict[str, Any] = {"text": text, "rect": None, "conf": None}
            if index < len(score_values):
                block["conf"] = score_values[index]
            if boxes_arr is not None and boxes_arr.ndim == 3 and index < boxes_arr.shape[0]:
                box = boxes_arr[index].tolist()
                try:
                    xs = [float(point[0]) for point in box]
                    ys = [float(point[1]) for point in box]
                    if xs and ys:
                        block["rect"] = [
                            int(round(min(xs))),
                            int(round(min(ys))),
                            int(round(max(xs) - min(xs))),
                            int(round(max(ys) - min(ys))),
                        ]
                except (TypeError, ValueError, IndexError):
                    pass
            blocks.append(block)
        if blocks:
            return blocks, "rapidocr-onnx"
    except Exception:
        pass
    # Tesseract fallback has no per-block geometry; return the whole text as a
    # single unfilterable block so the read still succeeds.
    try:
        executor = FabricExecutors(root=ROOT)
        text = str(executor._default_ocr(path) or "").strip()
        if text:
            return [{"text": text, "rect": None, "conf": None}], str(
                executor.last_ocr_engine or "tesseract"
            )
    except Exception:
        pass
    return None


def _filter_ocr_blocks_by_bbox(
    blocks: list[dict[str, Any]],
    selection_bbox: Any,
    *,
    padding: int = 8,
) -> list[dict[str, Any]]:
    """Keep only OCR text blocks overlapping the user's mark.

    Full-screen OCR still runs; this scopes what the model receives to the
    marked region without cropping the image (the whole screen is recognized).
    """
    if not blocks or not selection_bbox:
        return list(blocks)
    try:
        sx, sy, sw, sh = (float(value) for value in selection_bbox)
    except (TypeError, ValueError):
        return list(blocks)
    left, top = sx - padding, sy - padding
    right, bottom = sx + sw + padding, sy + sh + padding
    kept: list[dict[str, Any]] = []
    for block in blocks:
        rect = block.get("rect")
        if not isinstance(rect, (list, tuple)) or len(rect) != 4:
            kept.append(block)
            continue
        try:
            bx, by, bw, bh = (float(value) for value in rect)
        except (TypeError, ValueError):
            kept.append(block)
            continue
        if bw <= 0 or bh <= 0:
            continue
        # Axis-aligned overlap with the (inflated) mark region.
        if bx < right and bx + bw > left and by < bottom and by + bh > top:
            kept.append(block)
    return kept


OCR_WORKER_PORT_FILE = ROOT / "data" / "runtime" / "ocr_worker.port"
OCR_WORKER_SCRIPT = ROOT / "scripts" / "ocr_resident_worker.py"


def _ocr_worker_connect(timeout: float = 3.0) -> Any:
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        if not OCR_WORKER_PORT_FILE.is_file():
            time.sleep(0.2)
            continue
        try:
            meta = json.loads(OCR_WORKER_PORT_FILE.read_text(encoding="utf-8"))
            port = int(meta.get("port") or 0)
            if port > 0:
                return socket.create_connection(("127.0.0.1", port), timeout=2.0)
        except Exception:
            # The worker may still be writing its port file (or just starting
            # to accept); never delete it here, just retry on the next tick.
            time.sleep(0.2)
    return None


def _spawn_ocr_worker() -> None:
    try:
        subprocess.Popen(
            [sys.executable, str(OCR_WORKER_SCRIPT)],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        pass


def _ocr_worker_request(
    capture_path: str | Path,
    *,
    strokes_local: list[list[tuple[int, int]]] | None = None,
    selection_local: list[int] | None = None,
    timeout: float = 30.0,
) -> tuple[list[dict[str, Any]], str] | None:
    import time

    sock = _ocr_worker_connect(timeout=2.0)
    if sock is None:
        _spawn_ocr_worker()
        sock = _ocr_worker_connect(timeout=15.0)
    if sock is None:
        return None
    try:
        request = {
            "id": 1,
            "path": str(capture_path),
            "strokes_local": [list(stroke) for stroke in (strokes_local or [])],
            "selection_bbox_local": selection_local,
        }
        sock.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
        sock.settimeout(timeout)
        buffer = b""
        while b"\n" not in buffer:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buffer += chunk
        line = buffer.split(b"\n", 1)[0].strip()
        response = json.loads(line.decode("utf-8"))
        if response.get("ok") is True and response.get("blocks") is not None:
            return list(response["blocks"]), str(response.get("engine") or "rapidocr-onnx")
        return None
    except Exception:
        return None
    finally:
        try:
            sock.close()
        except Exception:
            pass


_RAPID_OCR_INSTANCE: Any = None


def _get_rapid_ocr() -> Any:
    """Reuse one RapidOCR engine across calls; model init costs ~9s."""
    global _RAPID_OCR_INSTANCE
    if _RAPID_OCR_INSTANCE is None:
        from rapidocr import RapidOCR

        _RAPID_OCR_INSTANCE = RapidOCR()
    return _RAPID_OCR_INSTANCE


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
    # Full-screen recognition (keeps global context, like clicky / UFO²), then
    # the user's mark filters which recognized blocks reach the model. The mark
    # is the stroke polyline (underline semantics): only blocks a line actually
    # crosses survive, so independent strokes stay independent segments and
    # unrelated screen text (sidebar, thumbnails) never leaks in.
    strokes_screen = _gesture_strokes((snapshot or {}).get("selection_gesture"))
    selection_bbox = (snapshot or {}).get("selection_bbox")
    capture_bbox = (snapshot or {}).get("capture_bbox")
    strokes_local = None
    selection_local = None
    offset_x = offset_y = 0
    if isinstance(capture_bbox, (list, tuple)) and len(capture_bbox) == 4:
        try:
            offset_x, offset_y = int(capture_bbox[0]), int(capture_bbox[1])
        except (TypeError, ValueError):
            offset_x = offset_y = 0
        if strokes_screen:
            strokes_local = [
                [(x - offset_x, y - offset_y) for (x, y) in stroke]
                for stroke in strokes_screen
            ]
        if selection_bbox is not None:
            try:
                selection_local = [
                    int(selection_bbox[0]) - offset_x,
                    int(selection_bbox[1]) - offset_y,
                    int(selection_bbox[2]),
                    int(selection_bbox[3]),
                ]
            except (TypeError, ValueError, IndexError):
                selection_local = None
    read = _read_local_ocr_boxes(
        capture_path,
        strokes_local=strokes_local,
        selection_local=selection_local,
    )
    if not read:
        return app_ctx
    blocks, engine = read
    if offset_x or offset_y:
        mapped_blocks = []
        for block in blocks:
            rect = block.get("rect")
            if isinstance(rect, (list, tuple)) and len(rect) == 4:
                try:
                    block = {
                        **block,
                        "rect": [
                            int(rect[0]) + offset_x,
                            int(rect[1]) + offset_y,
                            int(rect[2]),
                            int(rect[3]),
                        ],
                    }
                except (TypeError, ValueError):
                    pass
            mapped_blocks.append(block)
        blocks = mapped_blocks
    strokes = strokes_screen
    if strokes:
        selected_blocks, segments = _filter_ocr_blocks_by_strokes(blocks, strokes)
        segment_texts = [
            "\n".join(str(block.get("text") or "").strip() for block in segment if str(block.get("text") or "").strip())
            for segment in segments
            if segment
        ]
        segment_texts = [item for item in segment_texts if item]
        if len(segment_texts) > 1:
            text = "\n".join(f"[segment {index}] {item}" for index, item in enumerate(segment_texts, 1))
        else:
            text = "\n".join(segment_texts)
    else:
        selected_blocks = _filter_ocr_blocks_by_bbox(blocks, selection_bbox)
        segments = []
        text = "\n".join(
            str(block.get("text") or "").strip()
            for block in selected_blocks
            if str(block.get("text") or "").strip()
        ).strip()
    if not text:
        return app_ctx
    artifacts = dict(app_ctx.artifacts if app_ctx is not None else {})
    artifacts.update({
        "capture_path": capture_path,
        "annotated_path": str((snapshot or {}).get("annotated_path") or ""),
        "ocr_engine": engine,
        "ocr_full_screen": True,
        "ocr_block_count_total": len(blocks),
        "ocr_block_count_selected": len(selected_blocks),
        "ocr_stroke_filter": bool(strokes),
        "ocr_segment_count": len(segments),
        "ocr_selection_bbox": selection_bbox,
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
    roi_path = _crop_roi_for_ocr(
        image_path,
        (snapshot or {}).get("selection_bbox"),
        (snapshot or {}).get("capture_bbox"),
    )
    if roi_path is not None:
        locator_images.append(("IMAGE B SELECTED ROI / the exact user-marked region", roi_path))
    selection_bbox = (snapshot or {}).get("selection_bbox")
    context_text = _selection_context_text(app_ctx, target_window)
    if selection_bbox:
        context_text += f"\n\nUser-marked target bbox in physical screen pixels: {selection_bbox!r}"
    try:
        return ask_vision_model(
            image_path,
            command,
            context_text=context_text,
            labeled_extra_images=locator_images,
        )
    finally:
        if roi_path is not None:
            try:
                roi_path.unlink(missing_ok=True)
            except OSError:
                pass


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


# The user is watching a bubble while this runs, so the model gets a short
# budget and one attempt. On expiry build_agent_prompt_draft ships the grounded
# prompt instead, which is already complete — the model only rephrases it.
AGENT_PROMPT_MODEL_TIMEOUT_S = 12.0


def _compile_agent_prompt_with_model(instruction: str, grounded_prompt: str) -> str:
    return ask_text_model(
        instruction,
        context_text=grounded_prompt,
        timeout_s=AGENT_PROMPT_MODEL_TIMEOUT_S,
        attempts=1,
        system_prompt=(
            "You compile a desktop task for another coding or productivity Agent. "
            "Return only one directly executable prompt. Preserve every grounded file path, "
            "object reference, evidence boundary, requested verification, and uncertainty. "
            "Do not claim that work has already run and do not add permissions the user did not grant."
        ),
    )


def build_agent_prompt_draft(
    payload: dict[str, Any],
    target_window: dict[str, Any] | None,
    app_ctx: AdapterReadContext | None,
    snapshot: dict[str, Any] | None,
    *,
    engine: FabricEngine | None = None,
    model_compiler: Callable[[str, str], str] | None = None,
    clock: PhaseClock | None = None,
) -> dict[str, Any]:
    def mark(phase: str, **fields: Any) -> None:
        if clock is not None:
            clock.mark(phase, **fields)

    command = str(payload.get("command") or "").strip()
    objects = _fabric_objects(payload, target_window, app_ctx, snapshot)
    mark("fabric_objects", n=len(objects))
    selection_session_id = str(payload.get("selectionSessionId") or "").strip() or None
    selection_snapshot_id = str((snapshot or {}).get("snapshot_id") or "").strip() or None
    if not command or not objects:
        return {
            "ok": False,
            "error": "agent_prompt_context_missing",
            "actionProposals": [],
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }

    active_engine = engine or FabricEngine()
    mark("engine_ready")
    planned = active_engine.plan(
        command,
        objects=objects,
        recipe_id="agent.handoff",
        override_confirmation=True,
        parameters={
            "agent": "codex",
            "cwd": str(payload.get("workspaceRoot") or ROOT),
            "selectionSessionId": selection_session_id or "",
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
        mark("engine_plan", ok=False, err=str(planned.get("error") or "unknown"))
        return {
            "ok": False,
            "error": str(planned.get("error") or "agent_prompt_plan_failed"),
            "actionProposals": [],
            "selectionSessionId": selection_session_id,
            "selectionSnapshotId": selection_snapshot_id,
        }
    mark("engine_plan", ok=True)

    plan = dict(planned.get("plan") or {})
    parameters = dict(plan.get("parameters") or {})
    packet = dict(parameters.get("contextPacket") or {})
    artifact = write_context_packet_artifact(packet, root=active_engine.root)
    grounded_prompt = build_agent_prompt(packet, artifact_path=artifact)
    mark("grounded_prompt", chars=len(grounded_prompt))
    compiler = model_compiler or _compile_agent_prompt_with_model
    candidate = str(compiler(command, grounded_prompt) or "").strip()
    mark("model_compile", chars=len(candidate))
    model_failed = (
        not candidate
        or candidate.startswith("AI 调用失败")
        or len(candidate) > 60_000
    )
    context_prompt = grounded_prompt if model_failed else candidate
    return {
        "ok": True,
        "kind": "agent-prompt-draft",
        "prompt": command,
        "answer": context_prompt,
        "contextPrompt": context_prompt,
        "contextPacket": packet,
        "contextPacketArtifact": str(artifact),
        "generatedBy": "grounded_fallback" if model_failed else "model",
        "modelError": candidate if model_failed and candidate else None,
        "actionProposals": [],
        "intentKind": "agent_prompt_draft",
        "selectionSessionId": selection_session_id,
        "selectionSnapshotId": selection_snapshot_id,
    }


def main() -> int:
    _configure_stdio()
    clock = PhaseClock("selection_bridge")
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
    clock.mark("payload_read", mode=payload.get("requestMode") or "default", cmd_len=len(command))
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
    clock.mark("context_from_snapshot", err=snapshot_error or "none")
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
    clock.mark("enrich_screen_region")

    if payload.get("requestMode") == "agent_prompt":
        prompt_draft = build_agent_prompt_draft(payload, target_window, app_ctx, snapshot, clock=clock)
        clock.total(ok=prompt_draft.get("ok") is True)
        print(json.dumps(prompt_draft, ensure_ascii=False))
        return 0 if prompt_draft.get("ok") is True else 1

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
