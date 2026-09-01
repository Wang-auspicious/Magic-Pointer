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


def test_slash_compact_and_help_are_deferred_runtime_commands() -> None:
    compact = conversation_bridge.route_slash_command("/compact", catalog=None)
    help_result = conversation_bridge.route_slash_command("/help", catalog=None)

    assert compact is not None
    assert compact["ok"] is True
    assert compact["command"] == {"type": "compact"}
    assert help_result is not None
    assert help_result["ok"] is True
    assert help_result["command"] == {"type": "help"}


def test_tool_names_accepts_bare_names_and_bounded_bash_prefix_rules() -> None:
    max_prefix = "x" * 160
    values = [
        "Read",
        "Bash(pytest -q)",
        f"Bash({max_prefix})",
        "Bash()",
        "Bash(   )",
        "Bash(pytest (unit))",
        "Bash(pytest\n-q)",
        f"Bash({'x' * 161})",
        "free form grant",
    ]

    assert conversation_bridge._tool_names(values) == (
        "Read",
        "Bash(pytest -q)",
        f"Bash({max_prefix})",
    )


def test_permission_memo_canonicalizes_aliases_and_drops_unknown_tools() -> None:
    from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="Read",
        description="read",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=lambda: "ok",
    ))
    registry.register(ToolSpec(
        name="Bash",
        description="shell",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=lambda: "ok",
    ))
    registry.register_alias("read_file", "Read")

    decisions = conversation_bridge._build_permission_decisions(
        ["read_file", "FutureTool", "Bash(pytest)"],
        ["read_file"],
        (),
        registry=registry,
    )

    assert decisions is not None
    assert decisions.allowed == ("Read", "Bash(pytest)")
    assert decisions.denied == ("Read",)


def test_conversation_budget_never_kills_a_normal_answer() -> None:
    from app.governance.latency_budget import Stage

    policy = conversation_bridge.CONVERSATION_BUDGETS[Stage.FULL_ANSWER]
    assert policy.budget_ms >= 60 * 60 * 1000, (
        "Studio 对话不能带 4 秒 FULL_ANSWER 预算：普通 3-6 秒模型回答会被误杀成 "
        "'full answer budget exhausted'（用户可见错误）。"
    )


def test_conversation_activity_sink_projects_live_model_and_tool_events() -> None:
    clock = _FakeClock()
    sink = conversation_bridge._ConversationActivitySink(clock, request_header={
        "promptCache": True,
        "usedBackend": "magic_pointer.messages_multiturn_streaming",
        "maxTokens": 4096,
        "systemPrompt": "must never enter trajectory",
    })
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
    assert sink.trajectory[0]["promptCache"] is True
    assert sink.trajectory[0]["usedBackend"] == "magic_pointer.messages_multiturn_streaming"
    assert sink.trajectory[0]["maxTokens"] == 4096
    assert "systemPrompt" not in sink.trajectory[0]
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
        has_pending_work=True,
        interaction_ledger={"interactionId": "agent-studio-1:1", "tokensText": 3},
    )

    assert result["agentSessionId"] == "agent-studio-1"
    assert result["hasPendingWork"] is True
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

    def derive_messages(self):
        return []

    def interrupted_turn_summary(self):
        return None
    def enqueue_inbox(self, *a, **k):
        pass
    def claim_inbox(self, *a, **k):
        return []


def _install_workspace_boot_stubs(monkeypatch, captured, *, registry=None):
    """boot_loop_context 之后到 run_agent_turn 之间的最小服务桩。"""
    from types import SimpleNamespace

    from app.agent_runtime.tool_registry import ToolRegistry

    active_registry = registry or ToolRegistry()

    class _Ctx:
        def get(self, key):
            if key == "tools":
                return active_registry
            if key == "todo_store":
                return _FakeTodoStore()
            if key == "sessions":
                def _open(session_id, *a, **k):
                    captured["agent_session_id"] = session_id
                    return _FakeSession()

                return SimpleNamespace(open_or_create=_open)
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


def _install_runtime_service_stubs(
    monkeypatch,
    *,
    session_store,
    registry,
    compactor,
    token_estimator,
    run_impl,
) -> None:
    """Install a real session seam with deterministic runtime services."""
    from types import SimpleNamespace

    services = {
        "tools": registry,
        "todo_store": _FakeTodoStore(),
        "sessions": session_store,
        "context_budget": 64000,
        "model_client": SimpleNamespace(used_backend="fake.runtime"),
        "compactor": compactor,
        "token_estimator": token_estimator,
        "precondition_factory": None,
        "model_request_header": {},
        "hooks": SimpleNamespace(),
    }

    class _Ctx:
        def get(self, key):
            return services[key]

    report = SimpleNamespace(
        ctx=_Ctx(),
        rows=[SimpleNamespace(
            id="model-client",
            resolved_config={"context_budget_tokens": 64000},
        )],
    )

    import app.harness.builtin_bundle as builtin_bundle
    monkeypatch.setattr(
        builtin_bundle,
        "boot_loop_context",
        lambda runtime, root=None: report,
    )

    import app.fabric.engine as engine_module
    monkeypatch.setattr(engine_module, "run_agent_turn", run_impl)

    import app.fabric.loop_answer as loop_answer
    monkeypatch.setattr(
        loop_answer,
        "terminal_to_answer",
        lambda terminal, prompt: {"answer": terminal.message or "好了"},
    )


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



def test_thread_permission_grants_reach_the_runtime(monkeypatch):
    """CC toolPermissionDecision：会话里授予/拒绝过的工具随每条消息注入
    loop memo——grant 升级 ASK，deny 压过 mode-allow；一次性 grant 只进
    本次请求。"""
    from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec

    captured = {}
    registry = ToolRegistry()
    for name in ("Bash", "Launch", "BashRead"):
        registry.register(ToolSpec(
            name=name,
            description=name,
            input_schema={"type": "object", "properties": {}, "required": []},
            execute=lambda: "ok",
        ))
    registry.register_alias("run_command", "Bash")
    registry.register_alias("launch_app", "Launch")
    registry.register_alias("read_background", "BashRead")
    _install_workspace_boot_stubs(monkeypatch, captured, registry=registry)

    result = conversation_bridge.answer_conversation(
        "帮我跑一下构建",
        [],
        {},
        "workspace-write",
        permission_grants=("run_command",),
        permission_denials=("launch_app",),
        permission_grant_once=("read_background",),
    )
    decisions = captured["run_kwargs"]["permission_decisions"]
    assert decisions.lookup("Bash") == "allow"
    assert decisions.lookup("Launch") == "deny"
    assert decisions.lookup("BashRead") == "allow"
    assert result["ok"] is True


def test_no_grants_means_no_memo(monkeypatch):
    captured = {}
    _install_workspace_boot_stubs(monkeypatch, captured)

    conversation_bridge.answer_conversation("解释一下这段日志", [], {}, "workspace-write")
    assert captured["run_kwargs"]["permission_decisions"] is None


def test_each_conversation_gets_its_own_agent_session(monkeypatch):
    """会话身份必须钉到 conversationId。

    Agent session 是磁盘上一条哈希链 JSONL：断点续跑摘要、待办、取消请求、
    pending work 全挂在它上面。两条不同的对话拿到同一个 id，就等于共用一份
    断点状态——新开一个对话会被上一条对话的未完成任务续跑块劫持。
    """
    captured_a: dict = {}
    _install_workspace_boot_stubs(monkeypatch, captured_a)
    conversation_bridge.answer_conversation(
        "第一条对话", [], {}, "workspace-write", conversation_id="conv-aaa"
    )

    captured_b: dict = {}
    _install_workspace_boot_stubs(monkeypatch, captured_b)
    conversation_bridge.answer_conversation(
        "第二条对话", [], {}, "workspace-write", conversation_id="conv-bbb"
    )

    assert captured_a["agent_session_id"] != captured_b["agent_session_id"]


def test_plain_conversations_without_selection_do_not_share_one_session(monkeypatch):
    """回归：普通文本对话没有 selection object，旧实现用 windowTitle 派生
    session_key，全部塌缩成常量 "chat" —— 整个 app 的普通对话共用一条
    session 文件。"""
    seen = set()
    for conversation_id in ("conv-1", "conv-2", "conv-3"):
        captured: dict = {}
        _install_workspace_boot_stubs(monkeypatch, captured)
        conversation_bridge.answer_conversation(
            "你好", [], {}, "workspace-write", conversation_id=conversation_id
        )
        seen.add(captured["agent_session_id"])
    assert len(seen) == 3


def test_agent_session_id_is_stable_across_turns_of_one_conversation(monkeypatch):
    """同一条对话的每一轮必须落回同一条 session，否则断点续跑永远读不到
    上一轮——多轮对话退化成一次性问答。"""
    ids = []
    for _ in range(2):
        captured: dict = {}
        _install_workspace_boot_stubs(monkeypatch, captured)
        conversation_bridge.answer_conversation(
            "继续", [], {}, "workspace-write", conversation_id="conv-stable"
        )
        ids.append(captured["agent_session_id"])
    assert ids[0] == ids[1]


def test_established_event_session_does_not_reinject_electron_message_history(
    monkeypatch,
    tmp_path,
) -> None:
    """An empty Agent session imports legacy Electron history once; after the
    first durable turn, only object/scene evidence is attached again."""
    from app.agent_runtime.session import FileSessionStore
    from app.agent_runtime.tool_registry import ToolRegistry
    from app.agent_runtime.types import (
        ORIGIN_DATA,
        ORIGIN_INSTRUCTION,
        AgentMessage,
        Role,
        Terminal,
        TransitionReason,
    )

    store = FileSessionStore(tmp_path / "sessions")
    evidence_inputs: list[str] = []

    def fake_run(user_input, objects=None, registry=None, *, client, **kwargs):
        session = kwargs["session"]
        evidence = str(kwargs.get("evidence_input") or "")
        evidence_inputs.append(evidence)
        turn = session.start_turn()
        session.append_message(AgentMessage(
            role=Role.USER,
            content=user_input,
            tool_call_id=None,
            name=None,
            origin=ORIGIN_INSTRUCTION,
        ))
        if evidence:
            session.append_message(AgentMessage(
                role=Role.USER,
                content=evidence,
                tool_call_id=None,
                name=None,
                origin=ORIGIN_DATA,
                injected=True,
            ))
        session.append_message(AgentMessage(
            role=Role.ASSISTANT,
            content="好了",
            tool_call_id=None,
            name=None,
            origin=ORIGIN_DATA,
        ))
        session.end_turn(turn, reason="completed")
        return Terminal(
            reason=TransitionReason.COMPLETED,
            message="好了",
            turns=1,
            results=(),
        )

    _install_runtime_service_stubs(
        monkeypatch,
        session_store=store,
        registry=ToolRegistry(),
        compactor=lambda messages, **_kwargs: list(messages),
        token_estimator=lambda messages: sum(len(message.content or "") for message in messages),
        run_impl=fake_run,
    )

    legacy_turns = [{
        "question": "旧 Electron 第一问",
        "answer": "旧 Electron 第一答",
        "evidence": {
            "label": "圈选现场",
            "capturePath": "D:/captures/scene.png",
            "contentDigest": "当时屏幕上的数据 42",
        },
    }]
    object_ref = {"app": "Notepad", "windowTitle": "notes.txt", "label": "数据行"}

    first = conversation_bridge.answer_conversation(
        "接入 Agent session",
        legacy_turns,
        object_ref,
        "workspace-write",
        conversation_id="legacy-conversation",
        workspace_root=str(tmp_path),
    )
    second = conversation_bridge.answer_conversation(
        "继续追问",
        legacy_turns,
        object_ref,
        "workspace-write",
        conversation_id="legacy-conversation",
        agent_session_id=str(first["agentSessionId"]),
        workspace_root=str(tmp_path),
    )
    third = conversation_bridge.answer_conversation(
        "再继续追问",
        legacy_turns,
        object_ref,
        "workspace-write",
        conversation_id="legacy-conversation",
        agent_session_id=str(first["agentSessionId"]),
        workspace_root=str(tmp_path),
    )

    assert first["ok"] is True and second["ok"] is True and third["ok"] is True
    assert "用户：旧 Electron 第一问" in evidence_inputs[0]
    assert "助手：旧 Electron 第一答" in evidence_inputs[0]
    assert "旧 Electron 第一问" not in evidence_inputs[1]
    assert "旧 Electron 第一答" not in evidence_inputs[1]
    assert "当前对象：Notepad · notes.txt · 数据行" in evidence_inputs[1]
    assert "第1轮现场证据" not in evidence_inputs[1]
    assert "当时屏幕上的数据 42" not in evidence_inputs[1]
    assert "第1轮现场证据" not in evidence_inputs[2]

    durable = store.resume(str(first["agentSessionId"]))
    durable_text = "\n".join(message.content or "" for message in durable.derive_messages())
    assert "旧 Electron 第一问" in durable_text
    assert "接入 Agent session" in durable_text
    assert durable_text.count("当时屏幕上的数据 42") == 1


def test_slash_rewind_restores_workspace_checkpoints(monkeypatch, tmp_path) -> None:
    """/rewind 是 checkpoint 的 GUI 入口（B5-25）：走绑定工作区的
    FileCheckpointStore，步数可选；无记录时诚实回答。"""
    import app.agent_runtime.workspace_state as workspace_state

    default_ws = tmp_path / "ws"
    default_ws.mkdir()
    monkeypatch.setattr(workspace_state, "read_workspace", lambda root: default_ws)

    (default_ws / "a.txt").write_text("old", encoding="utf-8")
    from app.agent_runtime.coding_tools import FileCheckpointStore

    store = FileCheckpointStore(default_ws)
    store.record(default_ws / "a.txt", existed=True)
    (default_ws / "a.txt").write_text("new", encoding="utf-8")

    result = conversation_bridge.route_slash_command("/rewind", catalog=None)
    assert result["ok"] is True
    assert (default_ws / "a.txt").read_text(encoding="utf-8") == "old"

    empty = conversation_bridge.route_slash_command("/rewind", catalog=None)
    assert empty["ok"] is True
    assert "nothing to restore" in empty["answer"], "空账本必须诚实回答"


def test_permission_grants_from_the_payload_reach_the_loop(monkeypatch, tmp_path) -> None:
    """权限授权条必须真的授权。

    ``main()`` 从来不读 ``permissionGrants``/``permissionDenials``/
    ``permissionGrantOnce``，也不把它们转给 ``answer_conversation``——三个可选
    参数在生产里恒为空元组。后果：run_command 是 LOCAL_IRREVERSIBLE，
    workspace-write 预设下永远 ask，模型按提示调 ask_user_question 求授权，
    用户点「本会话总是允许」，下一轮又被同一道门拦住——编程闭环走不完。
    """
    captured: dict[str, object] = {}

    def fake_answer(question, turns, obj, preset, **kwargs):
        captured.update(kwargs)
        return {"ok": True, "answer": "ok"}

    monkeypatch.setattr(conversation_bridge, "answer_conversation", fake_answer)
    monkeypatch.setattr(
        conversation_bridge,
        "read_bounded_json_payload",
        lambda: {
            "question": "跑测试",
            "permissionPreset": "workspace-write",
            "permissionGrants": ["run_command"],
            "permissionDenials": ["launch_app"],
            "permissionGrantOnce": ["write_file"],
        },
    )
    monkeypatch.setattr(conversation_bridge, "write_json", lambda value: None)

    import contextlib

    monkeypatch.setattr(
        conversation_bridge,
        "request_ai_config",
        lambda runtime: contextlib.nullcontext(),
    )

    assert conversation_bridge.main() == 0
    assert list(captured["permission_grants"]) == ["run_command"]
    assert list(captured["permission_denials"]) == ["launch_app"]
    assert list(captured["permission_grant_once"]) == ["write_file"]


def test_thread_grant_upgrades_run_command_past_the_ask_gate() -> None:
    """线程 memo 必须把 run_command 的 ask 抬成 allow（授权的全部意义）。"""
    from app.agent_runtime.permission_modes import PermissionDecision, decide_effect
    from app.agent_runtime.tool_registry import Effect

    assert decide_effect("default", Effect.LOCAL_IRREVERSIBLE) is PermissionDecision.ASK

    decisions = conversation_bridge._build_permission_decisions(
        ["run_command"], (), ()
    )
    assert decisions is not None
    assert decisions.lookup("run_command") == "allow"


def test_conversation_forwards_todo_store_so_the_plan_survives_compaction(monkeypatch) -> None:
    """Studio 对话必须把 todo_store 交给 loop。

    桥自己拿了 ``ctx.get("todo_store")``（挂 on_update 推计划卡、终态读回），
    但从来没有把它当参数传给 ``run_agent_turn``——于是 loop 里
    ``params.todo_store`` 恒为 None：①BUDGET_EXHAUSTED 的部分交付不带未完成
    步骤；②``_build_partial_delivery_message`` 拿不到计划。这是长任务的两个
    可见症状，恰好是 1.0.14 给 Stage 修过、却漏了对话路径的同一处接线。
    """
    captured: dict[str, object] = {}

    def fake_run_agent_turn(*args, **kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop here — we only need the kwargs")

    import app.fabric.engine as engine

    monkeypatch.setattr(engine, "run_agent_turn", fake_run_agent_turn)
    result = conversation_bridge.answer_conversation(
        "跑一下测试", [], {}, "workspace-write"
    )
    assert result["ok"] is False  # the fake raised; we assert on the wiring
    assert captured.get("todo_store") is not None, (
        "todo_store 必须过参数边界，否则压缩后计划回贴与部分交付都拿不到进度"
    )


def test_conversation_bridge_imports_under_isolated_python():
    """安装版以 ``python -I``（isolated）启动桥：sys.path 里没有 scripts/。

    1.0.24 真机事故：conversation_bridge 依赖「直接跑脚本会把脚本目录放进
    sys.path」这一默认行为，在 -I 下 import _bridge_common 直接炸——
    进程 exit 1 零输出，GUI 只看到 bridge_no_output。其它每座桥都在
    import 前自举 sys.path，conversation_bridge 必须同样自举。
    """
    import json
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        [sys.executable, "-I", "-X", "utf8", "scripts/conversation_bridge.py"],
        input='{"question":"hi","permissionPreset":"no-such-preset"}',
        capture_output=True,
        text=True,
        cwd=root,
        timeout=60,
    )
    assert proc.returncode == 2, f"stderr: {proc.stderr[-400:]}"
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    assert payload["ok"] is False
    assert "未知权限预设" in payload["error"]
    assert "ModuleNotFoundError" not in proc.stderr


def test_answer_conversation_passes_tool_result_dir_under_workspace(monkeypatch, tmp_path):
    """P1-3 收尾：超大工具结果要全文落盘 <workspace>/.mp/tool-results，
    桥必须把 tool_result_dir 传给 run_agent_turn，否则落盘层永远不激活。"""
    ws_dir = tmp_path / "profile-default"
    ws_dir.mkdir()
    import app.agent_runtime.workspace_state as workspace_state
    monkeypatch.setattr(workspace_state, "read_workspace", lambda root: ws_dir)

    captured = {}
    _install_workspace_boot_stubs(monkeypatch, captured)

    some_repo = tmp_path / "some-repo"
    some_repo.mkdir()
    result = conversation_bridge.answer_conversation(
        "看看这个仓库",
        [],
        {},
        "workspace-write",
        workspace_root=str(some_repo),
    )
    expected = str(some_repo / ".mp" / "tool-results")
    assert captured["run_kwargs"].get("tool_result_dir") == expected, (
        "显式工作区时 tool_result_dir 必须落在该工作区的 .mp/tool-results"
    )
    assert result["ok"] is True


def test_answer_conversation_tool_result_dir_defaults_to_profile_workspace(monkeypatch, tmp_path):
    import app.agent_runtime.workspace_state as workspace_state
    default_ws = tmp_path / "profile-default"
    default_ws.mkdir()
    monkeypatch.setattr(workspace_state, "read_workspace", lambda root: default_ws)

    captured = {}
    _install_workspace_boot_stubs(monkeypatch, captured)

    result = conversation_bridge.answer_conversation("看看", [], {}, "workspace-write")
    expected = str(default_ws / ".mp" / "tool-results")
    assert captured["run_kwargs"].get("tool_result_dir") == expected
    assert result["ok"] is True


def test_conversation_uses_128_tool_slots_for_direct_and_mcp_tools(monkeypatch) -> None:
    captured = {}
    _install_workspace_boot_stubs(monkeypatch, captured)

    result = conversation_bridge.answer_conversation(
        "查看可用工具", [], {}, "workspace-write"
    )

    assert result["ok"] is True
    assert captured["run_kwargs"]["tool_limit"] == 128


def test_slash_compact_replaces_surface_only_when_token_weight_drops(
    monkeypatch,
    tmp_path,
) -> None:
    from app.agent_runtime.session import FileSessionStore
    from app.agent_runtime.tool_registry import ToolRegistry
    from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role

    store = FileSessionStore(tmp_path / "sessions")
    session_id = conversation_bridge.resolve_agent_session_id(
        conversation_id="compact-conversation"
    )
    seeded = store.create(session_id)
    for index in range(5):
        seeded.append_message(AgentMessage(
            role=Role.USER if index % 2 == 0 else Role.ASSISTANT,
            content=(f"第 {index} 条历史 " + "长内容" * 40),
            tool_call_id=None,
            name=None,
            origin=ORIGIN_DATA,
        ))

    compacted = [AgentMessage(
        role=Role.USER,
        content="压缩后摘要",
        tool_call_id=None,
        name=None,
        origin=ORIGIN_DATA,
        injected=True,
    )]
    calls = {"compactor": 0, "loop": 0}

    def compactor(messages, *, force=False):
        calls["compactor"] += 1
        return list(compacted)

    def forbidden_loop(*args, **kwargs):
        calls["loop"] += 1
        raise AssertionError("/compact must not enter the agent loop")

    _install_runtime_service_stubs(
        monkeypatch,
        session_store=store,
        registry=ToolRegistry(),
        compactor=compactor,
        token_estimator=lambda messages: sum(len(message.content or "") for message in messages),
        run_impl=forbidden_loop,
    )

    result = conversation_bridge.answer_conversation(
        "/compact",
        [],
        {},
        "workspace-write",
        conversation_id="compact-conversation",
        workspace_root=str(tmp_path),
    )

    assert result["ok"] is True
    assert calls == {"compactor": 1, "loop": 0}
    assert "5 条消息" in result["answer"]
    assert "1 条" in result["answer"]
    assert "token" in result["answer"].lower()
    reopened = store.resume(session_id)
    replacements = [event for event in reopened.events if event.type == "surface/replace"]
    assert len(replacements) == 1
    assert replacements[0].data["reason"] == "manual_compaction"
    assert reopened.derive_messages() == compacted


def test_slash_compact_imports_legacy_electron_history_before_compacting(
    monkeypatch,
    tmp_path,
) -> None:
    from app.agent_runtime.memory import compact_messages
    from app.agent_runtime.session import FileSessionStore
    from app.agent_runtime.tool_registry import ToolRegistry
    from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role

    store = FileSessionStore(tmp_path / "sessions")
    seen_sources: list[str] = []

    def compactor(messages, *, force=False):
        return compact_messages(
            list(messages),
            lambda source: seen_sources.append(source) or "旧对话压缩摘要",
            force=force,
        )

    _install_runtime_service_stubs(
        monkeypatch,
        session_store=store,
        registry=ToolRegistry(),
        compactor=compactor,
        token_estimator=lambda messages: sum(len(message.content or "") for message in messages),
        run_impl=lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("/compact must not enter the agent loop")
        ),
    )

    result = conversation_bridge.answer_conversation(
        "/compact",
        [{
            "question": "旧 Electron 第一问" + "长内容" * 80,
            "answer": "旧 Electron 第一答" + "长回答" * 80,
        }],
        {"app": "Notepad", "windowTitle": "legacy.txt"},
        "workspace-write",
        conversation_id="legacy-compact-conversation",
        workspace_root=str(tmp_path),
    )

    assert result["ok"] is True
    assert seen_sources and "旧 Electron 第一问" in seen_sources[0]
    assert "[旧对话首次迁移]" in seen_sources[0]
    session_id = conversation_bridge.resolve_agent_session_id(
        conversation_id="legacy-compact-conversation"
    )
    reopened = store.resume(session_id)
    reopened_messages = reopened.derive_messages()
    assert len(reopened_messages) == 1
    assert "旧对话压缩摘要" in reopened_messages[0].content
    assert "<<<MAGIC_POINTER_EVIDENCE>>>" in reopened_messages[0].content
    replacements = [event for event in reopened.events if event.type == "surface/replace"]
    assert len(replacements) == 1
    assert replacements[0].data["reason"] == "manual_compaction"


def test_slash_compact_does_not_replace_when_compactor_saves_no_tokens(
    monkeypatch,
    tmp_path,
) -> None:
    from app.agent_runtime.session import FileSessionStore
    from app.agent_runtime.tool_registry import ToolRegistry
    from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role

    store = FileSessionStore(tmp_path / "sessions")
    session_id = conversation_bridge.resolve_agent_session_id(
        conversation_id="compact-no-gain"
    )
    seeded = store.create(session_id)
    seeded.append_message(AgentMessage(
        role=Role.USER,
        content="太短，没有可压缩空间",
        tool_call_id=None,
        name=None,
        origin=ORIGIN_DATA,
    ))

    _install_runtime_service_stubs(
        monkeypatch,
        session_store=store,
        registry=ToolRegistry(),
        compactor=lambda messages, **_kwargs: list(messages),
        token_estimator=lambda messages: sum(len(message.content or "") for message in messages),
        run_impl=lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("/compact must not enter the agent loop")
        ),
    )

    result = conversation_bridge.answer_conversation(
        "/compact",
        [],
        {},
        "workspace-write",
        conversation_id="compact-no-gain",
        workspace_root=str(tmp_path),
    )

    assert result["ok"] is True
    assert "未替换" in result["answer"] or "无需压缩" in result["answer"]
    reopened = store.resume(session_id)
    assert not any(event.type == "surface/replace" for event in reopened.events)


def test_slash_compact_does_not_erase_a_turn_completed_during_summary(
    monkeypatch,
    tmp_path,
) -> None:
    from app.agent_runtime.session import FileSessionStore
    from app.agent_runtime.tool_registry import ToolRegistry
    from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role

    store = FileSessionStore(tmp_path / "sessions")
    session_id = conversation_bridge.resolve_agent_session_id(
        conversation_id="compact-concurrent"
    )
    seeded = store.create(session_id)
    turn = seeded.start_turn()
    seeded.append_message(AgentMessage(
        role=Role.USER,
        content="old " * 500,
        tool_call_id=None,
        name=None,
        origin=ORIGIN_DATA,
    ))
    seeded.end_turn(turn, reason="completed")

    def compactor(_messages, *, force=False):
        concurrent = store.resume(session_id)
        concurrent_turn = concurrent.start_turn()
        concurrent.append_message(AgentMessage(
            role=Role.USER,
            content="new user",
            tool_call_id=None,
            name=None,
            origin=ORIGIN_DATA,
        ))
        concurrent.append_message(AgentMessage(
            role=Role.ASSISTANT,
            content="new answer",
            tool_call_id=None,
            name=None,
            origin=ORIGIN_DATA,
        ))
        concurrent.end_turn(concurrent_turn, reason="completed")
        return [AgentMessage(
            role=Role.USER,
            content="short summary",
            tool_call_id=None,
            name=None,
            origin=ORIGIN_DATA,
            injected=True,
        )]

    _install_runtime_service_stubs(
        monkeypatch,
        session_store=store,
        registry=ToolRegistry(),
        compactor=compactor,
        token_estimator=lambda messages: sum(len(message.content or "") for message in messages),
        run_impl=lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("/compact must not enter the agent loop")
        ),
    )

    result = conversation_bridge.answer_conversation(
        "/compact",
        [],
        {},
        "workspace-write",
        conversation_id="compact-concurrent",
        workspace_root=str(tmp_path),
    )

    assert result["ok"] is True
    assert "压缩期间对话收到新消息" in result["answer"]
    reopened = store.resume(session_id)
    contents = [message.content for message in reopened.derive_messages()]
    assert contents[-2:] == ["new user", "new answer"]
    assert not any(event.type == "surface/replace" for event in reopened.events)


def test_slash_help_lists_real_commands_skills_and_registry_tools_without_loop(
    monkeypatch,
    tmp_path,
) -> None:
    from app.agent_runtime.session import FileSessionStore
    from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

    registry = ToolRegistry()
    for name in ("Read", "Bash"):
        registry.register(ToolSpec(
            name=name,
            description=f"{name} test tool",
            input_schema={"type": "object", "properties": {}, "required": []},
            execute=lambda: None,
            effect=Effect.READ,
        ))

    class _Catalog:
        errors = []

        def __init__(self, *args, **kwargs):
            pass

        def list_skills(self):
            return [{"name": "demo-skill", "description": "演示技能"}]

        def load_skill_body(self, name):
            return None

    import app.agent_runtime.skill_catalog as skill_catalog
    monkeypatch.setattr(skill_catalog, "SkillCatalog", _Catalog)

    calls = {"loop": 0, "compactor": 0}

    def forbidden_loop(*args, **kwargs):
        calls["loop"] += 1
        raise AssertionError("/help must not enter the agent loop")

    def forbidden_compactor(messages):
        calls["compactor"] += 1
        raise AssertionError("/help must not compact")

    _install_runtime_service_stubs(
        monkeypatch,
        session_store=FileSessionStore(tmp_path / "sessions"),
        registry=registry,
        compactor=forbidden_compactor,
        token_estimator=lambda messages: 0,
        run_impl=forbidden_loop,
    )

    result = conversation_bridge.answer_conversation(
        "/help", [], {}, "workspace-write", workspace_root=str(tmp_path)
    )

    assert result["ok"] is True
    assert calls == {"loop": 0, "compactor": 0}
    assert "/compact" in result["answer"]
    assert "demo-skill" in result["answer"]
    assert "Read" in result["answer"]
    assert "Bash" in result["answer"]


def test_slash_help_reads_skills_from_the_bound_workspace(monkeypatch, tmp_path) -> None:
    from app.agent_runtime.session import FileSessionStore
    from app.agent_runtime.tool_registry import ToolRegistry

    skill_dir = tmp_path / ".agents" / "skills" / "workspace-help-proof"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: workspace-help-proof\ndescription: 只属于绑定工作区的技能\n---\n正文",
        encoding="utf-8",
    )
    _install_runtime_service_stubs(
        monkeypatch,
        session_store=FileSessionStore(tmp_path / "sessions"),
        registry=ToolRegistry(),
        compactor=lambda messages, **_kwargs: list(messages),
        token_estimator=lambda messages: 0,
        run_impl=lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("/help must not enter the agent loop")
        ),
    )

    result = conversation_bridge.answer_conversation(
        "/help", [], {}, "workspace-write", workspace_root=str(tmp_path)
    )

    assert result["ok"] is True
    assert "workspace-help-proof" in result["answer"]


def test_slash_skill_load_bumps_usage(tmp_path, monkeypatch) -> None:
    """P2-5：斜杠显式加载技能也要计入频次（MAGIC_POINTER_USER_DATA_DIR
    指向的用户目录里落 skill-usage.json）。"""
    import json

    from app.agent_runtime.skill_catalog import SkillCatalog

    user_data = tmp_path / "user-data"
    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(user_data))
    (tmp_path / ".agents" / "skills" / "demo-skill").mkdir(parents=True)
    (tmp_path / ".agents" / "skills" / "demo-skill" / "SKILL.md").write_text(
        "---\nname: demo-skill\ndescription: 演示\n---\n\n# 演示正文\n",
        encoding="utf-8",
    )
    catalog = SkillCatalog(project_root=tmp_path, user_home=tmp_path / "home")
    result = conversation_bridge.route_slash_command("/demo-skill 跑", catalog=catalog)
    assert result["ok"] is True
    usage_file = user_data / "skill-usage.json"
    assert usage_file.is_file(), "斜杠加载技能应落使用计数"
    assert json.loads(usage_file.read_text(encoding="utf-8"))["demo-skill"]["count"] == 1

def test_history_text_carries_scene_evidence() -> None:
    turns = [
        {
            "question": "这是啥呀。",
            "answer": "是一份实测分析笔记。",
            "evidence": {
                "label": "批注段",
                "capturePath": "D:/x/screen-abc123.png",
                "annotatedPath": "D:/x/screen-abc123.pointer.png",
                "contentDigest": "卡片动画逐帧实测笔记" * 40,
            },
        },
        {"question": "后来呢？", "answer": "后来没有下文。"},
    ]
    history = conversation_bridge._history_text(turns, {})
    assert "第1轮现场证据" in history
    assert "对象：批注段" in history
    assert "screen-abc123.png" in history
    assert "当时读取到的内容" in history
    # 没有证据的轮次不添乱
    assert "后来没有下文" in history
    assert history.count("现场证据") == 1


def test_strip_options_tail_removes_numbered_list_only() -> None:
    question = "是否允许执行 Get-Clipboard?"
    options = ["仅这一次允许", "本会话总是允许Bash命令", "拒绝"]
    result = {
        "ok": True,
        "answer": question + "\n\n" + "\n".join(f"{i}. {o}" for i, o in enumerate(options, 1)),
        "awaitingUserInput": True,
        "pendingInput": {"question": question, "options": options},
    }
    stripped = conversation_bridge._strip_options_tail(result)
    assert stripped["answer"] == question, "编号选项尾巴必须裁掉，审批卡来接"
    assert stripped["pendingInput"]["options"] == options, "结构化选项原样保留"


def test_strip_options_tail_leaves_real_content_alone() -> None:
    result = {
        "ok": True,
        "answer": "步骤如下：\n\n1. 先读文件\n2. 再改代码",
        "pendingInput": None,
    }
    assert conversation_bridge._strip_options_tail(result)["answer"].endswith("再改代码")
