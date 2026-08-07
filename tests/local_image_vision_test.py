"""Tests for local-image-file vision answering.

Regression nail for the 2026-08-07 incident: the user lassoed a JPG in File
Explorer and asked "what is this image" — the pipeline only fed the file NAME
to the text model (deepseek has no vision), producing "this is a file named
xxx.jpg". Root cause: the vision path was gated behind upload_screenshots
(privacy opt-in for SCREENSHOT upload), so a user-pointed-at LOCAL image file
never reached the visual model. Fix: when the marked content resolves to an
existing local image file, ask the visual model about that file itself.
"""
from __future__ import annotations

from pathlib import Path

from app.adapters.base import AdapterReadContext
from scripts.selection_bridge import _local_image_file_answer

IMAGE = Path("D:/Desktop/参考/1d9473e9adbf41e3bbbf0b59ef4dc480.jpg")


def test_full_path_content_resolves_to_image() -> None:
    ctx = AdapterReadContext(
        adapter="uia", app="explorer", method="selection",
        content=str(IMAGE),
    )
    # 不真正调模型：monkeypatch ask_vision_model 收参验证
    calls = {}

    import scripts.selection_bridge as bridge

    def fake(image_path, prompt, context_text=None, labeled_extra_images=None):
        calls["path"] = str(image_path)
        calls["prompt"] = prompt
        return "FAKE-VISION-ANSWER"

    original = bridge.ask_vision_model
    bridge.ask_vision_model = fake
    try:
        answer = _local_image_file_answer("这张图里有什么？", ctx, None)
    finally:
        bridge.ask_vision_model = original

    assert answer == "FAKE-VISION-ANSWER"
    assert calls["path"] == str(IMAGE)
    assert "这张图里有什么" in calls["prompt"]


def test_filename_only_content_searches_desktop_and_cwd(monkeypatch, tmp_path) -> None:
    from PIL import Image

    import scripts.selection_bridge as bridge

    # 桌面根放一个临时图（文件名-only 场景的真实落点）
    desktop = bridge._user_desktop_dir()
    probe = desktop / "mp-vision-test-tmp.png"
    Image.new("RGB", (32, 32), "red").save(probe)
    try:
        ctx = AdapterReadContext(
            adapter="uia", app="explorer", method="selection",
            content=probe.name,
        )
        calls = {}

        def fake(image_path, prompt, context_text=None, labeled_extra_images=None):
            calls["path"] = str(image_path)
            return "OK"

        monkeypatch.setattr(bridge, "ask_vision_model", fake)
        answer = _local_image_file_answer("这张图", ctx, None)
        assert answer == "OK"
        assert calls["path"] == str(probe)
    finally:
        probe.unlink(missing_ok=True)


def test_non_image_content_returns_none() -> None:
    ctx = AdapterReadContext(
        adapter="uia", app="notepad", method="selection",
        content="这是一段普通文本",
    )
    assert _local_image_file_answer("解释一下", ctx, None) is None


def test_missing_file_returns_none() -> None:
    ctx = AdapterReadContext(
        adapter="uia", app="explorer", method="selection",
        content=r"C:\definitely\not\here.png",
    )
    assert _local_image_file_answer("这张图", ctx, None) is None


def test_snapshot_context_path_is_used(monkeypatch) -> None:
    calls = {}

    import scripts.selection_bridge as bridge

    def fake(image_path, prompt, context_text=None, labeled_extra_images=None):
        calls["path"] = str(image_path)
        return "OK"

    monkeypatch.setattr(bridge, "ask_vision_model", fake)
    snapshot = {"context": {"document_path": str(IMAGE)}}
    answer = _local_image_file_answer("这张图", None, snapshot)
    assert answer == "OK"
    assert calls["path"] == str(IMAGE)
