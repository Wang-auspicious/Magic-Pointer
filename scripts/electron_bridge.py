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
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
