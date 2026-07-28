from __future__ import annotations

import subprocess
from pathlib import Path

from app.fabric.capture_policy import CaptureDecision
from app.fabric.context_packet import ContextPacketBuilder, build_agent_prompt
from app.fabric.runtime_workspace import RuntimeWorkspaceResolver


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init", "-b", "main"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "pointer@example.test"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Pointer"], check=True)
    (repo / "app.js").write_text("console.log('one')\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "app.js"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "init"], check=True, capture_output=True)
    (repo / "app.js").write_text("console.log('two')\n", encoding="utf-8")
    return repo


def _decision() -> CaptureDecision:
    return CaptureDecision(
        object_id="screen-1",
        configured_mode="structured_only",
        mode="structured_only",
        allow_structure=True,
        allow_local_pixels=False,
        allow_upload=False,
        reason="test",
    )


def test_localhost_ui_binds_listener_process_repo_and_redacts_launch_secret(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    records = {
        100: {"pid": 100, "parentPid": 0, "cwd": str(tmp_path), "executablePath": "C:/Edge/msedge.exe", "commandLine": "msedge.exe"},
        200: {"pid": 200, "parentPid": 0, "cwd": str(repo), "executablePath": "C:/node/node.exe", "commandLine": "node vite --token top-secret"},
    }
    resolver = RuntimeWorkspaceResolver(
        process_probe=lambda pid: records.get(pid),
        listener_probe=lambda port: 200 if port == 5173 else None,
    )
    pointed = {
        "id": "screen-1",
        "kind": "screen_region",
        "content": "broken button",
        "source": {"processId": 100, "app": "msedge.exe", "url": "http://localhost:5173/settings"},
    }
    packet = ContextPacketBuilder(runtime_resolver=resolver).build(
        command="修复这个界面",
        recipe_id="agent.handoff",
        objects=[pointed],
        cwd=tmp_path,
        target_lease={"leaseId": "lease"},
        capture_decisions=[_decision()],
        capabilities=[],
    )
    binding = packet["runtime"]["processBinding"]

    assert binding["state"] == "bound"
    assert binding["relation"] == "localhost_listener"
    assert binding["targetProcessId"] == 100
    assert binding["workspaceProcessId"] == 200
    assert binding["launchCommand"] == "node vite --token [redacted]"
    assert "top-secret" not in str(packet)
    assert packet["workspace"]["cwd"] == str(repo.resolve())
    assert packet["workspace"]["repoRoot"] == str(repo.resolve())
    assert packet["workspace"]["branch"] == "main"
    assert packet["workspace"]["isDirty"] is True
    assert "app.js" in packet["workspace"]["changedFiles"]
    assert "console.log('two')" in packet["workspace"]["diffExcerpt"]
    prompt = build_agent_prompt(packet, artifact_path=tmp_path / "packet.json")
    assert "localhost_listener" in prompt
    assert "node vite --token [redacted]" in prompt
    assert "console.log('two')" in prompt


def test_unresolved_window_process_marks_fallback_as_unverified(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    resolver = RuntimeWorkspaceResolver(
        process_probe=lambda _pid: None,
        listener_probe=lambda _port: None,
    )
    pointed = {
        "id": "screen-1",
        "kind": "screen_region",
        "source": {"processId": 999, "app": "unknown.exe", "title": "Looks like another repo"},
    }
    packet = ContextPacketBuilder(runtime_resolver=resolver).build(
        command="修复这个界面",
        recipe_id="agent.handoff",
        objects=[pointed],
        cwd=repo,
        target_lease={"leaseId": "lease"},
        capture_decisions=[_decision()],
        capabilities=[],
    )

    binding = packet["runtime"]["processBinding"]
    assert binding["state"] == "fallback_unverified"
    assert binding["relation"] == "explicit_cwd_fallback"
    assert binding["targetProcessId"] == 999
    assert "Looks like another repo" not in str(binding)


def test_direct_runtime_process_uses_nearest_parent_with_repository(tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    non_repo_cwd = str(Path(Path.cwd().anchor).resolve())
    records = {
        300: {"pid": 300, "parentPid": 301, "cwd": non_repo_cwd, "executablePath": "C:/python/python.exe", "commandLine": "python child.py"},
        301: {"pid": 301, "parentPid": 0, "cwd": str(repo), "executablePath": "C:/Windows/cmd.exe", "commandLine": "cmd /c npm run app"},
    }
    resolver = RuntimeWorkspaceResolver(process_probe=lambda pid: records.get(pid), listener_probe=lambda _port: None)

    result = resolver.resolve([{"source": {"processId": 300}}], fallback_cwd=tmp_path)

    assert result["state"] == "bound"
    assert result["relation"] == "window_process_parent"
    assert result["workspaceProcessId"] == 301
    assert result["cwd"] == str(repo.resolve())
