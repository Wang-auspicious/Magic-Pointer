"""Build the WGC capture tool with the machine-local csc (Phase B).

The tool is scaffold-only on this machine (no WinMD projection facades, no
dotnet SDK, no Windows SDK headers for the D3D11 vtable pass), so this
build succeeds syntactically but the tool answers rc=2 with the honest
"scaffold-only" note — the CaptureProvider reports ``wgc_tool_missing``
either way until a compile+live-capture verification lands.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts" / "wgc_capture_tool.cs"
OUT = ROOT / "data" / "runtime" / "wgc_capture_tool.exe"

CSC_CANDIDATES = (
    Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"),
)


def main() -> int:
    if not SOURCE.exists():
        print(f"missing source: {SOURCE}")
        return 2
    csc = next((candidate for candidate in CSC_CANDIDATES if candidate.exists()), None)
    if csc is None:
        print("csc.exe not found; cannot build WGC tool")
        return 2
    OUT.parent.mkdir(parents=True, exist_ok=True)
    references = [
        Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Drawing.dll"),
    ]
    command = [
        str(csc),
        "/nologo",
        "/target:exe",
        "/optimize+",
        f"/out:{OUT}",
        *(f"/reference:{reference}" for reference in references if reference.exists()),
        str(SOURCE),
    ]
    proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()[:1600]
        print(f"WGC tool build failed: {detail}")
        return 1
    print(f"built {OUT} (scaffold; native capture not yet verified)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
