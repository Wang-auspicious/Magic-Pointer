"""Launch isolated, no-window background learning reviews."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

__all__ = ["BackgroundReviewLauncher"]

_LEARNING_TERMINALS = {
    "completed",
    "stalled",
    "invariant_failed",
    "budget_exhausted",
}


class BackgroundReviewLauncher:
    """Start one independent review worker and return immediately."""

    def __init__(
        self,
        *,
        project_root: Path | str,
        user_root: Path | str,
        session_root: Path | str,
        python_executable: Path | str | None = None,
        worker_script: Path | str | None = None,
        popen: Callable[..., Any] = subprocess.Popen,
        enabled: bool = True,
    ) -> None:
        self.project_root = Path(project_root).resolve()
        self.user_root = Path(user_root).resolve()
        self.session_root = Path(session_root).resolve()
        self.python_executable = Path(python_executable or sys.executable)
        self.worker_script = Path(
            worker_script
            or self.project_root / "scripts" / "learning_review_worker.py"
        )
        self._popen = popen
        self.enabled = bool(enabled)

    def launch(self, session_id: str, *, terminal_reason: str) -> dict[str, Any]:
        request = self.prepare(session_id, terminal_reason=terminal_reason)
        if request.get("requested") is not True:
            return {
                "launched": False,
                "reason": request.get("reason"),
                "sessionId": str(session_id),
            }
        reason = str(terminal_reason or "")
        argv = [
            str(self.python_executable),
            str(self.worker_script),
            "--user-root",
            str(self.user_root),
            "--session-root",
            str(self.session_root),
            "--session-id",
            str(session_id),
            "--terminal-reason",
            reason,
        ]
        creationflags = 0
        if os.name == "nt":
            creationflags = int(getattr(subprocess, "CREATE_NO_WINDOW", 0))
            creationflags |= int(getattr(subprocess, "DETACHED_PROCESS", 0))
            creationflags |= int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        kwargs: dict[str, Any] = {
            "cwd": str(self.project_root),
            "env": dict(os.environ),
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "close_fds": True,
            "shell": False,
        }
        if creationflags:
            kwargs["creationflags"] = creationflags
        elif os.name != "nt":
            kwargs["start_new_session"] = True
        process = self._popen(argv, **kwargs)
        return {
            "launched": True,
            "pid": int(process.pid),
            "sessionId": str(session_id),
        }

    def prepare(self, session_id: str, *, terminal_reason: str) -> dict[str, Any]:
        """Build a path-free request for a persistent host to schedule."""
        reason = str(terminal_reason or "")
        if not self.enabled:
            return {
                "requested": False,
                "reason": "disabled",
                "sessionId": str(session_id),
            }
        if reason not in _LEARNING_TERMINALS:
            return {
                "requested": False,
                "reason": "terminal_not_reviewable",
                "sessionId": str(session_id),
            }
        return {
            "requested": True,
            "sessionId": str(session_id),
            "terminalReason": reason,
        }
