from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PIL import Image, ImageDraw, ImageGrab

from app.ai_client import ask_vision_model
from app.object_store import ObjectStore, PointerObject, new_object_id
from app.screen_context import build_screen_context
from app.task_context import TaskContextStore

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


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    return json.loads(raw)


def _global_bbox(payload: dict[str, Any]) -> tuple[int, int, int, int]:
    bbox = payload.get("bbox") or {}
    bounds = payload.get("screenBounds") or {}
    ox = int(bounds.get("x") or 0)
    oy = int(bounds.get("y") or 0)
    pad = int(payload.get("capturePad") or 54)
    x1 = int(float(bbox.get("x1", 0))) + ox - pad
    y1 = int(float(bbox.get("y1", 0))) + oy - pad
    x2 = int(float(bbox.get("x2", x1 + 1))) + ox + pad
    y2 = int(float(bbox.get("y2", y1 + 1))) + oy + pad
    left, right = sorted((x1, x2))
    top, bottom = sorted((y1, y2))
    return left, top, right, bottom


def _global_points(payload: dict[str, Any]) -> list[tuple[int, int]]:
    bounds = payload.get("screenBounds") or {}
    ox = int(bounds.get("x") or 0)
    oy = int(bounds.get("y") or 0)
    out: list[tuple[int, int]] = []
    for p in payload.get("points") or []:
        try:
            out.append((int(float(p.get("x", 0))) + ox, int(float(p.get("y", 0))) + oy))
        except Exception:
            continue
    return out


def _prompt_for(payload: dict[str, Any]) -> str:
    command = str(payload.get("command") or "").strip()
    if command:
        return command
    action = str(payload.get("action") or "capture").strip().lower()
    return ACTION_PROMPTS.get(action, ACTION_PROMPTS["capture"])


def _make_pointer_annotated_image(raw_path: Path, out_path: Path, bbox: tuple[int, int, int, int], points: list[tuple[int, int]]) -> Path:
    """Create a model-facing image that shows the user's actual pointer stroke.

    The raw bbox is only a transport/capture rectangle. The blue stroke is the
    semantic selection signal. Giving the model this image avoids the previous
    failure mode where it described unrelated UI inside the outer rectangle.
    """

    with Image.open(raw_path).convert("RGBA") as base:
        if len(points) >= 2:
            local = [(x - bbox[0], y - bbox[1]) for x, y in points]
            overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(overlay)
            # Soft approximation: broad transparent blue, medium body, bright core.
            draw.line(local, fill=(96, 165, 250, 70), width=44, joint="curve")
            draw.line(local, fill=(59, 130, 246, 115), width=24, joint="curve")
            draw.line(local, fill=(37, 99, 235, 210), width=10, joint="curve")
            draw.line(local, fill=(220, 238, 255, 240), width=3, joint="curve")
            # Mark the final cursor tip subtly so the model can infer direction.
            ex, ey = local[-1]
            arrow = [(ex, ey), (ex + 22, ey + 10), (ex + 11, ey + 15), (ex + 16, ey + 30), (ex + 8, ey + 33), (ex + 2, ey + 17)]
            draw.polygon(arrow, fill=(255, 255, 255, 245), outline=(37, 99, 235, 255))
            base = Image.alpha_composite(base, overlay)
        base.convert("RGB").save(out_path, quality=92)
    return out_path




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

    bbox = _global_bbox(payload)
    if bbox[2] - bbox[0] < 8 or bbox[3] - bbox[1] < 8:
        print(json.dumps({"ok": False, "error": "bbox too small", "bbox": bbox}, ensure_ascii=True))
        return 2

    obj_id = new_object_id()
    image_path = CAPTURE_DIR / f"{obj_id}.png"
    pointer_image_path = CAPTURE_DIR / f"{obj_id}.pointer.png"
    image = ImageGrab.grab(bbox=bbox, all_screens=True)
    image.save(image_path)

    stroke_points = _global_points(payload)
    model_image_path = _make_pointer_annotated_image(image_path, pointer_image_path, bbox, stroke_points)
    row_candidates = _estimate_row_candidates(image_path, bbox)
    stroke_candidates = _score_stroke_candidates(stroke_points, bbox, row_candidates)
    candidate_text = _candidate_context(stroke_candidates)

    prompt = _prompt_for(payload)
    screen_ctx = build_screen_context(bbox, image_path)
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
        + ("\n\n" + candidate_text if candidate_text else "")
        + "\n\n"
        + tasks.build_reference_context(store, task_id, obj_id, bbox)
    )

    answer = ask_vision_model(
        model_image_path,
        prompt,
        context_text=context,
        labeled_extra_images=[("IMAGE RAW / raw crop without pointer stroke", image_path)],
    )

    obj = PointerObject(
        id=obj_id,
        alias="this",
        kind="electron_pointer_sweep",
        bbox=bbox,
        image_path=str(image_path.relative_to(ROOT)),
        app_title=str(payload.get("sourceApp") or "Electron Overlay"),
        prompt=prompt,
        answer=answer,
        created_at=datetime.now().isoformat(timespec="seconds"),
        screen_context={
            "selection_bbox": screen_ctx.selection_bbox,
            "pointer_annotated_image_path": str(pointer_image_path.relative_to(ROOT)),
            "annotated_image_path": str(screen_ctx.annotated_image_path.relative_to(ROOT)) if screen_ctx.annotated_image_path else None,
            "windows": [w.__dict__ for w in screen_ctx.windows],
            "electron_payload": {
                "action": payload.get("action"),
                "bbox": payload.get("bbox"),
                "points_count": len(stroke_points),
                "stroke_candidates": stroke_candidates[:5],
            },
        },
    )
    store.append(obj)
    updated_task = tasks.add_interaction(task_id, obj.id, prompt, answer)

    print(json.dumps({
        "ok": True,
        "objectId": obj.id,
        "taskId": updated_task.get("id"),
        "imagePath": str(image_path.relative_to(ROOT)),
        "pointerImagePath": str(pointer_image_path.relative_to(ROOT)),
        "bbox": bbox,
        "prompt": prompt,
        "answer": answer,
        "strokeCandidates": stroke_candidates[:5],
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
