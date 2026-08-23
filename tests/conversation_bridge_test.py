from __future__ import annotations

import pytest
from types import SimpleNamespace

from scripts import conversation_bridge


class _FakeClock:
    def __init__(self) -> None:
        self.elapsed = 0.0
        self.marks: list[tuple[str, dict]] = []

    def mark(self, phase: str, **fields):
        self.elapsed += 100.0
        self.marks.append((phase, fields))
        return self.elapsed


def test_answer_conversation_rejects_empty_question() -> None:
    result = conversation_bridge.answer_conversation("  ", [], {}, "workspace-write")
    assert result == {"ok": False, "error": "问题不能为空。"}


def test_answer_conversation_rejects_unknown_permission_preset() -> None:
    result = conversation_bridge.answer_conversation("问一个问题", [], {}, "yolo")
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


def test_conversation_budget_never_kills_a_normal_answer() -> None:
    from app.governance.latency_budget import Stage

    policy = conversation_bridge.CONVERSATION_BUDGETS[Stage.FULL_ANSWER]
    assert policy.budget_ms >= 60 * 60 * 1000, (
        "Studio 对话不能带 4 秒 FULL_ANSWER 预算：普通 3-6 秒模型回答会被误杀成 "
        "'full answer budget exhausted'（用户可见错误）。"
    )


def test_conversation_activity_sink_projects_live_model_and_tool_events() -> None:
    clock = _FakeClock()
    sink = conversation_bridge._ConversationActivitySink(clock)
    sink(SimpleNamespace(kind="loop_start"))
    sink(SimpleNamespace(kind="turn_started", turn=1))
    sink(SimpleNamespace(kind="model_chunk", text="第一段"))
    sink(SimpleNamespace(kind="tool_call_started", name="read", id="call-1"))
    sink(SimpleNamespace(kind="tool_call_finished", result=SimpleNamespace(
        tool_call_id="call-1", tool_name="read", is_error=False,
        used_backend="uia", latency_ms=23.5)))
    sink(SimpleNamespace(kind="turn_finished", state=SimpleNamespace(value="done")))

    assert [phase for phase, _ in clock.marks] == [
        "agent_start", "model_request", "model_first_chunk",
        "tool_call", "tool_result", "model_response",
    ]
    assert sink.activities[0]["kind"] == "model"
    assert sink.activities[0]["state"] == "done"
    assert sink.activities[0]["firstTokenMs"] == 100.0
    assert sink.activities[1] == {
        "kind": "tool",
        "id": "call-1",
        "name": "read",
        "state": "done",
        "latencyMs": 23.5,
        "usedBackend": "uia",
    }
    assert [record["kind"] for record in sink.trajectory] == [
        "request-header", "message", "tool",
    ]
    assert [record["seq"] for record in sink.trajectory] == [1, 2, 3]
    assert sink.trajectory[1]["firstTokenAt"] - sink.trajectory[1]["startedAt"] == 100.0
    assert sink.trajectory[2]["callId"] == "call-1"
    assert sink.trajectory[2]["usedBackend"] == "uia"


def test_conversation_result_keeps_receipts_usage_activity_and_timing() -> None:
    mapped = {
        "answer": "done",
        "usedBackend": "gateway",
        "loopReceipts": [{"toolName": "read", "latencyMs": 4}],
        "events": [{"name": "read"}],
        "modelUsage": {"totalTokens": 11},
    }
    result = conversation_bridge._completed_result(
        mapped,
        client_backend="fallback",
        permission_preset="workspace-write",
        activities=[{"kind": "model", "state": "done"}],
        trajectory=[{"seq": 1, "kind": "message", "state": "done"}],
        timing_ms=1200,
    )
    assert result["receipts"][0]["toolName"] == "read"
    assert result["modelUsage"]["totalTokens"] == 11
    assert result["activities"][0]["kind"] == "model"
    assert result["trajectory"][0]["seq"] == 1
    assert result["timingMs"] == 1200
    assert result["usedBackend"] == "gateway"


def test_conversation_result_can_expose_authoritative_session_bill() -> None:
    mapped = {"answer": "done", "modelUsage": {"totalTokens": 3}}
    result = conversation_bridge._completed_result(
        mapped,
        client_backend="gateway",
        permission_preset="workspace-write",
        activities=[],
        trajectory=[],
        timing_ms=10,
        agent_session_id="agent-studio-1",
        interaction_ledger={"interactionId": "agent-studio-1:1", "tokensText": 3},
    )

    assert result["agentSessionId"] == "agent-studio-1"
    assert result["interactionLedger"]["tokensText"] == 3


class _FakeTodoStore:
    def __init__(self):
        self.on_update = None
    def read(self):
        return []
    def has_items(self):
        return False


class _FakeSession:
    events = ()

    def interrupted_turn_summary(self):
        return None
    def enqueue_inbox(self, *a, **k):
        pass
    def claim_inbox(self, *a, **k):
        return []


def _install_workspace_boot_stubs(monkeypatch, captured):
    """boot_loop_context 之后到 run_agent_turn 之间的最小服务桩。"""
    from types import SimpleNamespace

    from app.agent_runtime.tool_registry import ToolRegistry

    class _Ctx:
        def get(self, key):
            if key == "tools":
                return ToolRegistry()
            if key == "todo_store":
                return _FakeTodoStore()
            if key == "sessions":
                return SimpleNamespace(open_or_create=lambda *a, **k: _FakeSession())
            if key == "context_budget":
                return 64000
            return SimpleNamespace()  # model_client/compactor/estimator/...

    report = SimpleNamespace(ctx=_Ctx(), rows=[
        SimpleNamespace(id="model-client", resolved_config={"permission_mode": "default"}),
    ])

    import app.harness.builtin_bundle as builtin_bundle
    monkeypatch.setattr(
        builtin_bundle, "boot_loop_context", lambda runtime, root=None: captured.update(
            workspace_root=runtime.get("workspace_root")
        ) or report
    )

    import app.fabric.engine as engine_module

    def fake_run(user_input, objects=None, registry=None, *, client, **kwargs):
        from app.agent_runtime.loop import TransitionReason
        from app.agent_runtime.types import Terminal

        captured["run_kwargs"] = kwargs
        return Terminal(reason=TransitionReason.COMPLETED, message="好了", turns=1, results=())

    monkeypatch.setattr(engine_module, "run_agent_turn", fake_run)

    import app.fabric.loop_answer as loop_answer
    monkeypatch.setattr(loop_answer, "terminal_to_answer", lambda terminal, prompt: {"answer": "好了"})


def test_explicit_workspace_pick_is_thread_scoped_not_global(monkeypatch, tmp_path):
    """Codex thread workspace_roots 语义：芯片选择只改本请求的 runtime，
    绝不回写全局 workspace.txt（那是 /cwd 的职责）——否则 A 会话选的工作区
    会静默泄漏进 B 会话。"""
    import app.agent_runtime.workspace_state as workspace_state

    written = []
    monkeypatch.setattr(
        workspace_state, "write_workspace", lambda root, path: written.append(path)
    )
    ws_dir = tmp_path / "some-repo"
    ws_dir.mkdir()
    default_ws = tmp_path / "profile-default"
    default_ws.mkdir()
    monkeypatch.setattr(workspace_state, "read_workspace", lambda root: default_ws)

    captured = {}
    _install_workspace_boot_stubs(monkeypatch, captured)

    result = conversation_bridge.answer_conversation(
        "看看这个仓库",
        [],
        {},
        "workspace-write",
        workspace_root=str(ws_dir),
    )
    assert captured["workspace_root"] == str(ws_dir.resolve())
    assert written == [], "芯片选择不得回写全局 workspace.txt"
    assert result["ok"] is True


def test_missing_explicit_workspace_falls_back_to_profile_default(monkeypatch, tmp_path):
    """不带显式 root 时用持久化默认（/cwd 写的那份），而不是进程 cwd。"""
    import app.agent_runtime.workspace_state as workspace_state

    default_ws = tmp_path / "profile-default"
    default_ws.mkdir()
    monkeypatch.setattr(workspace_state, "read_workspace", lambda root: default_ws)

    captured = {}
    _install_workspace_boot_stubs(monkeypatch, captured)

    result = conversation_bridge.answer_conversation("随便问", [], {}, "workspace-write")
    assert captured["workspace_root"] == str(default_ws)
    assert result["ok"] is True

