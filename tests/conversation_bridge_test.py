from __future__ import annotations

import pytest

from scripts import conversation_bridge


def test_answer_conversation_rejects_empty_question() -> None:
    result = conversation_bridge.answer_conversation("  ", [], {}, "workspace-write")
    assert result == {"ok": False, "error": "问题不能为空。"}


def test_answer_conversation_rejects_unknown_permission_preset() -> None:
    result = conversation_bridge.answer_conversation("问一个问题", [], {}, "plan")
    assert result["ok"] is False
    assert "未知权限预设" in str(result["error"])


def test_history_text_bounds_and_labels() -> None:
    history = conversation_bridge._history_text(
        [{"question": "这个数是什么？", "answer": "这是硬超时兜底。"}],
        {"app": "VS Code", "label": "uia_text_adapter.py"},
    )
    assert "VS Code" in history
    assert "uia_text_adapter.py" in history
    assert "硬超时兜底" in history


def test_perception_backend_searches_history(monkeypatch) -> None:
    backend = conversation_bridge._HistoryPerceptionBackend("第一行 alpha\n第二行 beta")
    hits = backend.find_in_window("beta")
    assert hits == [{"text": "第二行 beta"}]
    assert backend.read_around("", 3)[0]["source"] == "conversation"


def test_perception_backend_lists_real_windows(monkeypatch) -> None:
    monkeypatch.setattr(
        conversation_bridge,
        "list_visible_windows",
        lambda: [
            {"title": "记事本", "hwnd": 1, "app": "notepad", "pid": 10},
            {"title": "Magic Pointer Overlay", "hwnd": 2, "app": "", "pid": 0},
        ],
    )
    backend = conversation_bridge._HistoryPerceptionBackend("")
    windows = backend.list_windows()
    assert [w["title"] for w in windows] == ["记事本"]


def test_effect_ceiling_accepts_valid_modes_and_rejects_unknown() -> None:
    from app.agent_runtime.tool_registry import Effect

    assert conversation_bridge._effect_ceiling("default") == tuple(Effect)
    assert conversation_bridge._effect_ceiling("bypass") == tuple(Effect)
    with pytest.raises(ValueError):
        conversation_bridge._effect_ceiling("root")
