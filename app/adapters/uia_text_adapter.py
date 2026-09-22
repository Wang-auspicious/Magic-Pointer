from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.adapters.base import AdapterCapability, AdapterReadContext, AppAdapter
from app.adapters.pdf_selection_recovery import recover_local_pdf_selection
from app.grounding.terminal_evidence import TerminalEvidenceExtractor

JsonDict = dict[str, Any]


def _as_int(value: Any, default: int = -1) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

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

UIA_EXCLUDED_WINDOW_CLASSES = {
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "TrayNotifyWnd",
    "NotifyIconOverflowWindow",
    "Shell_SecondaryTrayWnd",
    "#32768",
    "tooltips_class32",
    "Windows.UI.Core.CoreWindow",
    "XamlExplorerHostIslandWindow",
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


def _window_scope_mode() -> str:
    value = str(os.environ.get("MAGIC_POINTER_UIA_WINDOW_SCOPE") or "").strip().casefold()
    return "whitelist" if value == "whitelist" else "open"


def clipboard_fallback_forbidden(window: JsonDict) -> tuple[bool, str]:
    if uia_app_from_window(window) == "terminal":
        return True, "ctrl_c_is_sigint_in_terminals"
    if str(window.get("title") or "") in MAGIC_WINDOW_TITLES:
        return True, "magic_pointer_own_surface"
    return False, ""


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



UIA_HOST_EXE = ROOT / "data" / "runtime" / "uia_resident_host.exe"

_uia_host_client = None
_uia_host_disabled = None
_last_host_spawn_ms = -1e9


def _host_enabled() -> bool:
    global _uia_host_disabled
    if _uia_host_disabled is None:
        _uia_host_disabled = (
            os.environ.get("MAGIC_POINTER_UIA_HOST", "1").strip().casefold()
            in ("0", "false", "no", "off")
        )
    return not _uia_host_disabled


def _compile_uia_resident_host(*, timeout: int = 20) -> UiaProbeResult:
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
    UIA_HOST_EXE.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(csc),
        "/nologo",
        "/target:exe",
        "/optimize+",
        "/define:RESIDENT_HOST",
        f"/out:{UIA_HOST_EXE}",
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
        return UiaProbeResult(False, {}, f"resident UIA host compilation failed: {type(exc).__name__}: {exc}")
    if proc.returncode != 0 or not UIA_HOST_EXE.exists():
        detail = (proc.stderr or proc.stdout).strip().replace("\r", " ").replace("\n", " ")[:1600]
        return UiaProbeResult(False, {}, f"resident UIA host compilation failed: {detail}")
    return UiaProbeResult(True, {"compiled": True})


def _ensure_uia_resident_host() -> UiaProbeResult:
    try:
        if (
            UIA_HOST_EXE.exists()
            and UIA_HOST_EXE.stat().st_mtime_ns >= UIA_PROBE_SOURCE.stat().st_mtime_ns
        ):
            return UiaProbeResult(True, {"compiled": False})
    except OSError:
        pass
    return _compile_uia_resident_host()


def _spawn_resident_host() -> None:
    try:
        pipe_name = os.environ.get("MAGIC_POINTER_UIA_HOST_PIPE", "MagicPointerUIAHost")
        env = dict(os.environ)
        env["MAGIC_POINTER_UIA_HOST_PIPE"] = pipe_name
        subprocess.Popen(
            [str(UIA_HOST_EXE)],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
    except Exception:
        pass


def get_uia_host_client():
    global _uia_host_client
    if not _host_enabled():
        return None
    if _uia_host_client is None:
        from app.uia_host_client import UiaHostClient

        _uia_host_client = UiaHostClient()
    return _uia_host_client


def _resident_probe(
    hwnd: int,
    *,
    target_point: dict[str, int] | None = None,
    target_region: dict[str, int] | None = None,
) -> UiaProbeResult | None:
    global _last_host_spawn_ms
    client = get_uia_host_client()
    if client is None or not client.available():
        return None
    prepared = _ensure_uia_resident_host()
    if not prepared.ok:
        return None
    try:
        data = client.probe(
            int(hwnd),
            target_point=target_point,
            target_region=target_region,
        )
    except Exception:
        data = None
    if not isinstance(data, dict):
        now = time.monotonic()
        if now - _last_host_spawn_ms >= 30.0:
            _last_host_spawn_ms = now
            _spawn_resident_host()
            time.sleep(0.25)
            try:
                data = client.probe(
                    int(hwnd),
                    target_point=target_point,
                    target_region=target_region,
                )
            except Exception:
                data = None
        if not isinstance(data, dict):
            return None
    if data.get("ok") is True:
        return UiaProbeResult(True, data)
    if "ok" in data:
        return UiaProbeResult(False, data, str(data.get("error") or "")[:1600])
    return None


def _run_uia_selection_probe(
    hwnd: int,
    *,
    target_point: dict[str, int] | None = None,
    target_region: dict[str, int] | None = None,
    timeout: float = 2.5,
) -> UiaProbeResult:
    probe_timeout = 6.0 if target_region is not None else timeout
    resident = _resident_probe(
        int(hwnd),
        target_point=target_point,
        target_region=target_region,
    )
    if resident is not None:
        return resident
    prepared = _ensure_uia_probe()
    if not prepared.ok:
        return prepared
    try:
        argv = [str(UIA_PROBE_EXE), str(int(hwnd))]
        if isinstance(target_region, dict):
            try:
                argv.extend([
                    "--region",
                    str(int(target_region.get("x"))),
                    str(int(target_region.get("y"))),
                    str(int(target_region.get("width"))),
                    str(int(target_region.get("height"))),
                ])
            except (TypeError, ValueError):
                pass
        elif isinstance(target_point, dict):
            try:
                argv.extend([
                    str(int(target_point.get("x"))),
                    str(int(target_point.get("y"))),
                ])
            except (TypeError, ValueError):
                pass
        if os.environ.get("MAGIC_POINTER_UIA_PROBE_DEBUG"):
            try:
                with open(
                    os.environ.get("MAGIC_POINTER_UIA_PROBE_DEBUG") or "uia-probe-debug.log",
                    "a",
                    encoding="utf-8",
                ) as debug_handle:
                    debug_handle.write(json.dumps({"argv": argv}, ensure_ascii=False) + "\n")
            except Exception:
                pass
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=probe_timeout,
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


def _is_chromium_window(window: JsonDict) -> bool:
    class_name = str(window.get("class_name") or "")
    if class_name in {"Chrome_WidgetWin_1", "Chrome_WidgetWin_0", "Chrome_RenderWidgetHostHWND"}:
        return True
    title = str(window.get("title") or "").casefold()
    return "edge" in title or "chrome" in title or "brave" in title


COLD_TREE_WEB_HOST_CLASSES = (
    "WRY_WEBVIEW",
    "Chrome_WidgetWin_",
    "Chrome_RenderWidgetHostHWND",
    "Intermediate D3D Window",
    "Tauri Window",
    "WebView2",
    "Microsoft.UI.Content.DesktopChildSiteBridge",
)

COLD_TREE_DENY_CLASSES = (
    "MMUIRenderSubWindowHW",
    "Qt5",
    "Qt6",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "ConsoleWindowClass",
    "SunAwtFrame",
    "GLFW30",
)


SELF_DRAWN_WINDOW_CLASSES = tuple(
    name
    for name in COLD_TREE_DENY_CLASSES
    if name not in {"CASCADIA_HOSTING_WINDOW_CLASS", "ConsoleWindowClass"}
)


def _is_self_drawn_window(class_name: str) -> bool:
    return any(str(class_name).startswith(prefix) for prefix in SELF_DRAWN_WINDOW_CLASSES)


def is_cold_tree(
    class_chain: Sequence[str] | None,
    document_count: int,
    *,
    max_depth: int | None = None,
    named_count: int | None = None,
) -> bool:
    classes = [str(item) for item in (class_chain or []) if str(item).strip()]
    if any(name.startswith(deny) for name in classes for deny in COLD_TREE_DENY_CLASSES):
        return False
    if not any(name.startswith(host) for name in classes for host in COLD_TREE_WEB_HOST_CLASSES):
        return False
    if document_count != 0:
        return False
    if max_depth is not None and max_depth <= 0:
        return False
    return named_count is None or named_count >= 0


class UiaTextSelectionAdapter(AppAdapter):
    name = "uia_text_selection"
    perception_layer = "uia"
    perception_priority = 30

    def match_window(self, window: JsonDict) -> bool:
        title = str(window.get("title") or "")
        if title in MAGIC_WINDOW_TITLES:
            return False
        class_name = str(window.get("class_name") or "")
        if _window_scope_mode() == "whitelist":
            return class_name in UIA_WINDOW_CLASSES
        if class_name in UIA_EXCLUDED_WINDOW_CLASSES:
            return False
        if not class_name:
            return False
        if _is_self_drawn_window(class_name):
            return False
        return True

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
        raw_target_region = kwargs.get("target_region")
        target_point = None
        target_region = None
        if isinstance(raw_target_point, dict):
            try:
                target_point = {
                    "x": int(raw_target_point.get("x")),
                    "y": int(raw_target_point.get("y")),
                }
            except (TypeError, ValueError):
                target_point = None
        if isinstance(raw_target_region, dict):
            try:
                target_region = {
                    "x": int(raw_target_region.get("x")),
                    "y": int(raw_target_region.get("y")),
                    "width": int(raw_target_region.get("width")),
                    "height": int(raw_target_region.get("height")),
                }
                if target_region["width"] <= 0 or target_region["height"] <= 0:
                    target_region = None
            except (TypeError, ValueError):
                target_region = None
        probe = (
            _run_uia_selection_probe(hwnd, target_region=target_region)
            if target_region is not None
            else _run_uia_selection_probe(hwnd, target_point=target_point)
            if target_point is not None
            else _run_uia_selection_probe(hwnd)
        )

        def _reprobe() -> UiaProbeResult:
            if target_region is not None:
                return _run_uia_selection_probe(hwnd, target_region=target_region)
            if target_point is not None:
                return _run_uia_selection_probe(hwnd, target_point=target_point)
            return _run_uia_selection_probe(hwnd)

        if not probe.data and _is_chromium_window(window):
            try:
                import time as _time

                _time.sleep(0.45)
            except Exception:
                pass
            probe = _reprobe()

        if not probe.ok and is_cold_tree(
            [str(window.get("class_name") or ""), str(probe.data.get("class_name") or "")],
            _as_int(probe.data.get("document_count"), -1),
        ):
            try:
                import time as _time

                _time.sleep(0.06)
            except Exception:
                pass
            probe = _reprobe()
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
            else "uia:document-text"
            if result_kind == "document_text"
            else "uia:region-elements"
            if result_kind == "region_elements"
            else "uia:element-from-point"
            if result_kind == "point_element"
            else "uia:element-region-from-point"
            if result_kind == "point_region"
            else "uia:text-pattern.selection"
        )
        selection_rectangles = list(data.get("rectangles") or [])[:32]
        if result_kind in {"point_element", "point_region", "terminal_buffer", "document_text"} and not selection_rectangles:
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
            sanitized_anchor = str(
                (terminal_evidence.get("anchor") or {}).get("text") or ""
            ).strip()
            text = sanitized_anchor or str(
                (terminal_evidence.get("window") or {}).get("text") or ""
            )
            recovery_artifacts = {
                "terminal_evidence": terminal_evidence,
                "terminal_buffer_chars": len(raw_text),
                "terminal_buffer_sha256": hashlib.sha256(
                    raw_text.encode("utf-8", errors="surrogatepass")
                ).hexdigest(),
                "terminal_anchor_available": bool(data.get("terminal_anchor_text")),
            }
        frozen_screen = kwargs.get("screen_capture")
        if app == "pdf" and frozen_screen is None and kwargs.get("frozen_frame_path"):
            from PIL import Image

            bbox = kwargs.get("frozen_frame_bbox") or [0, 0]
            with Image.open(kwargs["frozen_frame_path"]) as frozen:
                frozen_screen = (frozen.convert("RGB"), (int(bbox[0]), int(bbox[1])))
        if app == "pdf" and frozen_screen is None:
            recovery_artifacts["pdf_visual_verification"] = "not_attempted_no_frozen_pixels"
        if (
            result_kind not in {"point_element", "point_region", "terminal_buffer"}
            and
            app == "pdf"
            and str(window.get("class_name") or "") == "Chrome_WidgetWin_1"
            and frozen_screen is not None
        ):
            recovery = recover_local_pdf_selection(data, screen_capture=frozen_screen)
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
            "selection_rectangles_format": "xywh",
            "selection_rectangle_count_total": rectangle_count_total,
            "selection_rectangles_truncated": rectangles_truncated,
            "selection_text_chars": len(text),
            "selection_text_sha256": hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest(),
            "region_elements": list(data.get("region_elements") or [])[:64],
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
