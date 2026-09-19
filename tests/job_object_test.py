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
    """常驻 OCR worker 挂在 job 上会把「常驻」变回「每次冷启」。

    2026-09-19 实机测到：加载一次 RapidOCR 引擎 11.2s，且和图片多大无关
    （800×600 的裁剪图和整屏 3120×2080 一样要 11s）；引擎热着时同一次整屏读取
    3.2s。而会来叫它起床的多半是一次性的桥进程，处理完这一次请求就退出——
    挂在 job 上，引擎就随着那个进程一起被杀，下一次手势从头再加载一遍。

    它的生命周期改由它自己管：`IDLE_TIMEOUT_S` 空闲自退、退出时只删自己写的
    端口文件、`_worker_startup_lock` 防止同时活两个引擎。
    """
    from app.perception import pixel_ocr

    assert "attach_kill_on_close" not in inspect.getsource(pixel_ocr._spawn_worker)
    # 替代的生命周期必须真的存在，否则「不加 job」就等于「没人回收」。
    worker_source = (
        Path(__file__).resolve().parents[1] / "scripts" / "ocr_resident_worker.py"
    ).read_text(encoding="utf-8")
    assert "IDLE_TIMEOUT_S" in worker_source
    assert "_remove_owned_port_file" in worker_source
