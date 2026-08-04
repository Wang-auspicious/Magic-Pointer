"""点选是 hover 驱动的，而 OCR 要一秒。所以布局只算一次。

`element_probe_bridge` 每次点选都是一个新进程，所以缓存必须落盘——放内存里永远读不到。
实测（真微信，2026-08-05）：第一次 4.43s，第二次 0.69s。
"""

from __future__ import annotations

import json

import pytest

from app.vision import visual_element_cache as cache


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    yield


ELEMENTS = [{"rect": [100, 200, 300, 40], "text": "一条消息", "lineCount": 1}]


def test_what_was_written_comes_back() -> None:
    cache.write_cached(42, [0, 0, 800, 600], ELEMENTS, now=1000.0)
    assert cache.read_cached(42, [0, 0, 800, 600], now=1001.0) == ELEMENTS


def test_a_stale_layout_is_not_returned() -> None:
    """聊天滚动过之后，旧布局会自信地框错地方。"""
    cache.write_cached(42, [0, 0, 800, 600], ELEMENTS, now=1000.0)
    assert cache.read_cached(42, [0, 0, 800, 600], now=1000.0 + cache.CACHE_TTL_S + 1) is None


def test_a_resized_window_does_not_reuse_the_old_layout() -> None:
    cache.write_cached(42, [0, 0, 800, 600], ELEMENTS, now=1000.0)
    assert cache.read_cached(42, [0, 0, 1200, 900], now=1001.0) is None


def test_a_different_window_does_not_share_a_layout() -> None:
    cache.write_cached(42, [0, 0, 800, 600], ELEMENTS, now=1000.0)
    assert cache.read_cached(43, [0, 0, 800, 600], now=1001.0) is None


def test_nothing_cached_reads_as_nothing() -> None:
    assert cache.read_cached(42, [0, 0, 800, 600]) is None


def test_a_corrupt_cache_file_is_not_fatal(tmp_path) -> None:
    path = tmp_path / "visual-elements-cache.json"
    path.write_text("{not json", encoding="utf-8")
    assert cache.read_cached(42, [0, 0, 800, 600]) is None
    # 而且还能重新写进去。
    cache.write_cached(42, [0, 0, 800, 600], ELEMENTS, now=1000.0)
    assert cache.read_cached(42, [0, 0, 800, 600], now=1001.0) == ELEMENTS


def test_stale_entries_are_swept_on_write_so_it_never_grows(tmp_path) -> None:
    for index in range(5):
        cache.write_cached(index, [0, 0, 800, 600], ELEMENTS, now=1000.0)
    cache.write_cached(99, [0, 0, 800, 600], ELEMENTS, now=1000.0 + cache.CACHE_TTL_S + 5)
    stored = json.loads((tmp_path / "visual-elements-cache.json").read_text(encoding="utf-8"))
    assert len(stored) == 1, "过期条目没有被清掉，缓存会无限增长"


def test_the_pick_bridge_falls_back_to_pixels_and_says_so() -> None:
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "scripts" / "element_probe_bridge.py").read_text(encoding="utf-8")
    assert "_visual_element_at(" in source, "点选桥没有接视觉兜底"
    assert '"source": source' in source, "没有把来源报出去，高亮带就无法分色"
    assert 'source = "structured"' in source
    assert '"pixel"' in source
