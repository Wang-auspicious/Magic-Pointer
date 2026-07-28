from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from app.fabric.runtime_workspace import redact_launch_command


_ANSI_ESCAPE = re.compile(
    r"(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B(?:[@-_]|\[[0-?]*[ -/]*[@-~]))"
)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]")
_SECRET_ARGUMENT = re.compile(
    r"(?i)(--?(?:api[-_]?key|token|secret|password|passwd|authorization|credential))(?:(=)|\s+)(\"[^\"]*\"|'[^']*'|\S+)"
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL))=([^\s]+)"
)
_TIMESTAMP = re.compile(
    r"(?<!\d)(\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)(?!\d)"
)
_EXIT_CODE_PATTERNS = (
    re.compile(r"(?i)\bprocess\s+exited\s+with\s+(?:exit\s+)?code\s*[:=]?\s*(-?\d+)\b"),
    re.compile(r"(?i)\bcommand\s+failed\s+with\s+exit\s+code\s*[:=]?\s*(-?\d+)\b"),
    re.compile(r"(?i)^\s*exit\s+code\s*[:=]\s*(-?\d+)\b"),
    re.compile(r"(?i)^\s*exited\s*\((-?\d+)\)\s*$"),
)
_ERROR_PATTERNS = (
    re.compile(r"(?i)\btraceback\s*\(most recent call last\)"),
    re.compile(r"(?i)(?:^|\s)(?:error|exception|fatal|panic|failed|failure|assertionerror|npm err!)(?:\b|:)"),
    re.compile(r"(?i)\b[a-z_][a-z0-9_.]*(?:error|exception):"),
    re.compile(r"(?i)^\s*(?:fail|failed)\s+\S"),
)
_POWERSHELL_PROMPT = re.compile(r"^\s*PS\s+[^>\r\n]+>\s*(.*)$", re.IGNORECASE)
_CMD_PROMPT = re.compile(r"^\s*(?:[A-Za-z]:\\|\\\\)[^>\r\n]*>\s*(.*)$")
_SHELL_PROMPT = re.compile(r"^\s*(?:(?:[^\s@]+@[^\s:]+):?[^\r\n]*?)?[$#]\s+(.+)$")


def _bounded(value: object, limit: int) -> str:
    return str(value or "")[:limit]


def _strip_terminal_controls(value: object) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    cleaned = _CONTROL.sub("", _ANSI_ESCAPE.sub("", text))
    return "\n".join(line.rstrip() for line in cleaned.split("\n"))


def _redact_text(value: object) -> str:
    text = _strip_terminal_controls(value)
    text = _SECRET_ARGUMENT.sub(
        lambda match: f"{match.group(1)}{'=' if match.group(2) else ' '}[redacted]",
        text,
    )
    text = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=[redacted]", text)
    return re.sub(r"(?i)(https?://[^\s/:]+):[^\s/@]+@", r"\1:[redacted]@", text)


def _command_from_line(line: str) -> str | None:
    for pattern in (_POWERSHELL_PROMPT, _CMD_PROMPT, _SHELL_PROMPT):
        match = pattern.match(line)
        if match:
            command = match.group(1).strip()
            return command or None
    return None


def _is_prompt(line: str) -> bool:
    return any(pattern.match(line) for pattern in (_POWERSHELL_PROMPT, _CMD_PROMPT, _SHELL_PROMPT))


def _is_error(line: str) -> bool:
    return any(pattern.search(line) for pattern in _ERROR_PATTERNS)


def _explicit_exit_code(lines: list[str]) -> tuple[int | None, int | None]:
    for index, line in enumerate(lines):
        for pattern in _EXIT_CODE_PATTERNS:
            match = pattern.search(line)
            if match:
                try:
                    return int(match.group(1)), index
                except ValueError:
                    continue
    return None, None


def _timestamp_near(lines: list[str], anchor_index: int) -> str:
    candidates: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        match = _TIMESTAMP.search(line)
        if match:
            candidates.append((abs(index - anchor_index), match.group(1)))
    return min(candidates, default=(0, ""), key=lambda item: item[0])[1]


def _structural_method(method: str) -> bool:
    lowered = method.casefold()
    return lowered.startswith(("uia:", "dom:", "native:", "ax:")) and "ocr" not in lowered


def sanitize_terminal_evidence(value: Any) -> dict[str, Any] | None:
    """Return the bounded TerminalEvidenceV1 projection accepted by handoff/audit paths."""
    if not isinstance(value, dict) or int(value.get("schemaVersion") or 0) != 1:
        return None
    method = _bounded(value.get("method"), 120)
    raw_anchor = dict(value.get("anchor") or {})
    raw_window = dict(value.get("window") or {})
    try:
        exit_code = value.get("exitCode")
        exit_code = int(exit_code) if exit_code is not None else None
    except (TypeError, ValueError):
        exit_code = None
    try:
        anchor_line = max(0, int(raw_anchor.get("line") or 0))
    except (TypeError, ValueError):
        anchor_line = 0
    try:
        start_line = max(0, int(raw_window.get("startLine") or 0))
        end_line = max(start_line, int(raw_window.get("endLine") or start_line))
        line_count = max(0, min(64, int(raw_window.get("lineCount") or 0)))
    except (TypeError, ValueError):
        start_line, end_line, line_count = 0, 0, 0
    uncertainty = [
        _bounded(item, 160)
        for item in list(value.get("uncertainty") or [])[:12]
        if str(item or "").strip()
    ]
    return {
        "schemaVersion": 1,
        "state": str(value.get("state") or "unavailable")
        if str(value.get("state") or "") in {"resolved", "partial", "unavailable"}
        else "unavailable",
        "method": method,
        "capturedAt": _bounded(value.get("capturedAt"), 80),
        "timestamp": _bounded(value.get("timestamp"), 80),
        "command": redact_launch_command(value.get("command")),
        "exitCode": exit_code,
        "anchor": {
            "line": anchor_line,
            "text": _bounded(_redact_text(raw_anchor.get("text")), 1000),
        },
        "window": {
            "startLine": start_line,
            "endLine": end_line,
            "lineCount": line_count,
            "before": _bounded(_redact_text(raw_window.get("before")), 4000),
            "error": _bounded(_redact_text(raw_window.get("error")), 6000),
            "after": _bounded(_redact_text(raw_window.get("after")), 4000),
            "text": _bounded(_redact_text(raw_window.get("text")), 8000),
        },
        "pixelFallbackUsed": False,
        "provenance": {
            "structural": _structural_method(method),
            "exitCodeObserved": exit_code is not None,
        },
        "uncertainty": uncertainty,
    }


class TerminalEvidenceExtractor:
    def __init__(self, *, before_lines: int = 8, after_lines: int = 12, max_lines: int = 24) -> None:
        self.before_lines = max(0, min(int(before_lines), 16))
        self.after_lines = max(0, min(int(after_lines), 24))
        self.max_lines = max(4, min(int(max_lines), 48))

    def extract(
        self,
        text: object,
        *,
        method: str,
        anchor_text: str = "",
        anchor_line: int | None = None,
        captured_at: str = "",
        trusted_command: str = "",
        trusted_exit_code: int | None = None,
    ) -> dict[str, Any]:
        cleaned = _redact_text(text)
        lines = cleaned.splitlines()
        while lines and not lines[0].strip():
            lines.pop(0)
        while lines and not lines[-1].strip():
            lines.pop()
        captured = captured_at or datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        if not lines:
            return sanitize_terminal_evidence({
                "schemaVersion": 1,
                "state": "unavailable",
                "method": method,
                "capturedAt": captured,
                "timestamp": "",
                "command": trusted_command,
                "exitCode": trusted_exit_code,
                "anchor": {"line": 0, "text": ""},
                "window": {"startLine": 0, "endLine": 0, "lineCount": 0},
                "uncertainty": ["terminal_buffer_unavailable"],
            }) or {}

        anchor_index = self._anchor_index(lines, anchor_text=anchor_text, anchor_line=anchor_line)
        command_index, observed_command = self._preceding_command(lines, anchor_index)
        next_command_index = next(
            (index for index in range(anchor_index + 1, len(lines)) if _is_prompt(lines[index])),
            len(lines),
        )
        block_start = command_index if command_index is not None else max(0, anchor_index - self.before_lines)
        block_end = min(len(lines), next_command_index)
        scoped = lines[block_start:block_end]
        scoped_anchor = anchor_index - block_start
        error_candidates = [index for index, line in enumerate(scoped) if _is_error(line)]
        error_index = min(error_candidates, key=lambda index: abs(index - scoped_anchor)) if error_candidates else scoped_anchor

        observed_exit, exit_index = _explicit_exit_code(scoped)
        exit_code = trusted_exit_code if trusted_exit_code is not None else observed_exit
        window_start = max(0, error_index - self.before_lines)
        window_end = min(len(scoped), error_index + self.after_lines + 1)
        if exit_index is not None:
            window_end = min(len(scoped), max(window_end, exit_index + 2))
        if window_end - window_start > self.max_lines:
            window_end = window_start + self.max_lines
        selected = scoped[window_start:window_end]
        while selected and not selected[-1].strip():
            selected.pop()
            window_end -= 1
        while selected and not selected[0].strip():
            selected.pop(0)
            window_start += 1
        selected_error = error_index - window_start
        selected_exit = (exit_index - window_start) if exit_index is not None else None
        error_end = selected_exit + 1 if selected_exit is not None and selected_exit >= selected_error else min(len(selected), selected_error + 5)
        before = selected[:selected_error]
        error = selected[selected_error:error_end]
        after = selected[error_end:]
        command = trusted_command or observed_command or ""
        uncertainty: list[str] = []
        if not command:
            uncertainty.append("command_unavailable")
        if exit_code is None:
            uncertainty.append("exit_code_unavailable")
        if not error_candidates:
            uncertainty.append("error_anchor_unverified")
        structural = _structural_method(str(method or ""))
        state = "resolved" if structural and bool(error_candidates) else "partial"
        evidence = {
            "schemaVersion": 1,
            "state": state,
            "method": str(method or "")[:120],
            "capturedAt": captured,
            "timestamp": _timestamp_near(scoped, error_index),
            "command": command,
            "exitCode": exit_code,
            "anchor": {
                "line": block_start + error_index + 1,
                "text": scoped[error_index][:1000] if scoped else "",
            },
            "window": {
                "startLine": block_start + window_start + 1,
                "endLine": block_start + window_end,
                "lineCount": len(selected),
                "before": "\n".join(before),
                "error": "\n".join(error),
                "after": "\n".join(after),
                "text": "\n".join(selected),
            },
            "pixelFallbackUsed": False,
            "uncertainty": uncertainty,
        }
        return sanitize_terminal_evidence(evidence) or {}

    @staticmethod
    def _anchor_index(lines: list[str], *, anchor_text: str, anchor_line: int | None) -> int:
        needle = str(anchor_text or "").strip().casefold()
        if needle:
            exact = [index for index, line in enumerate(lines) if needle in line.casefold()]
            if exact:
                return exact[-1]
        if anchor_line is not None:
            try:
                return max(0, min(len(lines) - 1, int(anchor_line) - 1))
            except (TypeError, ValueError):
                pass
        errors = [index for index, line in enumerate(lines) if _is_error(line)]
        return errors[-1] if errors else len(lines) - 1

    @staticmethod
    def _preceding_command(lines: list[str], anchor_index: int) -> tuple[int | None, str | None]:
        for index in range(anchor_index, -1, -1):
            command = _command_from_line(lines[index])
            if command:
                return index, command
        return None, None
