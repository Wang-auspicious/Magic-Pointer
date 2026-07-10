from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.adapters.base import AdapterCapability, AdapterReadContext, AppAdapter

JsonDict = dict[str, Any]

ROOT = Path(__file__).resolve().parents[2]
UIA_PROBE_SOURCE = ROOT / "scripts" / "uia_selection_probe.cs"
UIA_PROBE_EXE = ROOT / "data" / "runtime" / "uia_selection_probe.exe"

UIA_WINDOW_CLASSES = {
    "AcrobatMDIFrame",
    "AcrobatSDIWindow",
    "Chrome_WidgetWin_1",
    "MozillaWindowClass",
}
MAGIC_WINDOW_TITLES = {"Magic Pointer Overlay", "Magic Pointer Panel"}

CSC_CANDIDATES = (
    Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"),
)

GAC_ROOT = Path(r"C:\Windows\Microsoft.NET\assembly\GAC_MSIL")
UIA_REFERENCE_NAMES = (
    "UIAutomationClient",
    "UIAutomationTypes",
    "WindowsBase",
)
NO_SELECTION_ERROR = "No non-empty UI Automation text selection was exposed."


@dataclass(frozen=True)
class UiaProbeResult:
    ok: bool
    data: JsonDict
    error: str | None = None


def uia_app_from_window(window: JsonDict) -> str:
    title = str(window.get("title") or "").lower()
    class_name = str(window.get("class_name") or "")
    if (
        class_name in {"AcrobatMDIFrame", "AcrobatSDIWindow"}
        or any(part.strip().endswith(".pdf") for part in title.split(" - "))
    ):
        return "pdf"
    if class_name == "MozillaWindowClass":
        return "browser"
    if (
        "google chrome" in title
        or "brave" in title
        or "vivaldi" in title
        or "opera" in title
        or ("microsoft" in title and "edge" in title)
    ):
        return "browser"
    return "application"


def _find_csc() -> Path | None:
    return next((candidate for candidate in CSC_CANDIDATES if candidate.exists()), None)


def _find_uia_reference(name: str) -> Path | None:
    root = GAC_ROOT / name
    if not root.exists():
        return None
    return next(root.glob(f"v4.0_*\\{name}.dll"), None)


def _compile_uia_probe(*, timeout: int = 8) -> UiaProbeResult:
    csc = _find_csc()
    if csc is None:
        return UiaProbeResult(False, {}, "Windows C# compiler was not found.")
    if not UIA_PROBE_SOURCE.exists():
        return UiaProbeResult(False, {}, "UI Automation probe source is missing.")

    references: list[Path] = []
    for name in UIA_REFERENCE_NAMES:
        reference = _find_uia_reference(name)
        if reference is None:
            return UiaProbeResult(False, {}, f"Windows UI Automation reference is missing: {name}")
        references.append(reference)

    UIA_PROBE_EXE.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(csc),
        "/nologo",
        "/target:exe",
        "/optimize+",
        f"/out:{UIA_PROBE_EXE}",
        *(f"/reference:{reference}" for reference in references),
        str(UIA_PROBE_SOURCE),
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
        return UiaProbeResult(False, {}, f"UI Automation probe compilation failed: {type(exc).__name__}: {exc}")
    if proc.returncode != 0 or not UIA_PROBE_EXE.exists():
        detail = (proc.stderr or proc.stdout).strip().replace("\r", " ").replace("\n", " ")[:1600]
        return UiaProbeResult(False, {}, f"UI Automation probe compilation failed: {detail}")
    return UiaProbeResult(True, {"compiled": True})


def _ensure_uia_probe() -> UiaProbeResult:
    try:
        if (
            UIA_PROBE_EXE.exists()
            and UIA_PROBE_EXE.stat().st_mtime_ns >= UIA_PROBE_SOURCE.stat().st_mtime_ns
        ):
            return UiaProbeResult(True, {"compiled": False})
    except OSError:
        pass
    return _compile_uia_probe()


def _run_uia_selection_probe(hwnd: int, *, timeout: float = 1.2) -> UiaProbeResult:
    prepared = _ensure_uia_probe()
    if not prepared.ok:
        return prepared
    try:
        proc = subprocess.run(
            [str(UIA_PROBE_EXE), str(int(hwnd))],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except Exception as exc:
        return UiaProbeResult(False, {}, f"UI Automation selection probe failed: {type(exc).__name__}: {exc}")

    try:
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        data = json.loads(lines[-1]) if lines else {}
    except Exception as exc:
        raw = proc.stdout.strip().replace("\r", " ").replace("\n", " ")[:1600]
        return UiaProbeResult(False, {}, f"Invalid UI Automation probe JSON: {type(exc).__name__}: {exc}; raw={raw}")

    if proc.returncode != 0 or data.get("ok") is not True:
        detail = str(data.get("error") or proc.stderr or f"probe exited {proc.returncode}")[:1600]
        return UiaProbeResult(False, data, detail)
    return UiaProbeResult(True, data)


class UiaTextSelectionAdapter(AppAdapter):
    name = "uia_text_selection"

    def match_window(self, window: JsonDict) -> bool:
        title = str(window.get("title") or "")
        if title in MAGIC_WINDOW_TITLES:
            return False
        return str(window.get("class_name") or "") in UIA_WINDOW_CLASSES

    def read_context(self, window: JsonDict, **kwargs: Any) -> AdapterReadContext:
        app = uia_app_from_window(window)
        capabilities = [
            AdapterCapability(
                "read_selection",
                "Read the native accessibility text selection without keyboard or clipboard input",
                "read_only",
            )
        ]
        hwnd = int(window.get("hwnd") or 0)
        expected_pid = int(window.get("pid") or 0)
        if hwnd <= 0:
            return AdapterReadContext(
                adapter=self.name,
                app=app,
                window=window,
                capabilities=capabilities,
                error="The foreground window does not have a valid native handle.",
            )

        probe = _run_uia_selection_probe(hwnd)
        if not probe.data:
            return AdapterReadContext(
                adapter=self.name,
                app=app,
                window=window,
                method="uia:text-pattern.selection",
                capabilities=capabilities,
                artifacts={
                    "source_hwnd": hwnd,
                    "source_pid": expected_pid,
                    "probe_error": probe.error,
                },
                error=probe.error,
            )

        data = probe.data
        requested_hwnd = int(data.get("hwnd") or 0)
        observed_root_hwnd = int(data.get("root_hwnd") or 0)
        observed_pid = int(data.get("process_id") or 0)
        if (
            requested_hwnd != hwnd
            or observed_root_hwnd != hwnd
            or (expected_pid > 0 and observed_pid != expected_pid)
        ):
            return AdapterReadContext(
                adapter=self.name,
                app=app,
                window=window,
                method="uia:text-pattern.selection",
                capabilities=capabilities,
                artifacts={
                    "source_hwnd": hwnd,
                    "source_pid": expected_pid,
                    "requested_hwnd": requested_hwnd,
                    "observed_root_hwnd": observed_root_hwnd,
                    "observed_pid": observed_pid,
                },
                error="UI Automation selection identity did not match the foreground window.",
            )

        if not probe.ok:
            if probe.error == NO_SELECTION_ERROR:
                return AdapterReadContext(
                    adapter=self.name,
                    app=app,
                    window=window,
                    method="uia:text-pattern.selection",
                    capabilities=capabilities,
                    artifacts={
                        "source_hwnd": hwnd,
                        "source_pid": expected_pid,
                        "observed_root_hwnd": observed_root_hwnd,
                        "observed_pid": observed_pid,
                        "probe_elapsed_ms": data.get("elapsed_ms"),
                    },
                )
            return AdapterReadContext(
                adapter=self.name,
                app=app,
                window=window,
                method="uia:text-pattern.selection",
                capabilities=capabilities,
                artifacts={
                    "source_hwnd": hwnd,
                    "source_pid": expected_pid,
                    "observed_root_hwnd": observed_root_hwnd,
                    "observed_pid": observed_pid,
                    "probe_error": probe.error,
                },
                error=probe.error,
            )

        text = str(data.get("text") or "")
        if not text.strip():
            return AdapterReadContext(
                adapter=self.name,
                app=app,
                window=window,
                method="uia:text-pattern.selection",
                capabilities=capabilities,
                artifacts={
                    "source_hwnd": hwnd,
                    "source_pid": expected_pid,
                    "observed_root_hwnd": observed_root_hwnd,
                    "observed_pid": observed_pid,
                },
            )

        artifacts = {
            "source_hwnd": hwnd,
            "source_pid": expected_pid,
            "observed_root_hwnd": observed_root_hwnd,
            "observed_pid": observed_pid,
            "element_name": data.get("element_name"),
            "automation_id": data.get("automation_id"),
            "control_type": data.get("control_type"),
            "range_count": data.get("range_count"),
            "selection_rectangles": list(data.get("rectangles") or [])[:32],
            "selection_text_chars": len(text),
            "selection_text_sha256": hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest(),
            "truncated": bool(data.get("truncated")),
            "probe_elapsed_ms": data.get("elapsed_ms"),
        }
        return AdapterReadContext(
            adapter=self.name,
            app=app,
            window=window,
            content=text,
            label=str(window.get("title") or data.get("element_name") or "Selected text"),
            method="uia:text-pattern.selection",
            capabilities=capabilities,
            artifacts=artifacts,
        )
