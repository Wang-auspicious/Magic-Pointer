from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.adapters.base import AdapterCapability, AdapterReadContext, AppAdapter
from app.adapters.pdf_selection_recovery import recover_local_pdf_selection
from app.grounding.terminal_evidence import TerminalEvidenceExtractor

JsonDict = dict[str, Any]

ROOT = Path(__file__).resolve().parents[2]
UIA_PROBE_SOURCE = ROOT / "scripts" / "uia_selection_probe.cs"
UIA_PROBE_EXE = ROOT / "data" / "runtime" / "uia_selection_probe.exe"

UIA_WINDOW_CLASSES = {
    "AcrobatMDIFrame",
    "AcrobatSDIWindow",
    "Chrome_WidgetWin_1",
    "MozillaWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "ConsoleWindowClass",
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
        class_name in {"CASCADIA_HOSTING_WINDOW_CLASS", "ConsoleWindowClass"}
        or any(token in title for token in ("windows terminal", "powershell", "command prompt"))
    ):
        return "terminal"
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


def _run_uia_selection_probe(
    hwnd: int,
    *,
    target_point: dict[str, int] | None = None,
    timeout: float = 2.5,
) -> UiaProbeResult:
    prepared = _ensure_uia_probe()
    if not prepared.ok:
        return prepared
    try:
        argv = [str(UIA_PROBE_EXE), str(int(hwnd))]
        if isinstance(target_point, dict):
            try:
                argv.extend([
                    str(int(target_point.get("x"))),
                    str(int(target_point.get("y"))),
                ])
            except (TypeError, ValueError):
                pass
        proc = subprocess.run(
            argv,
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
    perception_layer = "uia"
    perception_priority = 30

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

        raw_target_point = kwargs.get("target_point")
        target_point = None
        if isinstance(raw_target_point, dict):
            try:
                target_point = {
                    "x": int(raw_target_point.get("x")),
                    "y": int(raw_target_point.get("y")),
                }
            except (TypeError, ValueError):
                target_point = None
        probe = (
            _run_uia_selection_probe(hwnd, target_point=target_point)
            if target_point is not None
            else _run_uia_selection_probe(hwnd)
        )
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

        result_kind = str(data.get("result_kind") or "text_selection")
        method = (
            "uia:terminal-text-pattern"
            if result_kind == "terminal_buffer"
            else "uia:element-from-point"
            if result_kind == "point_element"
            else "uia:text-pattern.selection"
        )
        selection_rectangles = list(data.get("rectangles") or [])[:32]
        if result_kind in {"point_element", "terminal_buffer"} and not selection_rectangles:
            element_rect = data.get("element_rect")
            if isinstance(element_rect, list) and len(element_rect) == 4:
                selection_rectangles = [element_rect]
        rectangle_count_total = int(
            data.get("rectangle_count_total")
            or len(data.get("rectangles") or [])
        )
        rectangles_truncated = bool(data.get("rectangles_truncated"))
        raw_text = text
        recovery_artifacts: JsonDict = {}
        if result_kind == "terminal_buffer":
            terminal_evidence = TerminalEvidenceExtractor().extract(
                raw_text,
                method=method,
                anchor_text=str(data.get("terminal_anchor_text") or ""),
            )
            text = str((terminal_evidence.get("window") or {}).get("text") or "")
            recovery_artifacts = {
                "terminal_evidence": terminal_evidence,
                "terminal_buffer_chars": len(raw_text),
                "terminal_buffer_sha256": hashlib.sha256(
                    raw_text.encode("utf-8", errors="surrogatepass")
                ).hexdigest(),
                "terminal_anchor_available": bool(data.get("terminal_anchor_text")),
            }
        if (
            result_kind != "point_element"
            and result_kind != "terminal_buffer"
            and
            app == "pdf"
            and str(window.get("class_name") or "") == "Chrome_WidgetWin_1"
        ):
            recovery = recover_local_pdf_selection(data)
            raw_text_sha256 = hashlib.sha256(
                raw_text.encode("utf-8", errors="surrogatepass")
            ).hexdigest()
            if not recovery.ok:
                return AdapterReadContext(
                    adapter=self.name,
                    app=app,
                    window=window,
                    method="pdf:verified-visible-selection",
                    capabilities=capabilities,
                    artifacts={
                        "source_hwnd": hwnd,
                        "source_pid": expected_pid,
                        "observed_root_hwnd": observed_root_hwnd,
                        "observed_pid": observed_pid,
                        "uia_selection_text_chars": len(raw_text),
                        "uia_selection_text_sha256": raw_text_sha256,
                        "uia_selection_rectangle_count_total": rectangle_count_total,
                        "uia_selection_rectangles_truncated": rectangles_truncated,
                        "pdf_document_path": recovery.document_path,
                        "pdf_page_number": recovery.page_number,
                        "pdf_page_selector_number": data.get(
                            "page_selector_number"
                        ),
                        "pdf_page_ancestor_number": data.get(
                            "page_ancestor_number"
                        ),
                        "pdf_recovery_error": recovery.error,
                        "probe_elapsed_ms": data.get("elapsed_ms"),
                    },
                    error=(
                        "The visible Chromium PDF selection could not be verified "
                        "against the local document text layer."
                    ),
                )
            text = recovery.text
            selection_rectangles = [
                [float(part) for part in rectangle]
                for rectangle in recovery.rectangles
            ]
            rectangle_count_total = len(selection_rectangles)
            rectangles_truncated = False
            method = "pdf:screen-highlight+local-text-layer"
            recovery_artifacts = {
                "selection_context": recovery.context,
                "selection_source": "verified_visible_local_pdf_text",
                "pdf_document_path": recovery.document_path,
                "pdf_page_number": recovery.page_number,
                "pdf_page_selector_number": data.get("page_selector_number"),
                "pdf_page_ancestor_number": data.get("page_ancestor_number"),
                "pdf_uia_matching_core_sha256": hashlib.sha256(
                    recovery.uia_matching_core.encode(
                        "utf-8",
                        errors="surrogatepass",
                    )
                ).hexdigest(),
                "pdf_uia_matching_core_chars": len(recovery.uia_matching_core),
                "pdf_dropped_uia_rectangle_count": (
                    recovery.dropped_uia_rectangle_count
                ),
                "uia_selection_text_chars": len(raw_text),
                "uia_selection_text_sha256": raw_text_sha256,
                "uia_selection_rectangle_count_total": int(
                    data.get("rectangle_count_total")
                    or len(data.get("rectangles") or [])
                ),
                "uia_selection_rectangles_truncated": bool(
                    data.get("rectangles_truncated")
                ),
            }

        artifacts = {
            "source_hwnd": hwnd,
            "source_pid": expected_pid,
            "observed_root_hwnd": observed_root_hwnd,
            "observed_pid": observed_pid,
            "element_name": data.get("element_name"),
            "automation_id": data.get("automation_id"),
            "control_type": data.get("control_type"),
            "localized_control_type": data.get("localized_control_type"),
            "class_name": data.get("class_name"),
            "element_value": data.get("element_value"),
            "help_text": data.get("help_text"),
            "perception_result_kind": result_kind,
            "range_count": data.get("range_count"),
            "selection_rectangles": selection_rectangles,
            "selection_rectangles_coordinate_space": "physical_screen_pixels",
            "selection_rectangle_count_total": rectangle_count_total,
            "selection_rectangles_truncated": rectangles_truncated,
            "selection_text_chars": len(text),
            "selection_text_sha256": hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest(),
            "truncated": bool(data.get("truncated")),
            "probe_elapsed_ms": data.get("elapsed_ms"),
            **recovery_artifacts,
        }
        return AdapterReadContext(
            adapter=self.name,
            app=app,
            window=window,
            content=text,
            label=str(window.get("title") or data.get("element_name") or "Selected text"),
            method=method,
            capabilities=capabilities,
            artifacts=artifacts,
        )
