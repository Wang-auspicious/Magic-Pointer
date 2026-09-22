
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
