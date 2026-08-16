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


def test_slash_routes_permission_command() -> None:
    result = conversation_bridge.route_slash_command("/permission read-only", catalog=None)
    assert result["ok"] is True
    assert result["command"] == {"type": "permission", "preset": "read-only"}
    assert "read-only" in result["answer"]


def test_slash_permission_unknown_preset_fails_closed() -> None:
    result = conversation_bridge.route_slash_command("/permission god-mode", catalog=None)
    assert result["ok"] is False
    assert "未知权限预设" in result["error"]


def test_slash_permission_without_args_lists_presets() -> None:
    result = conversation_bridge.route_slash_command("/permission", catalog=None)
    assert result["ok"] is True
    for preset in ("read-only", "workspace-write", "danger-full-access"):
        assert preset in result["answer"]


def test_slash_routes_model_command(monkeypatch) -> None:
    from app import models_catalog

    calls: list[str] = []

    def fake_select(model_id: str) -> dict:
        calls.append(model_id)
        return {"ok": True, "model": model_id}

    monkeypatch.setattr(models_catalog, "select_model", fake_select)
    result = conversation_bridge.route_slash_command("/model kimi-k3", catalog=None)
    assert result["ok"] is True
    assert calls == ["kimi-k3"]
    assert result["command"] == {"type": "model", "model": "kimi-k3"}


def test_slash_model_select_failure_is_honest(monkeypatch) -> None:
    from app import models_catalog

    monkeypatch.setattr(
        models_catalog, "select_model",
        lambda model_id: {"ok": False, "error": "环境变量 MAGIC_POINTER_MODEL 覆盖文件。"})
    result = conversation_bridge.route_slash_command("/model kimi-k3", catalog=None)
    assert result["ok"] is False
    assert "MAGIC_POINTER_MODEL" in result["error"]


def test_slash_routes_known_skill_to_body_injection(tmp_path) -> None:
    from app.agent_runtime.skill_catalog import SkillCatalog

    (tmp_path / ".agents" / "skills" / "demo-skill").mkdir(parents=True)
    (tmp_path / ".agents" / "skills" / "demo-skill" / "SKILL.md").write_text(
        "---\nname: demo-skill\ndescription: 演示\n---\n\n# 演示正文\n按这个流程走。", encoding="utf-8")
    catalog = SkillCatalog(project_root=tmp_path, user_home=tmp_path / "home")
    result = conversation_bridge.route_slash_command("/demo-skill 帮我跑一遍", catalog=catalog)
    assert result["ok"] is True
    assert result["command"] == {"type": "skill", "name": "demo-skill"}
    assert "# 演示正文" in result["injectedInstruction"]
    assert "帮我跑一遍" in result["rest"]


def test_slash_unknown_name_is_not_a_command() -> None:
    result = conversation_bridge.route_slash_command("/no-such-thing 你好", catalog=None)
    assert result is None


def test_plain_text_is_not_a_command() -> None:
    assert conversation_bridge.route_slash_command("普通问题 /带斜杠的尾巴", catalog=None) is None
    assert conversation_bridge.route_slash_command("", catalog=None) is None
