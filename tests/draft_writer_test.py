from __future__ import annotations

import json
from pathlib import Path

import app.actions.draft_writer as writer_module
from app.actions.draft_writer import write_draft_to_target


class _Proc:
    returncode = 0
    stdout = json.dumps({
        "ok": True,
        "target_hwnd": 901,
        "target_title": "Agent",
        "written_chars": 12,
        "source_chars": 12,
        "method": "uia:value-pattern",
        "verified": True,
        "submit_sent": False,
    })
    stderr = ""


def parameters() -> dict:
    return {
        "text": "完整 Prompt 文本",
        "text_sha256": "hash-checked-by-executor",
        "target_hwnd": 901,
        "target_title": "Agent",
        "target_process_id": 902,
        "target_point": [420, 860],
        "prompt_artifact": r"C:\tmp\review.md",
        "submit": False,
    }


def test_writer_passes_unicode_payload_over_stdin_not_command_line(monkeypatch) -> None:
    seen = {}
    monkeypatch.setattr(writer_module, "_ensure_draft_writer", lambda: (True, None))

    def fake_run(command, **kwargs):
        seen["command"] = command
        seen["kwargs"] = kwargs
        return _Proc()

    monkeypatch.setattr(writer_module.subprocess, "run", fake_run)

    result = write_draft_to_target(parameters())

    assert seen["command"] == [str(writer_module.DRAFT_WRITER_EXE)]
    assert json.loads(seen["kwargs"]["input"])["text"] == "完整 Prompt 文本"
    assert result["ok"] is True
    assert result["submit_sent"] is False


def test_writer_fails_closed_on_invalid_helper_json(monkeypatch) -> None:
    monkeypatch.setattr(writer_module, "_ensure_draft_writer", lambda: (True, None))

    class BadProc:
        returncode = 0
        stdout = "not-json"
        stderr = ""

    monkeypatch.setattr(writer_module.subprocess, "run", lambda *args, **kwargs: BadProc())

    result = write_draft_to_target(parameters())

    assert result["ok"] is False
    assert "Invalid draft writer JSON" in result["error"]


def test_compile_does_not_duplicate_framework_system_web_extensions(tmp_path, monkeypatch) -> None:
    source = tmp_path / "writer.cs"
    executable = tmp_path / "writer.exe"
    source.write_text("public class X { public static void Main() {} }", encoding="utf-8")
    seen = {}
    monkeypatch.setattr(writer_module, "DRAFT_WRITER_SOURCE", source)
    monkeypatch.setattr(writer_module, "DRAFT_WRITER_EXE", executable)
    monkeypatch.setattr(writer_module, "_find_csc", lambda: Path("csc.exe"))
    monkeypatch.setattr(writer_module, "_find_uia_reference", lambda name: Path(f"{name}.dll"))

    class CompileProc:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_compile(command, **kwargs):
        seen["command"] = command
        executable.write_bytes(b"compiled")
        return CompileProc()

    monkeypatch.setattr(writer_module.subprocess, "run", fake_compile)

    ok, error = writer_module._compile_draft_writer()

    assert ok is True, error
    assert not any("System.Web.Extensions" in item for item in seen["command"])


def test_csharp_writer_source_has_explicit_no_submit_contract() -> None:
    source = (Path(__file__).resolve().parents[1] / "scripts" / "uia_draft_writer.cs").read_text(encoding="utf-8")

    assert "submit_sent = false" in source
    assert "IsPasswordProperty" in source
    assert "ValuePattern" in source
    assert "return Boolean.TryParse" not in source
    assert "{ENTER}" not in source
    assert "SendWait(\"~\")" not in source
