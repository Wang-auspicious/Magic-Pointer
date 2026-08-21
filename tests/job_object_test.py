"""Windows JobObject kill-on-close for MCP/OCR children.

Everywhere Watchdog's idea, written here: child processes go in a job
with KILL_ON_JOB_CLOSE so a dead parent cannot leave MCP/OCR workers
behind. The C# is BSL 1.1; this is our ctypes implementation.
"""

from __future__ import annotations

import inspect
import os
import subprocess
import sys

import pytest


def test_kill_on_close_job_reaps_assigned_child() -> None:
    if os.name != "nt":
        pytest.skip("JobObject is a Windows kernel object")
    from app.process.job_object import KillOnCloseJob

    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
    )
    job = KillOnCloseJob()
    try:
        assert job.assign(child) is True
        job.close()
        child.wait(timeout=5)
        assert child.poll() is not None
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def test_attach_kill_on_close_is_honest_off_windows(monkeypatch) -> None:
    from app.process import job_object

    monkeypatch.setattr(job_object.os, "name", "posix")
    assert job_object.attach_kill_on_close(object()) is False


def test_mcp_and_ocr_spawns_join_the_job() -> None:
    from app.fabric import mcp_client
    from app.perception import pixel_ocr

    assert "attach_kill_on_close" in inspect.getsource(mcp_client.McpStdioClient.start)
    assert "attach_kill_on_close" in inspect.getsource(pixel_ocr._spawn_worker)
