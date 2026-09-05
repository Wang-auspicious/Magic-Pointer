from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.context_pack.screen_memory import ScreenMemory


def test_screen_memory_keeps_source_backlink_and_marks_legacy_rows_missing(tmp_path: Path) -> None:
    path = tmp_path / "screen-memory.json"
    memory = ScreenMemory(path)
    recorded = memory.record(
        app="PowerPoint",
        window_title="Q3 review.pptx",
        excerpt="缩短第二页标题",
        source_id="source:deck:slide-2",
        locator={"kind": "slide-shape", "value": {"slideId": 2, "shapeId": 9}},
        now=1000,
    )

    assert recorded is not None
    assert recorded.to_dict()["sourceId"] == "source:deck:slide-2"
    assert recorded.to_dict()["locator"]["value"]["shapeId"] == 9
    assert recorded.to_dict()["provenanceMissing"] is False

    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["entries"].append({
        "id": "legacy",
        "at": 999,
        "app": "Weixin",
        "windowTitle": "项目群",
        "excerpt": "旧摘要没有来源字段",
    })
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    rows = memory.recall(now=1000)
    legacy = next(row for row in rows if row.id == "legacy")
    assert legacy.source_id is None
    assert legacy.locator is None
    assert legacy.provenance_missing is True


def test_screen_memory_does_not_invent_a_source_when_none_was_recorded(tmp_path: Path) -> None:
    memory = ScreenMemory(tmp_path / "screen-memory.json")
    entry = memory.record(app="Weixin", window_title="项目群", excerpt="总结附件", now=1000)
    assert entry is not None
    assert entry.source_id is None
    assert entry.provenance_missing is True


def test_screen_memory_serializes_read_modify_write_across_instances(tmp_path: Path) -> None:
    """Concurrent task writers must not lose rows or collide on the temp file."""
    path = tmp_path / "screen-memory.json"

    def record(index: int) -> None:
        ScreenMemory(path).record(
            app="Excel",
            window_title=f"Book {index}",
            excerpt=f"cell {index}",
            now=1000 + index,
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(record, range(40)))

    rows = ScreenMemory(path).recall(now=2000, limit=100)
    assert {row.excerpt for row in rows} == {f"cell {index}" for index in range(40)}
