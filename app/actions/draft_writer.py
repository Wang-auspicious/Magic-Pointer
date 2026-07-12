from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from app.adapters.uia_text_adapter import UIA_REFERENCE_NAMES, _find_csc, _find_uia_reference

JsonDict = dict[str, Any]
ROOT = Path(__file__).resolve().parents[2]
DRAFT_WRITER_SOURCE = ROOT / "scripts" / "uia_draft_writer.cs"
DRAFT_WRITER_EXE = ROOT / "data" / "runtime" / "uia_draft_writer.exe"


def _compile_draft_writer(*, timeout: int = 10) -> tuple[bool, str | None]:
    csc = _find_csc()
    if csc is None:
        return False, "Windows C# compiler was not found."
    if not DRAFT_WRITER_SOURCE.exists():
        return False, "UI Automation draft writer source is missing."
    references: list[Path] = []
    for name in UIA_REFERENCE_NAMES:
        reference = _find_uia_reference(name)
        if reference is None:
            return False, f"Windows UI Automation reference is missing: {name}"
        references.append(reference)
    DRAFT_WRITER_EXE.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(csc),
        "/nologo",
        "/target:exe",
        "/optimize+",
        f"/out:{DRAFT_WRITER_EXE}",
        *(f"/reference:{reference}" for reference in references),
        "/reference:System.Windows.Forms.dll",
        str(DRAFT_WRITER_SOURCE),
    ]
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except Exception as exc:
        return False, f"Draft writer compilation failed: {type(exc).__name__}: {exc}"
    if proc.returncode != 0 or not DRAFT_WRITER_EXE.exists():
        detail = (proc.stderr or proc.stdout).strip().replace("\r", " ").replace("\n", " ")[:1600]
        return False, f"Draft writer compilation failed: {detail}"
    return True, None


def _ensure_draft_writer() -> tuple[bool, str | None]:
    try:
        if (
            DRAFT_WRITER_EXE.exists()
            and DRAFT_WRITER_EXE.stat().st_mtime_ns >= DRAFT_WRITER_SOURCE.stat().st_mtime_ns
        ):
            return True, None
    except OSError:
        pass
    return _compile_draft_writer()


def write_draft_to_target(parameters: JsonDict, *, timeout: float = 8.0) -> JsonDict:
    prepared, error = _ensure_draft_writer()
    if not prepared:
        return {"ok": False, "error": error or "Draft writer is unavailable"}
    payload = json.dumps(dict(parameters), ensure_ascii=False)
    try:
        proc = subprocess.run(
            [str(DRAFT_WRITER_EXE)],
            input=payload,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except Exception as exc:
        return {"ok": False, "error": f"Draft writer failed: {type(exc).__name__}: {exc}"}
    try:
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        result = json.loads(lines[-1]) if lines else {}
    except Exception as exc:
        raw = proc.stdout.strip().replace("\r", " ").replace("\n", " ")[:1600]
        return {"ok": False, "error": f"Invalid draft writer JSON: {type(exc).__name__}: {exc}; raw={raw}"}
    if not isinstance(result, dict):
        return {"ok": False, "error": "Invalid draft writer JSON: root must be an object"}
    if proc.returncode != 0 and result.get("ok") is not False:
        return {"ok": False, "error": str(proc.stderr or f"draft writer exited {proc.returncode}")[:1600]}
    return result
