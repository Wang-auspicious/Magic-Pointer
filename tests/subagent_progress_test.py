from __future__ import annotations

from types import SimpleNamespace

from app.agent_runtime.subagent import register_delegate_tool
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import Terminal, TransitionReason


def test_delegate_inherits_effort_and_allows_explicit_override(monkeypatch, tmp_path):
    from app.fabric import engine as engine_module
    captured = []

    class Provider:
        def create_client(self, **kwargs):
            captured.append(kwargs)
            return object()

    monkeypatch.setattr(engine_module, "run_agent_turn", lambda *args, **kwargs: Terminal(
        reason=TransitionReason.COMPLETED, message="done", turns=1, results=()))
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=Provider(), workspace_root=tmp_path,
                           effort="low")
    assert not registry.execute_tool("Agent", {"task": "inspect", "readonly": True}).is_error
    assert captured[-1]["effort"] == "low"
    assert not registry.execute_tool("Agent", {"task": "inspect", "readonly": True, "effort": "xhigh"}).is_error
    assert captured[-1]["effort"] == "xhigh"


def test_resume_inherits_readonly_and_remembers_effort_override(monkeypatch, tmp_path):
    from app.fabric import engine as engine_module
    captured = []
    monkeypatch.setattr(engine_module, 'run_agent_turn', lambda *args, **kwargs: Terminal(
        reason=TransitionReason.COMPLETED, message='done', turns=1, results=()))
    provider = SimpleNamespace(create_client=lambda **kwargs: captured.append(kwargs) or object())
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=provider, workspace_root=tmp_path,
        effort='low', id_factory=lambda: 'remember-child')
    assert not registry.execute_tool('Agent', {'task': 'inspect', 'readonly': True}).is_error
    assert not registry.execute_tool('Agent', {'task': 'continue', 'resume_id': 'remember-child', 'effort': 'max'}).is_error
    assert captured[-1]['effort'] == 'max'
    assert not registry.execute_tool('Agent', {'task': 'continue again', 'resume_id': 'remember-child'}).is_error
    assert captured[-1]['effort'] == 'max'


def test_delegate_emits_truthful_child_progress(monkeypatch, tmp_path) -> None:
    from app.fabric import engine as engine_module

    emitted: list[dict] = []

    def fake_run(prompt, registry=None, client=None, event_sink=None, **kwargs):
        event_sink(SimpleNamespace(kind="loop_start"))
        event_sink(SimpleNamespace(kind="turn_started", turn=1))
        event_sink(SimpleNamespace(kind="tool_call_started", id="child-call-1", name="Read"))
        event_sink(
            SimpleNamespace(
                kind="tool_call_finished",
                result=SimpleNamespace(
                    tool_call_id="child-call-1",
                    tool_name="Read",
                    arguments={"path": "README.md"},
                    value="file body",
                    error_message=None,
                    is_error=False,
                    used_backend="filesystem",
                    latency_ms=12.5,
                ),
            )
        )
        return Terminal(
            reason=TransitionReason.COMPLETED,
            message="检查完成。",
            turns=1,
            results=(),
        )

    monkeypatch.setattr(engine_module, "run_agent_turn", fake_run)

    class Provider:
        def create_client(self, **kwargs):
            return object()

    registry = ToolRegistry()
    register_delegate_tool(
        registry,
        llm_provider=Provider(),
        workspace_root=tmp_path,
        subagent_event_sink=emitted.append,
        id_factory=lambda: "child-fixed",
    )

    result = registry.execute_tool(
        "Agent",
        {"task": "审查设置页", "readonly": True},
    )

    assert result.is_error is False
    assert str(result.value).startswith(
        "[subagent id=child-fixed status=completed steps=1]"
    )
    assert {key: emitted[0][key] for key in (
        "id", "description", "readonly", "status", "stepCount", "currentTool", "steps"
    )} == {
        "id": "child-fixed",
        "description": "审查设置页",
        "readonly": True,
        "status": "running",
        "stepCount": 0,
        "currentTool": "",
        "steps": [],
    }
    assert emitted[-1]["status"] == "completed"
    assert emitted[-1]["stepCount"] == 1
    assert emitted[-1]["summary"] == "检查完成。"
    assert emitted[-1]["steps"] == [
        {
            "index": 1,
            "callId": "child-call-1",
            "tool": "Read",
            "status": "completed",
            "input": '{"path":"README.md"}',
            "output": "file body",
            "usedBackend": "filesystem",
            "latencyMs": 12.5,
        }
    ]


def test_builtin_delegate_row_forwards_visual_progress_sink(monkeypatch, tmp_path) -> None:
    from app.agent_runtime import subagent as subagent_module
    from app.harness.builtin_bundle import _apply_delegate_tool

    captured: dict = {}

    def fake_register(registry, **kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(subagent_module, "register_delegate_tool", fake_register)
    sink = lambda payload: None

    class Fork:
        def get(self, name):
            return object()

    _apply_delegate_tool(
        Fork(),
        {
            "workspace_root": str(tmp_path),
            "permission_mode": "default",
            "subagent_event_sink": sink,
        },
    )

    assert captured["subagent_event_sink"] is sink


def test_parallel_children_stream_before_tools_and_keep_parent_identity(monkeypatch, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from app.fabric import engine as engine_module

    barrier = Barrier(2)
    emitted = []

    def run(prompt, event_sink, **kwargs):
        barrier.wait(timeout=5)
        event_sink(SimpleNamespace(kind="turn_started", turn=1))
        event_sink(SimpleNamespace(kind="reasoning_chunk", text=f"thinking {prompt}"))
        assert any(p.get("reasoning") == f"thinking {prompt}" for p in emitted)
        for _ in range(100):
            event_sink(SimpleNamespace(kind="model_chunk", text="x"))
        return Terminal(reason=TransitionReason.COMPLETED, message=prompt, turns=1, results=())

    monkeypatch.setattr(engine_module, "run_agent_turn", run)
    provider = SimpleNamespace(create_client=lambda **_: SimpleNamespace(model="test-model"))
    registry = ToolRegistry()
    register_delegate_tool(registry, llm_provider=provider, workspace_root=tmp_path, subagent_event_sink=emitted.append)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda task: registry.execute_tool("Agent", {"task": task, "readonly": True}, tool_call_id=task), ["a", "b"]))
    assert all(not r.is_error for r in results)
    assert len(emitted) < 20, "token bursts must coalesce instead of serializing every snapshot"
    for task in ("a", "b"):
        child = [p for p in emitted if p["description"] == task]
        assert child and all(p["parentCallId"] == task for p in child)
        assert child[-1]["answer"] == "x" * 100, "terminal snapshot must flush the last tokens"
        assert child[-1]["reasoning"] == f"thinking {task}"
        assert child[-1]["elapsedMs"] >= 0


def test_child_progress_survives_completed_parent_trajectory():
    from app.agent_runtime.activity_projection import RuntimeActivitySink, completed_trajectory
    clock = SimpleNamespace(mark=lambda *a, **k: 0, mark_blob=lambda *a: 0)
    sink = RuntimeActivitySink(clock)
    sink(SimpleNamespace(kind="tool_call_started", id="parent", name="Agent", arguments={"task": "audit"}))
    sink.subagent_progress({"id": "child", "parentCallId": "parent", "status": "completed", "reasoning": "Read sources"})
    records = completed_trajectory({"answer": "done"}, sink.trajectory)
    assert next(r for r in records if r.get("callId") == "parent")["subagent"]["reasoning"] == "Read sources"
