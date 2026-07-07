from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ai_client import ask_vision_model
from app.main import normalize_bbox
from app.object_store import ObjectStore, PointerObject


def main() -> None:
    assert normalize_bbox((10, 20, 1, 2)) == (1, 2, 10, 20)

    tmp = Path("data/.smoke_objects")
    if tmp.exists():
        shutil.rmtree(tmp)
    store = ObjectStore(tmp)
    obj = PointerObject(
        id="obj_test",
        alias="this",
        kind="screen_region",
        bbox=(1, 2, 10, 20),
        image_path="data/captures/obj_test.png",
        app_title="test",
        prompt="解释这个",
        answer="ok",
        created_at="2026-07-06T00:00:00",
    )
    store.append(obj)
    snapshot = store.latest_alias_snapshot()
    assert snapshot["this"]["id"] == "obj_test"
    shutil.rmtree(tmp)

    old_key = os.environ.pop("OPENAI_API_KEY", None)
    old_disable = os.environ.get("MAGIC_POINTER_DISABLE_LOCAL_SECRETS")
    os.environ["MAGIC_POINTER_DISABLE_LOCAL_SECRETS"] = "1"
    try:
        fallback = ask_vision_model(Path("missing.png"), "test")
        assert "未检测到 OPENAI_API_KEY" in fallback
    finally:
        if old_key is not None:
            os.environ["OPENAI_API_KEY"] = old_key
        if old_disable is None:
            os.environ.pop("MAGIC_POINTER_DISABLE_LOCAL_SECRETS", None)
        else:
            os.environ["MAGIC_POINTER_DISABLE_LOCAL_SECRETS"] = old_disable

    print("smoke test ok")


if __name__ == "__main__":
    main()
