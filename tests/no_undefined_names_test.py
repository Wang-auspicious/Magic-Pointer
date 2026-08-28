"""全库 pyflakes F821 守卫：未定义名不允许存在。

1.0.14 起生产路径带着 ``NameError: name 'reply_style' is not defined`` 跑了
两周——每个走到 Agent loop 的手势问句必死，GUI 只显示兜底文案，错误详情
被 worker 兜底。这类错误的唯一可靠防线是静态扫描，不是逐条真机试。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_no_undefined_names_anywhere() -> None:
    targets = [str(ROOT / "scripts"), str(ROOT / "app")]
    proc = subprocess.run(
        [sys.executable, "-m", "pyflakes", "--version"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AssertionError("pyflakes 必须可用（dev 依赖），否则本守卫失效")

    proc = subprocess.run(
        [sys.executable, "-m", "pyflakes", *targets],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    undefined = [
        line for line in (proc.stdout + proc.stderr).splitlines()
        if "undefined name" in line
    ]
    assert undefined == [], (
        "存在未定义名（生产路径 NameError 地雷）：\n" + "\n".join(undefined)
    )
