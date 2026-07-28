from __future__ import annotations

from app.grounding.terminal_evidence import TerminalEvidenceExtractor, sanitize_terminal_evidence


def test_extracts_nearest_powershell_failure_with_command_time_and_exit_code() -> None:
    text = """[2026-07-27T20:14:00+08:00] warmup
PS D:\\repo> python .\\verify.py --token super-secret
loading fixture
processing row 4
[2026-07-27T20:14:03+08:00] ERROR validation failed
Traceback (most recent call last):
  File \"verify.py\", line 8, in <module>
    raise RuntimeError(\"bad row\")
RuntimeError: bad row
Process exited with code 7
cleanup complete
PS D:\\repo>
"""
    evidence = TerminalEvidenceExtractor().extract(
        text,
        method="uia:terminal-text-pattern",
        anchor_text="RuntimeError: bad row",
        captured_at="2026-07-27T20:14:04+08:00",
    )

    assert evidence["schemaVersion"] == 1
    assert evidence["state"] == "resolved"
    assert evidence["method"] == "uia:terminal-text-pattern"
    assert evidence["command"] == "python .\\verify.py --token [redacted]"
    assert evidence["exitCode"] == 7
    assert evidence["timestamp"] == "2026-07-27T20:14:03+08:00"
    assert evidence["anchor"]["text"] == "RuntimeError: bad row"
    assert "warmup" not in evidence["window"]["text"]
    assert "cleanup complete" in evidence["window"]["after"]
    assert evidence["window"]["lineCount"] <= 24
    assert evidence["pixelFallbackUsed"] is False
    assert "super-secret" not in str(evidence)


def test_anchor_selects_relevant_error_block_instead_of_entire_terminal() -> None:
    text = """$ first-command
Error: first failure
Command failed with exit code 2
$ second-command --password=hunter2
before second
npm ERR! code ELIFECYCLE
npm ERR! second failure
Command failed with exit code 9
after second
"""
    evidence = TerminalEvidenceExtractor(before_lines=2, after_lines=3).extract(
        text,
        method="dom:terminal-buffer",
        anchor_text="second failure",
    )

    assert evidence["command"] == "second-command --password=[redacted]"
    assert evidence["exitCode"] == 9
    assert "first failure" not in evidence["window"]["text"]
    assert "second failure" in evidence["window"]["error"]
    assert evidence["provenance"]["structural"] is True


def test_unknown_exit_code_remains_null_and_ansi_is_removed() -> None:
    evidence = TerminalEvidenceExtractor().extract(
        "\x1b[31mFAIL tests/test_api.py::test_token\x1b[0m\nAssertionError: nope\n",
        method="provided_excerpt",
        anchor_line=1,
    )

    assert evidence["state"] == "partial"
    assert evidence["exitCode"] is None
    assert "\x1b" not in evidence["window"]["text"]
    assert "exit_code_unavailable" in evidence["uncertainty"]
    assert evidence["provenance"]["structural"] is False


def test_python_traceback_and_cmd_prompt_are_bounded_to_command() -> None:
    before = "\n".join(f"old {index}" for index in range(80))
    text = f"""{before}
C:\\repo>python broken.py
started
Traceback (most recent call last):
  File \"broken.py\", line 1, in <module>
    1 / 0
ZeroDivisionError: division by zero
exit code: 1
C:\\repo>
"""
    evidence = TerminalEvidenceExtractor(before_lines=8, after_lines=12).extract(
        text,
        method="native:terminal-buffer",
        anchor_text="ZeroDivisionError",
    )

    assert evidence["command"] == "python broken.py"
    assert evidence["exitCode"] == 1
    assert "old 0" not in evidence["window"]["text"]
    assert evidence["window"]["lineCount"] <= 24


def test_sanitizer_rejects_untrusted_fields_and_caps_all_log_groups() -> None:
    raw = {
        "schemaVersion": 1,
        "state": "resolved",
        "method": "uia:terminal-text-pattern",
        "capturedAt": "2026-07-27T20:14:04+08:00",
        "timestamp": "2026-07-27T20:14:03+08:00",
        "command": "run --api-key secret",
        "exitCode": 4,
        "anchor": {"line": 3, "text": "Error: bad", "private": "drop"},
        "window": {
            "startLine": 1,
            "endLine": 999,
            "lineCount": 999,
            "before": "x" * 9000,
            "error": "Error: bad",
            "after": "y" * 9000,
            "text": "z" * 20000,
            "private": "drop",
        },
        "pixelFallbackUsed": True,
        "uncertainty": ["one"],
        "private": "drop",
    }

    safe = sanitize_terminal_evidence(raw)
    assert safe is not None
    assert safe["command"] == "run --api-key [redacted]"
    assert safe["pixelFallbackUsed"] is False
    assert "private" not in str(safe)
    assert len(safe["window"]["text"]) <= 8000
    assert len(safe["window"]["before"]) <= 4000
    assert len(safe["window"]["after"]) <= 4000


def test_empty_terminal_buffer_is_unavailable_without_pixel_fallback() -> None:
    evidence = TerminalEvidenceExtractor().extract(
        "   \n",
        method="uia:terminal-text-pattern",
    )
    assert evidence["state"] == "unavailable"
    assert evidence["window"]["lineCount"] == 0
    assert evidence["pixelFallbackUsed"] is False
