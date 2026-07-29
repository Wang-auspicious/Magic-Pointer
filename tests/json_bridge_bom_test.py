from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _run(relative: str, payload: dict[str, object], tmp_path: Path, *args: str) -> dict[str, object]:
    env = {
        key: os.environ[key]
        for key in (
            "PATH",
            "PATHEXT",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
            "APPDATA",
            "USERPROFILE",
        )
        if key in os.environ
    }
    env["MAGIC_POINTER_USER_DATA_DIR"] = str(tmp_path)
    completed = subprocess.run(
        [sys.executable, str(ROOT / relative), *args],
        cwd=ROOT,
        input=("\ufeff" + json.dumps(payload, ensure_ascii=False)).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
        timeout=20,
    )
    assert completed.returncode == 0, completed.stderr.decode("utf-8", errors="replace")
    return json.loads(completed.stdout.decode("utf-8"))


def test_agent_and_fabric_bridges_accept_utf8_bom(tmp_path: Path) -> None:
    agent = _run("scripts/agent_bridge.py", {"operation": "providers"}, tmp_path / "agent")
    fabric = _run("scripts/fabric_bridge.py", {"operation": "catalog"}, tmp_path / "fabric")
    assert agent["ok"] is True
    assert fabric["ok"] is True


def test_agent_hook_accepts_utf8_bom(tmp_path: Path) -> None:
    result = _run(
        "scripts/agent_hook_bridge.py",
        {"hook_event_name": "UserPromptSubmit", "prompt": "hello"},
        tmp_path / "hook",
        "--provider",
        "claude",
    )
    assert "systemMessage" not in result
