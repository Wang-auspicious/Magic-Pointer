from __future__ import annotations

from pathlib import Path

import pytest

from app.context_pack.session import ContextSessionError, ContextSessionStore
from scripts.electron_bridge import _record_runtime_issue, _runtime_issue_mode


def capture(*, object_id: str, vision_error: str = "") -> dict:
    return {
        "object_id": object_id,
        "captured_at": "2026-07-23T10:00:00+08:00",
        "app": "browser",
        "source_window": {
            "title": "Runtime Issue Demo - Chrome",
            "hwnd": 201,
            "process_id": 202,
            "process_name": "chrome.exe",
        },
        "source_confidence": "point_hit",
        "raw_image_path": rf"D:\tmp\{object_id}.png",
        "pointer_image_path": rf"D:\tmp\{object_id}.pointer.png",
        "point": [520, 340],
        "bbox": [470, 300, 620, 390],
        "capture_bbox": [100, 120, 1000, 700],
        "grounding": {"label": "Save changes button", "confidence": 0.88},
        "file_context": {},
        "app_context": {"url": "http://127.0.0.1:8000/demo/runtime_issue_demo.html"},
        "vision_observation": "" if vision_error else "The Save changes button sits below the adjacent card top.",
        "vision_error": vision_error,
    }


def test_runtime_issue_mode_requires_explicit_workflow_marker() -> None:
    assert _runtime_issue_mode({"workflow": "runtime_issue"}) is True
    assert _runtime_issue_mode({"workflow": "context_pack"}) is False
    assert _runtime_issue_mode({"command": "这个按钮错位"}) is False


def test_runtime_issue_bridge_records_issue_then_reference_and_compiles_artifact(tmp_path: Path) -> None:
    ids = iter(["context-runtime", "item-issue", "item-reference"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))

    first = _record_runtime_issue(
        capture(object_id="problem"),
        "这个保存按钮太靠下，应该和右侧卡片顶部对齐",
        store=store,
        artifact_root=tmp_path,
    )
    second = _record_runtime_issue(
        capture(object_id="reference"),
        "参考这个卡片的间距和按钮位置",
        store=store,
        artifact_root=tmp_path,
    )

    assert first["intentKind"] == "runtime_issue_recorded"
    assert first["contextSession"]["last_item"]["role"] == "issue"
    assert second["contextSession"]["last_item"]["role"] == "reference"
    assert second["contextSession"]["item_count"] == 2
    assert second["contextSession"]["task_instruction"] == "这个保存按钮太靠下，应该和右侧卡片顶部对齐"
    assert Path(second["promptArtifact"]).exists()
    assert second["runtimePrompt"].startswith("# Runtime UI issue")
    assert "自行检查当前工作区并定位负责源码" in second["runtimePrompt"]
    assert second["autoDismissMs"] >= 1500


def test_runtime_issue_bridge_keeps_capture_when_vision_translation_failed(tmp_path: Path) -> None:
    store = ContextSessionStore(
        root=tmp_path,
        id_factory=iter(["context-runtime", "item-issue"]).__next__,
    )

    result = _record_runtime_issue(
        capture(object_id="no-vision", vision_error="RuntimeError: no API key"),
        "这个运行状态是错误的",
        store=store,
        artifact_root=tmp_path,
    )

    assert result["ok"] is True
    assert result["contextSession"]["last_item"]["vision_error"] == "RuntimeError: no API key"
    assert "视觉转译不可用" in result["answer"]
    assert Path(result["promptArtifact"]).exists()


def test_runtime_issue_bridge_rejects_blank_statement_without_creating_session(tmp_path: Path) -> None:
    store = ContextSessionStore(root=tmp_path)

    with pytest.raises(ContextSessionError, match="statement is empty"):
        _record_runtime_issue(capture(object_id="blank"), " ", store=store, artifact_root=tmp_path)

    assert store.active() is None
