from __future__ import annotations

from datetime import datetime

from app.context_pack.capture_policy import build_stored_object_capture_policy
from app.fabric.settings import FabricSettings
from app.object_store import ObjectStore, PointerObject
from app.task_context import TaskContextStore


def _object(object_id: str, app: str) -> PointerObject:
    return PointerObject(
        id=object_id,
        alias="this",
        kind="screen_region",
        bbox=(0, 0, 100, 100),
        image_path=f"data/captures/{object_id}.png",
        app_title=app,
        prompt=f"prompt-{object_id}",
        answer="answer",
        created_at="2026-07-27T00:00:00",
        screen_context={"capture_attestation": {"status": "verified"}},
    )


def test_task_reference_context_filters_denied_objects_and_withholds_local_paths(tmp_path) -> None:
    store = ObjectStore(tmp_path)
    tasks = TaskContextStore(tmp_path)
    task = tasks.active_task(now=datetime(2026, 7, 27, 10, 0, 0)).task
    for obj in (
        _object("edge-object", "Microsoft Edge"),
        _object("vault-secret-object", "1Password.exe"),
        _object("figma-local-object", "Figma.exe"),
    ):
        store.append(obj)
        tasks.add_object(task["id"], obj.id)

    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    settings.privacy.app_capture_modes = {
        "edge": "upload_screenshot",
        "1password": "deny",
        "figma": "local_screenshot",
    }
    context = tasks.build_reference_context(
        store,
        task["id"],
        "current",
        (0, 0, 100, 100),
        object_policy=build_stored_object_capture_policy(settings),
    )

    assert "edge-object" in context
    assert "data/captures/edge-object.png" in context
    assert "vault-secret-object" not in context
    assert "figma-local-object" in context
    assert "data/captures/figma-local-object.png" not in context
    assert "image_path='<withheld>'" in context
