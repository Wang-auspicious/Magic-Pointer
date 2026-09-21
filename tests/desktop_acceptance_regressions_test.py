"""Regressions from the installed 1.0.50 desktop acceptance session."""

import io
import json
import os
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path

import pytest

from app.agent_runtime.ask_todo_tools import register_todo_write
from app.agent_runtime.coding_tools import register_coding_tools
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.todo_store import TodoStore
from app.agent_runtime.tool_registry import ToolRegistry


def test_session_bridge_isolated_entry_supports_steer_and_cancel(tmp_path):
    session = FileSessionStore(tmp_path / "agent-sessions").create("isolated-desktop")
    session.start_turn()
    script = Path(__file__).resolve().parents[1] / "scripts/agent_session_bridge.py"
    env = {**os.environ, "MAGIC_POINTER_USER_DATA_DIR": str(tmp_path)}
    for action, extra in [
        ("put", {"text": "继续核对", "target": "next-step"}),
        ("pending", {"target": "next-step"}),
        ("cancel", {}),
    ]:
        result = subprocess.run(
            [sys.executable, "-I", "-X", "utf8", str(script)],
            input=json.dumps({"action": action, "sessionId": "isolated-desktop", **extra}),
            capture_output=True, text=True, encoding="utf-8", env=env, timeout=20,
        )
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload["ok"], payload
        if action == "pending":
            assert payload["messages"][0]["text"] == "继续核对"


def test_conversation_bridge_accepts_realistic_history_payload(monkeypatch):
    from scripts import conversation_bridge as bridge

    payload = {"question": "继续核验", "turns": [{"question": "q", "answer": "a",
                "trajectory": [{"text": "材料" * 25000}]}]}
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload, ensure_ascii=False)))
    monkeypatch.setattr(bridge, "force_utf8_stdio", lambda: None)
    monkeypatch.setattr(bridge, "request_ai_config", lambda _: nullcontext())
    received = []
    monkeypatch.setattr(bridge, "answer_conversation", lambda *args, **kwargs:
                        received.append(args) or {"ok": True})
    monkeypatch.setattr(bridge, "write_json", lambda _: None)
    assert bridge.main() == 0
    assert received[0][1] == payload["turns"]


def _coding(tmp_path):
    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=tmp_path)
    return registry


def test_write_returns_verified_persistence_not_semantic_claim(tmp_path):
    registry = _coding(tmp_path)
    result = json.loads(registry.get("Write").execute(path="report.md", content="报告\n"))
    assert result["verification"] == {
        "matched": True, "method": "file_bytes_readback", "scope": "persistence_only",
    }
    assert (tmp_path / "report.md").read_bytes() == "报告\n".encode()


def test_csv_write_is_excel_readable_and_rejects_shifted_total(tmp_path):
    registry = _coding(tmp_path)
    registry.get("Write").execute(path="good.csv", content="订单,金额\nO101,120\n合计,=SUM(B2:B2)\n")
    raw = (tmp_path / "good.csv").read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    assert raw.count(b"\r\n") == 3
    with pytest.raises(ValueError, match="column"):
        registry.get("Write").execute(path="bad.csv", content="订单,金额\n合计,,=SUM(B2:B2)\n")
    assert not (tmp_path / "bad.csv").exists()


def test_blocked_todo_survives_runtime_and_compaction():
    registry = ToolRegistry()
    store = TodoStore()
    register_todo_write(registry, sink=store.write)
    registry.get("Todo").execute(todos=[{"content": "Excel source not granted", "status": "blocked"}])
    assert store.read()[0]["status"] == "blocked"
    assert "blocked" in store.format_for_injection()


def test_named_application_binding_is_task_scoped_and_unambiguous(tmp_path):
    from app.context_pack.desktop_binding import bind_named_windows
    from app.context_pack.source_scope import AccessRequest, authorize_access, scope_from_events

    session = FileSessionStore(tmp_path / "sessions").create("native-task")
    windows = [{"hwnd": 42, "pid": 12, "process_name": "EXCEL.EXE", "title": "sales.csv - Excel"},
               {"hwnd": 99, "pid": 13, "process_name": "notepad.exe", "title": "private.txt"}]
    sources = bind_named_windows(session, "请在Excel里继续处理销售数据", windows)
    assert [s.identity["hwnd"] for s in sources] == [42]
    scope = scope_from_events(session.events, task_id=session.id)
    assert authorize_access(scope, AccessRequest("read", source_ids=(sources[0].source_id,))).allowed
    assert authorize_access(scope, AccessRequest("patch", window_ids=("w-42",))).allowed
    assert not authorize_access(scope, AccessRequest("read", window_ids=("w-99",))).allowed
    assert not authorize_access(scope, AccessRequest("send", window_ids=("w-42",))).allowed
    event_count = len(session.events)
    bind_named_windows(session, "Excel", windows)
    assert len(session.events) == event_count
    ambiguous = windows + [{**windows[0], "hwnd": 43, "title": "other.xlsx - Excel"}]
    assert bind_named_windows(session, "请在Excel里处理", ambiguous) == []
    assert [s.identity["hwnd"] for s in bind_named_windows(session, "处理 sales.csv", ambiguous)] == [42]
    assert bind_named_windows(session, "notepadPlus", windows) == []


def test_launch_resolves_registered_desktop_apps_without_shell(monkeypatch, tmp_path):
    from app.desktop_actions import session as desktop

    executable = tmp_path / "Office" / "EXCEL.EXE"
    executable.parent.mkdir()
    executable.touch()
    monkeypatch.setattr(desktop, "_registered_app_path", lambda name: str(executable) if name.casefold() == "excel.exe" else None, raising=False)
    calls = []
    monkeypatch.setattr(desktop.subprocess, "Popen", lambda argv, **kwargs: calls.append((argv, kwargs)))
    assert desktop._known_app("excel")
    assert desktop._live_launch("EXCEL.EXE")["ok"]
    assert calls[0][0] == [str(executable)]
    assert not calls[0][1].get("shell")
    assert not desktop._known_app("missing-fictional-app")


def test_foreground_handoff_detaches_and_verifies():
    from types import SimpleNamespace
    from app.computer_operator.windows import Win32InputDriver

    calls = []
    foreground = [99]
    attached = [False]
    def attach(current, other, enabled):
        calls.append((current, other, enabled))
        attached[0] = enabled
        return True
    def focus(hwnd):
        if attached[0]:
            foreground[0] = hwnd
    driver = Win32InputDriver.__new__(Win32InputDriver)
    driver._kernel32 = SimpleNamespace(GetCurrentThreadId=lambda: 7)
    driver._user32 = SimpleNamespace(
        IsIconic=lambda hwnd: False, SetForegroundWindow=focus,
        GetWindowThreadProcessId=lambda hwnd, pid: 8,
        AttachThreadInput=attach, BringWindowToTop=lambda hwnd: None,
    )
    driver.foreground_window = lambda: foreground[0]
    driver.activate(42)
    assert foreground[0] == 42
    assert calls == [(7, 8, True), (7, 8, False)]


def test_multiple_written_files_finish_without_redundant_verification_loop(tmp_path):
    import asyncio
    import importlib.util
    from app.agent_runtime.loop import VerificationNudged, run_agent_loop
    from app.agent_runtime.model_client import LoopModelClient, MessageDelta, ToolCallArrived, TurnDone
    from app.agent_runtime.types import ToolCall

    spec = importlib.util.spec_from_file_location("desktop_loop_fakes", Path(__file__).with_name("agent_runtime_loop_test.py"))
    fakes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fakes)
    rounds = [[ToolCallArrived(call=ToolCall(id=f"w{i}", name="Write", arguments={"path": f"r{i}.md", "content": f"报告{i}"})), TurnDone(usage=None, raw_text=None)] for i in range(4)]
    backend = fakes.ScriptedBackend(*rounds, [MessageDelta(text="四份文件已写入。"), TurnDone(usage=None, raw_text=None)])
    params = fakes.make_params("写四份文件", registry=_coding(tmp_path), client=LoopModelClient(backend))
    async def collect():
        return [event async for event in run_agent_loop(params)]
    events = asyncio.run(collect())
    assert not any(isinstance(event, VerificationNudged) for event in events)
    assert events[-1].terminal.reason.value == "completed"
    assert len(list(tmp_path.glob("r*.md"))) == 4


def test_desktop_runtime_binds_named_window_before_observe_scope_check(tmp_path, monkeypatch):
    import importlib.util
    from types import SimpleNamespace
    from app.context_pack.source_scope import authorize_access, scope_from_events
    from app.desktop_actions import session as desktop

    spec = importlib.util.spec_from_file_location("desktop_bundle_fakes", Path(__file__).with_name("harness_builtin_bundle_test.py"))
    fakes = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fakes)
    session = FileSessionStore(tmp_path / "sessions").create("named-runtime")
    monkeypatch.setattr(desktop, "_live_driver", lambda: SimpleNamespace())
    monkeypatch.setattr(desktop, "_live_windows", lambda: [
        {"hwnd": 42, "pid": 12, "process_name": "EXCEL.EXE", "title": "sales.csv - Excel", "rect": [0, 0, 800, 600]},
    ])
    monkeypatch.setattr(desktop, "_live_elements", lambda hwnd: [])
    report = fakes.boot_loop_context(fakes._runtime(source_session_getter=lambda: session, task_instruction="在Excel里核对数据"))
    try:
        observe = report.ctx.get("tools").get("Observe")
        access = observe.access_for({"window_id": "w-42", "mode": "ax"})
        assert access.source_ids == ("window-42-12",)
        assert authorize_access(scope_from_events(session.events, task_id=session.id), access).allowed
        result = observe.execute(window_id="w-42", mode="ax")
        assert result["windows"][0]["hwnd"] == 42
        assert result["snapshot_id"]
    finally:
        report.ctx.unload()
