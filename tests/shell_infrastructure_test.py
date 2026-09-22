
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from app.agent_runtime.coding_tools import (
    _DEFAULT_COMMAND_TIMEOUT_S,
    register_coding_tools,
)
from app.agent_runtime.tool_registry import Effect, ToolRegistry


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    (root / "sub").mkdir(parents=True)
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text(
        "line1\nline2 target\nline3\nline4\nline5\n", encoding="utf-8"
    )
    return root


@pytest.fixture()
def registry(ws: Path) -> ToolRegistry:
    reg = ToolRegistry()
    register_coding_tools(reg, workspace_root=ws)
    return reg


def _run(registry: ToolRegistry, command: str, **kw):
    return registry.execute_tool("run_command", {"command": command, **kw})




@pytest.mark.skipif(os.name != "nt", reason="Windows cmd 语义")
def test_cd_persists_across_calls_windows(registry: ToolRegistry, ws: Path) -> None:
    ok = _run(registry, "cd sub")
    assert ok.is_error is False, ok.error_message
    probe = _run(registry, 'python -c "import os;print(os.getcwd())"')
    value = str(probe.value or "")
    assert "@@MP_CWD" not in value, "marker 行必须从输出里剥掉"
    value_lines = [line for line in value.splitlines() if line.strip()]
    assert str(ws / "sub").lower() in value.lower(), value


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd 语义")
def test_explicit_cwd_does_not_persist(registry: ToolRegistry, ws: Path) -> None:
    _run(registry, "cd sub")
    probe = _run(
        registry,
        'python -c "import os;print(os.getcwd())"',
        cwd=str(ws / "src"),
    )
    assert "src" in str(probe.value or "")
    back = _run(registry, 'python -c "import os;print(os.getcwd())"')
    assert str(ws / "sub").lower() in str(back.value or "").lower(), (
        "显式 cwd 参数只影响本条命令，会话 cwd 不被改走"
    )


def test_shell_state_shared_per_workspace_across_registrations(ws: Path) -> None:
    reg1 = ToolRegistry()
    register_coding_tools(reg1, workspace_root=ws)
    reg2 = ToolRegistry()
    register_coding_tools(reg2, workspace_root=ws)
    if os.name == "nt":
        reg1.execute_tool("run_command", {"command": "cd sub"})
        probe = reg2.execute_tool(
            "run_command", {"command": 'python -c "import os;print(os.getcwd())"'}
        )
        assert str(ws / "sub").lower() in str(probe.value or "").lower()




def test_background_job_reports_exit_code(registry: ToolRegistry, ws: Path) -> None:
    started = _run(
        registry,
        'python -c "import sys;sys.exit(3)"',
        background=True,
    )
    assert started.is_error is False
    job_id = int(str(started.value).split("job ")[1].split(";")[0])
    deadline = time.time() + 15
    status = ""
    while time.time() < deadline:
        status = str(
            registry.execute_tool("read_background", {"id": job_id}).value or ""
        )
        if "exit=" in status:
            break
        time.sleep(0.3)
    assert "exit=3" in status, f"job 结束后 read_background 必须报 exit code: {status}"


def test_background_completion_pushes_inbox(tmp_path: Path) -> None:
    received: list[str] = []
    reg = ToolRegistry()
    register_coding_tools(
        reg, workspace_root=tmp_path,
        inbox=lambda text: received.append(text),
    )
    reg.execute_tool(
        "run_command",
        {"command": 'python -c "print(1)"', "background": True},
    )
    deadline = time.time() + 15
    while time.time() < deadline and not received:
        time.sleep(0.2)
    assert received, "后台 job 结束必须推 durable inbox 消息"
    assert "exit=0" in received[0]




def test_grep_context_lines(registry: ToolRegistry) -> None:
    result = registry.execute_tool("grep", {
        "pattern": "target",
        "path": "src",
        "context": 1,
    })
    value = str(result.value or "")
    assert "line2" in value
    assert "line1" in value and "line3" in value, "context=1 必须带相邻行"
    assert "line5" not in value


def test_grep_offset_pagination(registry: ToolRegistry) -> None:
    (first := registry.execute_tool("grep", {"pattern": "line", "path": "src"}))
    again = registry.execute_tool("grep", {
        "pattern": "line",
        "path": "src",
        "offset": 3,
    })
    first_lines = [
        line for line in str(first.value or "").splitlines() if ": " in line
    ]
    again_lines = [
        line for line in str(again.value or "").splitlines() if ": " in line
    ]
    assert len(first_lines) == 5
    assert len(again_lines) == 2, "offset=3 跳过前三条命中（5-3=2）"
    assert again_lines[0] not in first_lines[:3]


def test_grep_masks_credential_files(registry: ToolRegistry, ws: Path) -> None:
    (ws / ".env").write_text("API_KEY=super-secret-123\n", encoding="utf-8")
    result = registry.execute_tool("grep", {"pattern": "API_KEY"})
    value = str(result.value or "")
    assert "API_KEY" in value
    assert "super-secret-123" not in value, ".env 命中内容必须打码"




def test_glob_sorts_recent_first(registry: ToolRegistry, ws: Path) -> None:
    old = ws / "old.txt"
    new = ws / "new.txt"
    old.write_text("o", encoding="utf-8")
    time.sleep(0.05)
    new.write_text("n", encoding="utf-8")
    os.utime(old, (time.time() - 10_000, time.time() - 10_000))
    result = registry.execute_tool("glob", {"pattern": "*.txt"})
    value = str(result.value or "")
    assert value.index("new.txt") < value.index("old.txt"), value




def test_readonly_allowlist_includes_git_read_and_rg(registry: ToolRegistry) -> None:
    resolve = registry.resolve_effect
    assert resolve("run_command", {"command": "git status"}) is Effect.READ
    assert resolve("run_command", {"command": "git log --oneline -5"}) is Effect.READ
    assert resolve("run_command", {"command": "git diff HEAD"}) is Effect.READ
    assert resolve("run_command", {"command": "rg pattern src"}) is Effect.READ
    assert resolve("run_command", {"command": "git push"}) is Effect.LOCAL_IRREVERSIBLE
    assert resolve("run_command", {"command": "git commit -m x"}) is Effect.LOCAL_IRREVERSIBLE


def test_default_command_timeout_is_generous() -> None:
    assert _DEFAULT_COMMAND_TIMEOUT_S == 300.0
