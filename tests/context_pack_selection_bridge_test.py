from __future__ import annotations

from pathlib import Path

import pytest

from app.context_pack.session import ContextSessionStore
from app.fabric.settings import FabricSettings, SettingsStore
from scripts.selection_bridge import _context_pack_response

PRIVACY_NOTICE = (
    "Privacy boundary: Magic Pointer withheld screen/image attachments because "
    "Dashboard screenshot upload is disabled."
)


def snapshot(*, snapshot_id: str = "snap-1", context: dict | None = None) -> dict:
    return {
        "snapshot_id": snapshot_id,
        "captured_at": "2026-07-22T10:00:00+08:00",
        "source_window": {
            "title": "app.py - Visual Studio Code",
            "hwnd": 101,
            "process_id": 102,
            "process_name": "Code.exe",
        },
        "target_point": {"x": 400, "y": 500},
        "target_point_space": "physical_screen_pixels",
        "context": context
        if context is not None
        else {
            "app": "code",
            "label": r"D:\repo\app.py",
            "content": "def checkout(order):",
            "method": "uia:text-pattern",
            "artifacts": {"document": r"D:\repo\app.py", "selection_context": "function context"},
        },
    }


def visual_capture() -> dict:
    return {
        "object_id": "obj-visual-1",
        "captured_at": "2026-07-26T10:00:00+08:00",
        "app": "browser",
        "source_window": {
            "title": "Broken checkout - Chrome",
            "hwnd": 301,
            "process_id": 302,
            "process_name": "chrome.exe",
        },
        "source_confidence": "point_hit",
        "raw_image_path": r"D:\tmp\obj-visual-1.png",
        "pointer_image_path": r"D:\tmp\obj-visual-1.pointer.png",
        "point": [420, 260],
        "bbox": [400, 240, 580, 330],
        "capture_bbox": [100, 120, 900, 620],
        "grounding": {"label": "red error card", "confidence": 0.84},
        "file_context": {},
        "app_context": {"url": "https://example.test/checkout"},
        "vision_observation": "A red Payment failed card appears below the form.",
        "vision_error": "",
    }


def test_delivered_prompt_withholds_screenshots_when_upload_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    ids = iter(["context-1", "item-1"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    store.record_visual(visual_capture(), "这是用户看到的错误状态")

    compiled = _context_pack_response(
        {"command": "生成提示词：修复结账错误"},
        snapshot()["source_window"],
        snapshot(context=None),
        store=store,
        artifact_root=tmp_path,
    )
    delivered = _context_pack_response(
        {
            "command": "发送到这里",
            "targetPoint": {"x": 420, "y": 860},
            "targetPointSpace": "physical_screen_pixels",
        },
        {"title": "Codex", "hwnd": 901, "process_id": 902, "process_name": "Codex.exe"},
        snapshot(context=None),
        store=store,
        artifact_root=tmp_path,
    )

    assert compiled is not None and compiled["ok"] is True
    assert ".png" not in compiled["contextPrompt"]
    assert PRIVACY_NOTICE in compiled["contextPrompt"]
    assert "A red Payment failed card" in compiled["contextPrompt"]
    assert ".png" not in Path(compiled["promptArtifact"]).read_text(encoding="utf-8")
    assert delivered is not None and delivered["ok"] is True
    delivered_text = delivered["actionProposals"][0]["parameters"]["text"]
    assert ".png" not in delivered_text
    assert PRIVACY_NOTICE in delivered_text


def test_delivered_prompt_includes_screenshots_when_setting_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    SettingsStore(tmp_path / "fabric-settings.json").save(settings)
    ids = iter(["context-1", "item-1"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    store.record_visual(visual_capture(), "这是用户看到的错误状态")

    compiled = _context_pack_response(
        {"command": "生成提示词：修复结账错误"},
        snapshot()["source_window"],
        snapshot(context=None),
        store=store,
        artifact_root=tmp_path,
    )

    assert compiled is not None and compiled["ok"] is True
    assert r"D:\tmp\obj-visual-1.pointer.png" in compiled["contextPrompt"]
    assert "Privacy boundary" not in compiled["contextPrompt"]


def test_native_collect_records_context_item(tmp_path: Path) -> None:
    store = ContextSessionStore(root=tmp_path, id_factory=iter(["context-1", "item-1"]).__next__)
    payload = {"command": "收集：这是当前实现入口", "selectionSessionId": "ui-session"}

    result = _context_pack_response(
        payload,
        snapshot()["source_window"],
        snapshot(),
        store=store,
        artifact_root=tmp_path,
    )

    assert result is not None
    assert result["ok"] is True
    assert result["intentKind"] == "context_item_recorded"
    assert result["contextSession"]["item_count"] == 1
    assert result["contextSession"]["last_item"]["instruction"] == "这是当前实现入口"
    assert result["actionProposals"] == []
    assert "继续选择" in result["answer"]


def test_compile_and_delivery_use_active_pack_and_exact_target(tmp_path: Path) -> None:
    ids = iter(["context-1", "item-1"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    store.record_native(snapshot(), "这是实现入口")

    compiled = _context_pack_response(
        {"command": "生成提示词：修复结账错误"},
        snapshot()["source_window"],
        snapshot(),
        store=store,
        artifact_root=tmp_path,
    )
    target = {
        "title": "Codex",
        "hwnd": 901,
        "process_id": 902,
        "process_name": "Codex.exe",
    }
    delivered = _context_pack_response(
        {
            "command": "发送到这里",
            "targetPoint": {"x": 420, "y": 860},
            "targetPointSpace": "physical_screen_pixels",
        },
        target,
        snapshot(context=None),
        store=store,
        artifact_root=tmp_path,
    )

    assert compiled is not None and compiled["intentKind"] == "context_prompt_compiled"
    assert compiled["contextPrompt"].startswith("# Grounded desktop task")
    assert Path(compiled["promptArtifact"]).exists()
    assert delivered is not None and delivered["intentKind"] == "context_prompt_delivery"
    assert delivered["contextSession"]["target_profile"] == "codex"
    assert delivered["autoExecuteProposalId"] == delivered["actionProposals"][0]["id"]
    proposal = delivered["actionProposals"][0]
    assert proposal["parameters"]["target_hwnd"] == 901
    assert proposal["parameters"]["target_point"] == [420, 860]
    assert proposal["parameters"]["target_point_space"] == "physical_screen_pixels"
    assert proposal["parameters"]["submit"] is False


def test_ambiguous_fill_command_is_rejected_when_context_and_review_are_active(tmp_path: Path) -> None:
    ids = iter(["context-1", "item-1"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    store.record_native(snapshot(), "实现入口")

    class ReviewStore:
        @staticmethod
        def active() -> dict:
            return {"session_id": "review-1", "anchor_count": 2}

    result = _context_pack_response(
        {
            "command": "填入这里",
            "targetPoint": {"x": 420, "y": 860},
            "targetPointSpace": "physical_screen_pixels",
        },
        {"title": "Codex", "hwnd": 901, "process_id": 902},
        snapshot(context=None),
        store=store,
        review_store=ReviewStore(),
        artifact_root=tmp_path,
    )

    assert result is not None and result["ok"] is False
    assert "同时存在" in result["error"]
    assert result["actionProposals"] == []


def test_empty_pack_and_blank_collect_fail_closed(tmp_path: Path) -> None:
    store = ContextSessionStore(root=tmp_path)

    missing = _context_pack_response(
        {"command": "生成提示词：修复它"},
        {},
        snapshot(),
        store=store,
        artifact_root=tmp_path,
    )
    blank = _context_pack_response(
        {"command": "收集："},
        snapshot()["source_window"],
        snapshot(),
        store=store,
        artifact_root=tmp_path,
    )

    assert missing is not None and missing["ok"] is False
    assert "没有已收集" in missing["error"]
    assert blank is not None and blank["ok"] is False
    assert "补充一句" in blank["error"]
    assert store.active() is None


def test_clear_requires_explicit_confirmation_without_deleting(tmp_path: Path) -> None:
    ids = iter(["context-1", "item-1"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    store.record_native(snapshot(), "入口")

    result = _context_pack_response(
        {"command": "清空上下文"},
        {},
        snapshot(),
        store=store,
        artifact_root=tmp_path,
    )

    assert result is not None
    assert result["ok"] is False
    assert result["intentKind"] == "context_clear_confirmation"
    assert result["requiresConfirmation"] is True
    assert store.active()["item_count"] == 1  # type: ignore[index]
