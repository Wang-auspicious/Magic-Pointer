from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.subagent import register_delegate_tool
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import AgentMessage, Role, Terminal, TransitionReason
from app.governance.cancellation import CancellationToken
from app.governance import Stage


def test_delegate_has_durable_budget_compaction_and_resume(monkeypatch, tmp_path):
    from app.fabric import engine

    parent = FileSessionStore(tmp_path / "sessions").create("parent")
    captured = []

    def run(prompt, **kwargs):
        captured.append(kwargs)
        session = kwargs["session"]
        turn = session.start_turn()
        session.append_message(AgentMessage(Role.USER, prompt, None, None))
        session.end_turn(turn, reason="user_interrupt" if len(captured) == 1 else "completed")
        return Terminal(reason=TransitionReason.USER_INTERRUPT if len(captured) == 1 else TransitionReason.COMPLETED, message="partial", turns=1, results=())

    monkeypatch.setattr(engine, "run_agent_turn", run)
    provider = type("Provider", (), {"create_client": lambda self, **kwargs: object()})()
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=provider, workspace_root=tmp_path, parent_session_getter=lambda: parent, id_factory=lambda: "child")
    first = registry.execute_tool("Agent", {"task": "inspect"})
    assert first.is_error
    config = captured[0]
    assert config["budgets"][Stage.FULL_ANSWER].budget_ms >= 60_000
    assert callable(config["compactor"])
    assert callable(config["token_estimator"])
    assert config["token_estimator"]([]) > 0
    assert config["context_budget_tokens"] > 0
    assert config["tool_result_dir"]
    assert config["session"].header.parent_session_id == parent.id
    assert any(e.type == "subagent/created" for e in parent.events)
    second = registry.execute_tool("Agent", {"task": "continue", "resume_id": "child"})
    assert not second.is_error
    assert captured[1]["session"].next_turn == 3
    assert len(captured[1]["session"].derive_messages()) == 2


def test_delegate_interrupt_propagates_parent_scope(monkeypatch, tmp_path):
    from app.fabric import engine

    token = CancellationToken()
    def run(prompt, **kwargs):
        token.cancel()
        assert kwargs["interrupt_check"]()
        return Terminal(reason=TransitionReason.USER_INTERRUPT, message="stopped", turns=1, results=())

    monkeypatch.setattr(engine, "run_agent_turn", run)
    provider = type("Provider", (), {"create_client": lambda self, **kwargs: object()})()
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=provider, workspace_root=tmp_path)
    result = registry.execute_tool("Agent", {"task": "inspect"}, scope=token)
    assert result.is_error
    assert "stopped" in result.error_message


def test_fork_completed_turn_excludes_later_state(tmp_path):
    store = FileSessionStore(tmp_path)
    parent = store.create("parent")
    for content in ("first", "second"):
        turn = parent.start_turn()
        parent.append_message(AgentMessage(Role.USER, content, None, None))
        parent.end_turn(turn, reason="completed")
    child = store.fork("parent", "child", through_turn=1)
    assert [m.content for m in child.derive_messages()] == ["first"]
    assert child.next_turn == 2


def test_child_runs_real_loop_and_resumes_logged_history(tmp_path):
    from agent_runtime_loop_test import ScriptedBackend
    from app.agent_runtime.model_client import LoopModelClient, TurnDone

    backends = []
    class Provider:
        def create_client(self, **kwargs):
            backend = ScriptedBackend([TurnDone(usage=None, raw_text="finished")])
            backends.append(backend)
            return LoopModelClient(backend)

    parent = FileSessionStore(tmp_path / "sessions").create("parent")
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=Provider(), workspace_root=tmp_path,
                           parent_session_getter=lambda: parent, id_factory=lambda: "child")
    first = registry.execute_tool("Agent", {"task": "remember FIRST_FACT"})
    assert not first.is_error, first.error_message
    second = registry.execute_tool("Agent", {"task": "continue SECOND_FACT", "resume_id": "child"})
    assert not second.is_error, second.error_message
    child = FileSessionStore(parent.path.parent).resume("child")
    assert child.next_turn == 3
    assert len([e for e in child.events if e.type == "model/request"]) == 2
    assert "FIRST_FACT" in str(backends[1].received[0][0])
    assert backends[0].received[0][2] >= 60_000
