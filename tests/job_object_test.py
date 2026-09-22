
from __future__ import annotations

import inspect
import os
import subprocess
import sys
from pathlib import Path

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


def test_mcp_spawns_join_the_job() -> None:
    from app.fabric import mcp_client

    assert "attach_kill_on_close" in inspect.getsource(mcp_client.McpStdioClient.start)


def test_the_ocr_worker_is_deliberately_not_tied_to_its_spawner() -> None:
    from app.perception import pixel_ocr

    assert "attach_kill_on_close" not in inspect.getsource(pixel_ocr._spawn_worker)
    worker_source = (
        Path(__file__).resolve().parents[1] / "scripts" / "ocr_resident_worker.py"
    ).read_text(encoding="utf-8")
    assert "IDLE_TIMEOUT_S" in worker_source
    assert "_remove_owned_port_file" in worker_source
