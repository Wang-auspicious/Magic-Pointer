"""Real file operations must retain verification across loop guardrail guidance."""

import asyncio
import importlib.util
from pathlib import Path

from app.agent_runtime.coding_tools import register_coding_tools
from app.agent_runtime.loop import VerificationNudged, run_agent_loop
from app.agent_runtime.model_client import LoopModelClient, MessageDelta, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.types import ToolCall


def _run_files(tmp_path, calls):
    spec = importlib.util.spec_from_file_location(
        "verification_guardrail_fakes", Path(__file__).with_name("agent_runtime_loop_test.py"),
    )
    fakes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fakes)
    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=tmp_path)
    scenes = [
        [ToolCallArrived(call=ToolCall(id=f"c{i}", name=name, arguments=arguments)),
         TurnDone(usage=None, raw_text=None)]
        for i, (name, arguments) in enumerate(calls)
    ]
    final = [MessageDelta(text="文件已写入并读回。"), TurnDone(usage=None, raw_text=None)]
    backend = fakes.ScriptedBackend(*scenes, final, final)
    session = FileSessionStore(tmp_path / "sessions").create("file-verification")
    params = fakes.make_params(
        "更新并核对文件", registry=registry, client=LoopModelClient(backend), session=session,
    )

    async def collect():
        return [event async for event in run_agent_loop(params)]

    return asyncio.run(collect()), session


def test_successful_write_warning_preserves_its_real_readback_receipt(tmp_path):
    calls = [("Write", {"path": "result.txt", "content": "confirmed\n"})] * 2
    events, session = _run_files(tmp_path, calls)
    terminal = events[-1].terminal
    assert terminal.reason.value == "completed"
    assert "repeated_successful_action_warning" in terminal.results[-1].value
    assert not any(isinstance(event, VerificationNudged) for event in events)
    receipt = [event.data for event in session.events if event.type == "receipt/issued"][-1]
    assert receipt["verified"] is True
    assert receipt["status"] == "succeeded"


def test_template_files_each_written_then_read_do_not_stall_on_matching_content(tmp_path):
    calls = []
    for index in range(4):
        path = f"package-{index}/README.md"
        calls.extend([
            ("Write", {"path": path, "content": "# Checklist\n"}),
            ("Read", {"path": path}),
        ])
    events, _session = _run_files(tmp_path, calls)
    terminal = events[-1].terminal
    assert terminal.reason.value == "completed"
    assert len(terminal.results) == 8
    assert all(not result.is_error for result in terminal.results)
    assert all("duplicate_read_evidence" not in result.value for result in terminal.results)
    assert not any(isinstance(event, VerificationNudged) for event in events)
