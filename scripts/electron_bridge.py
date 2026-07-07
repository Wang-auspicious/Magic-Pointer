
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PIL import ImageGrab

from app.ai_client import ask_vision_model
from app.object_store import ObjectStore, PointerObject, new_object_id
from app.screen_context import build_screen_context
from app.task_context import TaskContextStore

CAPTURE_DIR = ROOT / "data" / "captures"
OBJECT_DIR = ROOT / "data" / "objects"
RUNTIME_DIR = ROOT / "data" / "runtime"

ACTION_PROMPTS = {
    "add": "?????????????????????",
    "merge": "???????????????????????",
    "compare": "???????????????????????",
    "explain": "?????",
    "capture": "?????",
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


def _prompt_for(payload: dict[str, Any]) -> str:
    command = str(payload.get("command") or "").strip()
    if command:
        return command
    action = str(payload.get("action") or "capture").strip().lower()
    return ACTION_PROMPTS.get(action, ACTION_PROMPTS["capture"])


def main() -> int:
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    OBJECT_DIR.mkdir(parents=True, exist_ok=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    payload = _read_payload()
    if not payload:
        print(json.dumps({"ok": False, "error": "empty payload"}, ensure_ascii=False))
        return 2

    bbox = _global_bbox(payload)
    if bbox[2] - bbox[0] < 8 or bbox[3] - bbox[1] < 8:
        print(json.dumps({"ok": False, "error": "bbox too small", "bbox": bbox}, ensure_ascii=False))
        return 2

    obj_id = new_object_id()
    image_path = CAPTURE_DIR / f"{obj_id}.png"
    image = ImageGrab.grab(bbox=bbox, all_screens=True)
    image.save(image_path)

    prompt = _prompt_for(payload)
    screen_ctx = build_screen_context(bbox, image_path)
    tasks = TaskContextStore(OBJECT_DIR)
    store = ObjectStore(OBJECT_DIR)
    task_result = tasks.active_task(auto_rollover=True)
    task_id = str(task_result.task.get("id"))

    context = (
        "This request comes from the Electron Magic Pointer overlay. "
        "The user swept/circled the on-screen object with a blue pointer trail. "
        "Treat the captured region as THIS/current object. Reply as a concise action card, not a long chat.\n\n"
        + screen_ctx.to_prompt_context()
        + "\n\n"
        + tasks.build_reference_context(store, task_id, obj_id, bbox)
    )

    answer = ask_vision_model(
        image_path,
        prompt,
        context_text=context,
        labeled_extra_images=[("IMAGE A2 / THIS_OBJECT_MAP / current annotated map", screen_ctx.annotated_image_path)] if screen_ctx.annotated_image_path else None,
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
            "annotated_image_path": str(screen_ctx.annotated_image_path.relative_to(ROOT)) if screen_ctx.annotated_image_path else None,
            "windows": [w.__dict__ for w in screen_ctx.windows],
            "electron_payload": {
                "action": payload.get("action"),
                "bbox": payload.get("bbox"),
                "points_count": len(payload.get("points") or []),
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
        "bbox": bbox,
        "prompt": prompt,
        "answer": answer,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
