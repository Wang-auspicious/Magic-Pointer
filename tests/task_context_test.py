import shutil
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.object_store import ObjectStore, PointerObject
from app.task_context import TaskContextStore


def make_obj(i: int) -> PointerObject:
    return PointerObject(
        id=f"obj_{i}",
        alias="this",
        kind="screen_region",
        bbox=(i, i, i + 10, i + 10),
        image_path=f"data/captures/obj_{i}.png",
        app_title="test",
        prompt=f"prompt {i}",
        answer=f"answer {i}",
        created_at="2026-07-06T00:00:00",
    )


def main() -> None:
    root = Path("data/.task_context_test")
    if root.exists():
        shutil.rmtree(root)
    store = ObjectStore(root)
    tasks = TaskContextStore(root, idle_timeout_minutes=30)

    t0 = datetime(2026, 7, 6, 9, 0, 0)
    first = tasks.active_task(now=t0).task
    assert first["object_ids"] == []

    for i in range(2):
        store.append(make_obj(i))
        tasks.add_interaction(first["id"], f"obj_{i}", f"prompt {i}", f"answer {i}", now=t0 + timedelta(minutes=i))

    ctx = tasks.build_reference_context(store, first["id"], "obj_current", (0, 0, 10, 10))
    assert "Task context v1" in ctx
    assert "obj_1" in ctx
    assert "global history" in ctx
    assert "destination: null" in ctx
    assert [x["id"] for x in tasks.task_objects(store, first["id"])] == ["obj_0", "obj_1"]

    tasks.set_destination(first["id"], "obj_0", now=t0 + timedelta(minutes=3))
    assert tasks.destination_object(store, first["id"])["id"] == "obj_0"
    ctx = tasks.build_reference_context(store, first["id"], "obj_current", (0, 0, 10, 10))
    assert "alias=destination" in ctx
    assert "destination: id='obj_0'" in ctx
    tasks.clear_destination(first["id"], now=t0 + timedelta(minutes=4))
    assert tasks.destination_object(store, first["id"]) is None

    store.append(make_obj(3))
    tasks.add_object(first["id"], "obj_3", now=t0 + timedelta(minutes=5))
    assert [x["id"] for x in tasks.task_objects(store, first["id"])] == ["obj_0", "obj_1", "obj_3"]

    same = tasks.active_task(now=t0 + timedelta(minutes=20)).task
    assert same["id"] == first["id"]

    rolled = tasks.active_task(now=t0 + timedelta(minutes=61))
    assert rolled.rolled_over is True
    assert rolled.task["id"] != first["id"]
    assert rolled.task["object_ids"] == []
    assert tasks.previous_task_id() == first["id"]

    restored = tasks.restore_previous_task(now=t0 + timedelta(minutes=62))
    assert restored is not None
    assert restored["id"] == first["id"]

    new_task = tasks.start_new_task(now=t0 + timedelta(minutes=63))
    assert new_task["id"] != first["id"]

    shutil.rmtree(root)
    print("task context test ok")


if __name__ == "__main__":
    main()
