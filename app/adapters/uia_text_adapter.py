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
    """Parse an int that may be None / '' / non-numeric, returning `default`.

    `default` must be the caller's sentinel: the cold-tree judgement needs
    -1 (unknown) to stay distinct from 0 (measured zero documents), so this
    helper must never be written as `value or -1` — 0 is a legal answer.
    """
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

ROOT = Path(__file__).resolve().parents[2]
UIA_PROBE_SOURCE = ROOT / "scripts" / "uia_selection_probe.cs"
UIA_PROBE_EXE = ROOT / "data" / "runtime" / "uia_selection_probe.exe"

# These classes get app-specific treatment further down (PDF text-layer
# verification, terminal buffer extraction, Chromium's lazy tree). The set is a
# routing hint, NOT an admission list: it used to gate match_window, which meant
# Notepad, Explorer, WeChat and every ordinary Win32 input box were refused
# before the probe ever ran -- not because UIA could not read them, but because
# they were not enumerated here. A new app was unsupported by default.
UIA_WINDOW_CLASSES = {
    "AcrobatMDIFrame",
    "AcrobatSDIWindow",
    "Chrome_WidgetWin_1",
    "MozillaWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "ConsoleWindowClass",
}

# Surfaces with no user text to read. Asking UIA about them costs a probe and can
# only answer "nothing selected", so they stay excluded even though the default
# is now to admit.
UIA_EXCLUDED_WINDOW_CLASSES = {
    "Progman",                      # desktop
    "WorkerW",                      # desktop wallpaper host
    "Shell_TrayWnd",                # taskbar
    "TrayNotifyWnd",
    "NotifyIconOverflowWindow",
    "Shell_SecondaryTrayWnd",
    "#32768",                       # menus
    "tooltips_class32",
    "Windows.UI.Core.CoreWindow",   # shell overlays (Start, Search)
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
    """'open' (default) admits any window; 'whitelist' restores the old gate.

    Read per call rather than cached at import: this is a stop-the-bleeding switch,
    and needing to restart the app to use it would defeat the point.
    """
    value = str(os.environ.get("MAGIC_POINTER_UIA_WINDOW_SCOPE") or "").strip().casefold()
    return "whitelist" if value == "whitelist" else "open"


def clipboard_fallback_forbidden(window: JsonDict) -> tuple[bool, str]:
    """Whether synthesizing Ctrl+C to read this window is unsafe.

    Nothing sends Ctrl+C today; UIA is a pure query. This exists because opening
    match_window to every app makes such a fallback tempting for the windows UIA
    cannot read, and in a terminal Ctrl+C is not "copy" -- it is SIGINT to
    whatever is running. A fallback added later without this check would kill the
    user's build to read their selection.

    Returns (forbidden, reason). Callers that synthesize keys must consult this
    and treat a forbidden window as unreadable rather than working around it.
    """
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


# ---------------------------------------------------------------------------
# Resident UIA host (Phase C): same probe logic, one long-lived process on a
# named pipe. Kills the ~570ms per-read process cold-start tax.
# ---------------------------------------------------------------------------

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
    """Best-effort detached spawn; the pipe ping decides whether it worked."""
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
    """The process-wide resident host client; None when disabled."""
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
    """One probe over the resident host; None when the host path is unusable
    (caller falls back to the per-request probe process)."""
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
        # Transport failure: the host may simply not be running. Spawn once
        # per cooldown window and give it one retry before falling back.
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
    # 2.5s default, not 1.0s. The probe caps its own UIA work at
    # UiaProbeHardTimeoutMs (1200ms) and then still has to serialize its result,
    # and process startup costs ~70ms warm. Measured wall clock on live windows
    # reached 1194ms, so the old 1.0s budget killed the probe *while it was
    # answering correctly*, and the caller treated that as a read failure. This
    # timeout only bounds a wedged process, so it must stay above the probe's own
    # ceiling — callers that pass their own value are responsible for the same.
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


def _is_chromium_window(window: JsonDict) -> bool:
    class_name = str(window.get("class_name") or "")
    if class_name in {"Chrome_WidgetWin_1", "Chrome_WidgetWin_0", "Chrome_RenderWidgetHostHWND"}:
        return True
    title = str(window.get("title") or "").casefold()
    return "edge" in title or "chrome" in title or "brave" in title


# 已知的 web 宿主外壳类名。判冷的第一个必要条件：这个窗口里**本来该有**一份
# 网页文档，只是还没挂上来。不在这张表里的窗口没有「正文迟到」这回事。
COLD_TREE_WEB_HOST_CLASSES = (
    "WRY_WEBVIEW",              # Tauri
    "Chrome_WidgetWin_",        # Chromium / Electron / Edge，带 _0 _1 后缀
    "Chrome_RenderWidgetHostHWND",
    "Intermediate D3D Window",  # Chromium 合成层，冷热都在
    "Tauri Window",
    "WebView2",
    "Microsoft.UI.Content.DesktopChildSiteBridge",
)

# 自绘 / 非 UIA 承载的窗口。这些窗口的树**永远**长成冷树的样子，等多久都不会变。
# 少了这张表，每次点微信都白等 60ms，换来的还是那 8 个节点。
COLD_TREE_DENY_CLASSES = (
    "MMUIRenderSubWindowHW",           # 微信主窗
    "Qt5",                             # Qt 自绘，含 Qt51514QWindowIcon 等
    "Qt6",
    "CASCADIA_HOSTING_WINDOW_CLASS",   # Windows Terminal
    "ConsoleWindowClass",
    "SunAwtFrame",                     # JetBrains / Swing 自绘
    "GLFW30",
)


def is_cold_tree(
    class_chain: Sequence[str] | None,
    document_count: int,
    *,
    max_depth: int | None = None,
    named_count: int | None = None,
) -> bool:
    """这棵树是「壳起来了但正文还没挂上」吗？是的话值得隔 60ms 再读一次。

    判据只有三步，按顺序：排除表 → 宿主表 → 有没有 Document。

    `document_count` 是探针里 `FindAll(TreeScope.Descendants, ControlType.Document)`
    的结果，`-1` 表示那一趟没跑（探针提前读到了选区，那按定义就不冷）。
    不知道就不算冷 —— 拿不到就留空绝不猜。

    **`max_depth` 和 `named_count` 是可选的，而且不是阈值**，只用来确认传进来的
    确实是一棵树；没量过就别传，不要拿假数字填。
    Vida.md §7.3 原方案拿它们当判据（`max_depth <= 8` 且 `named_count < 30`），
    真实 dump 把两条都证伪了，数字见 tests/uia_cold_tree_test.py 的模块注释：
    冷树实测 11 层（浏览器外壳自己就有十来层，冷的不是层数少是层里没东西），
    而冷 21 / 热 27 个有名字的节点只差 6 个，落在噪声里。

    误判的代价是不对称的，所以判据往「宁可多读一次」偏：
    判热了其实是冷 → 用户第一次划线静默读不到，这正是要修的 bug；
    判冷了其实是热 → 多 60ms 一次，只重试一次不递归。
    """
    classes = [str(item) for item in (class_chain or []) if str(item).strip()]
    if any(name.startswith(deny) for name in classes for deny in COLD_TREE_DENY_CLASSES):
        return False
    if not any(name.startswith(host) for name in classes for host in COLD_TREE_WEB_HOST_CLASSES):
        return False
    if document_count != 0:
        return False
    # 连根节点都没有：这不是一棵冷树，是一次失败的读取，交给上面的错误分支。
    if max_depth is not None and max_depth <= 0:
        return False
    return named_count is None or named_count >= 0


class UiaTextSelectionAdapter(AppAdapter):
    name = "uia_text_selection"
    perception_layer = "uia"
    perception_priority = 30

    def match_window(self, window: JsonDict) -> bool:
        """Admit any real window unless we know there is nothing to read there.

        Inverted from a whitelist deliberately. Gating on UIA_WINDOW_CLASSES meant
        an app was unsupported until someone added its class name, so Notepad,
        Explorer and WeChat fell through to OCR while UIA could have read them.
        Admitting by default costs a probe on windows with no selection; refusing
        by default costs every app nobody has enumerated yet.

        Set MAGIC_POINTER_UIA_WINDOW_SCOPE=whitelist to restore the old gate.
        """
        title = str(window.get("title") or "")
        if title in MAGIC_WINDOW_TITLES:
            return False
        class_name = str(window.get("class_name") or "")
        if _window_scope_mode() == "whitelist":
            return class_name in UIA_WINDOW_CLASSES
        if class_name in UIA_EXCLUDED_WINDOW_CLASSES:
            return False
        if not class_name:
            # No class name means the enumeration itself is suspect; the probe
            # needs a real HWND anyway and read_context checks that separately.
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

        # 两种重试，原因不同，等的时间也不同。别再把它们并成一条。
        #
        # 一、探针一个字都没吐出来：超时、崩了、或者编译没成。这条从前就有
        #    （`if not probe.data`），只是注释挂的是「懒建树」的名头——它其实
        #    从来只在这种情况下触发。450ms 这个值没有实测支撑，先原样留着。
        if not probe.data and _is_chromium_window(window):
            try:
                import time as _time

                _time.sleep(0.45)
            except Exception:
                pass
            probe = _reprobe()

        # 二、冷树：Chromium/WebView2/Tauri 懒建无障碍树，第一次 UIA 触碰摸到的
        #    是一具外壳。这条以前**从来没有触发过**——冷树恰恰是有 data 的
        #    （实测冷启动 Edge 返回 48 个节点、21 个有名字的，只是里面一个
        #    Document 都没有），所以它一直被上面那条的 `not probe.data` 挡在外面，
        #    用户第一次划线还是静默读不到。非空不等于读到了。
        #    判据见 is_cold_tree；60ms 来自 E4 受控实验（0ms 时 0 个 Document，
        #    50ms 时 2 个，此后稳定），留 20% 余量。只重试一次，不递归。
        if not probe.ok and is_cold_tree(
            [str(window.get("class_name") or ""), str(probe.data.get("class_name") or "")],
            # 不能写 `x or -1`：冷树的 document_count 正好是 0，会被当成假值
            # 换成 -1（未知），判据直接翻面，重试又一次都不触发。
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
            # Geometry with no readable name: the probe found the box the user
            # pointed at but nothing to read from it. Worth reporting, because it
            # clips the pixel fallback to that box instead of the whole screen.
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
        if (
            result_kind not in {"point_element", "point_region", "terminal_buffer"}
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
