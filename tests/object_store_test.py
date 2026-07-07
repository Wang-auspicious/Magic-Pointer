import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.object_store import ObjectStore, PointerObject


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
    root = Path("data/.object_store_test")
    if root.exists():
        shutil.rmtree(root)
    store = ObjectStore(root)
    for i in range(3):
        store.append(make_obj(i))
    recent = store.recent(2)
    assert [x["id"] for x in recent] == ["obj_2", "obj_1"]
    snap = store.latest_alias_snapshot()
    assert snap["this"]["id"] == "obj_2"
    assert snap["that"]["id"] == "obj_1"
    assert store.object_by_id("obj_1")["prompt"] == "prompt 1"
    assert store.object_by_id("missing") is None
    ctx = store.build_reference_context("obj_current", (0, 0, 10, 10), limit=2)
    assert "Object log v1" in ctx
    assert "diagnostic only" in ctx
    assert "recent_log" in ctx
    shutil.rmtree(root)
    print("object store test ok")


if __name__ == "__main__":
    main()
