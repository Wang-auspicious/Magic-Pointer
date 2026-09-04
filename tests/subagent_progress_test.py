from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from app.agent_runtime.subagent import register_delegate_tool
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import Terminal, TransitionReason


def test_delegate_emits_truthful_child_progress(monkeypatch) -> None:
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
        workspace_root=Path("."),
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
    assert emitted[0] == {
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
