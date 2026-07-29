from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websocket
from PIL import ImageDraw, ImageGrab

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.adapters.uia_text_adapter import _run_uia_selection_probe
from app.system_context import enable_dpi_awareness, list_visible_windows


EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
FIXTURE = ROOT / "tests" / "fixtures" / "selection_alignment.html"
EVIDENCE_ROOT = ROOT / "data" / "runtime" / "selection-alignment-20260729"
PROFILE_ROOT = ROOT / ".tmp" / "edge-selection-alignment"
PORT = 9341
REQUIRED_EVIDENCE_FIELDS = frozenset({
    "targetPointPhysical",
    "domTargetRectPhysical",
    "adapterTargetRectPhysical",
    "stageTargetDip",
    "projectedStageTargetPhysical",
    "edgeErrorDip",
    "coordinateTransforms",
    "screenshot",
})


def _wait_for_page(timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=1) as response:
                pages = json.loads(response.read().decode("utf-8"))
            page = next((item for item in pages if "Selection Alignment Fixture" in str(item.get("title"))), None)
            if page:
                return page
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError("edge_fixture_page_unavailable")


def _evaluate(websocket_url: str, expression: str) -> dict:
    connection = websocket.create_connection(websocket_url, timeout=5, origin="http://127.0.0.1")
    try:
        connection.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "returnByValue": True},
        }))
        while True:
            payload = json.loads(connection.recv())
            if payload.get("id") == 1:
                return dict(payload.get("result", {}).get("result", {}).get("value") or {})
    finally:
        connection.close()


def _wait_for_window(timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for window in list_visible_windows():
            if "Selection Alignment Fixture" in str(window.get("title") or ""):
                return dict(window)
        time.sleep(0.25)
    raise RuntimeError("edge_fixture_window_unavailable")


def _bring_to_foreground(hwnd: int, target_point: dict[str, int], timeout: float = 3.0) -> None:
    user32 = ctypes.windll.user32
    user32.ShowWindow(int(hwnd), 9)  # SW_RESTORE
    user32.SetWindowPos(
        int(hwnd), ctypes.c_void_p(-1), 0, 0, 0, 0,
        0x0001 | 0x0002 | 0x0010 | 0x0040,  # NOSIZE | NOMOVE | NOACTIVATE | SHOWWINDOW
    )
    user32.SetForegroundWindow(int(hwnd))
    deadline = time.time() + timeout
    while time.time() < deadline:
        point_window = user32.WindowFromPoint(wintypes.POINT(
            int(target_point["x"]),
            int(target_point["y"]),
        ))
        if int(user32.GetAncestor(point_window, 2)) == int(hwnd):  # GA_ROOT
            return
        time.sleep(0.05)
        user32.SetForegroundWindow(int(hwnd))
    raise RuntimeError("edge_fixture_point_obscured")


def _dom_to_physical_mapping(
    window: dict,
    geometry: dict,
    *,
    client_bounds: dict | None = None,
) -> dict:
    client = client_bounds or _window_client_bounds(int(window["hwnd"]))
    scale = max(0.1, float(geometry["devicePixelRatio"]))
    inner_width = max(1.0, float(geometry["innerWidth"]))
    inner_height = max(1.0, float(geometry["innerHeight"]))
    frame_inset = max(0.0, (float(client["width"]) - inner_width * scale) / 2.0)
    browser_chrome_height = max(
        0.0,
        float(client["height"]) - inner_height * scale - frame_inset,
    )
    return {
        "contentOriginPhysical": {
            "x": float(client["x"]) + frame_inset,
            "y": float(client["y"]) + browser_chrome_height,
        },
        "scaleX": scale,
        "scaleY": scale,
        "clientBoundsPhysical": client,
        "frameInsetPhysical": frame_inset,
        "browserChromeHeightPhysical": browser_chrome_height,
    }


def _physical_dom_rect(window: dict, geometry: dict) -> dict[str, int]:
    mapping = _dom_to_physical_mapping(window, geometry)
    target = geometry["target"]
    left = round(mapping["contentOriginPhysical"]["x"] + float(target["x"]) * mapping["scaleX"])
    top = round(mapping["contentOriginPhysical"]["y"] + float(target["y"]) * mapping["scaleY"])
    right = round(
        mapping["contentOriginPhysical"]["x"]
        + (float(target["x"]) + float(target["width"])) * mapping["scaleX"]
    )
    bottom = round(
        mapping["contentOriginPhysical"]["y"]
        + (float(target["y"]) + float(target["height"])) * mapping["scaleY"]
    )
    return {
        "x": left,
        "y": top,
        "width": right - left,
        "height": bottom - top,
    }


def _physical_target_point(window: dict, geometry: dict) -> dict[str, int]:
    rect = _physical_dom_rect(window, geometry)
    return {
        "x": round(rect["x"] + rect["width"] / 2.0),
        "y": round(rect["y"] + rect["height"] / 2.0),
    }


def _xywh_rect(value: object) -> dict[str, int] | None:
    if isinstance(value, dict):
        raw = [value.get(key) for key in ("x", "y", "width", "height")]
    elif isinstance(value, (list, tuple)) and len(value) == 4:
        raw = list(value)
    else:
        return None
    try:
        x, y, width, height = [round(float(part)) for part in raw]
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


class _Rect(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _Point(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class _MonitorInfo(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", _Rect),
                ("rcWork", _Rect), ("dwFlags", ctypes.c_ulong)]


def _window_client_bounds(hwnd: int) -> dict[str, int]:
    user32 = ctypes.windll.user32
    rect = _Rect()
    origin = _Point(0, 0)
    if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("client_rect_unavailable")
    if not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        raise RuntimeError("client_origin_unavailable")
    return {
        "x": int(origin.x),
        "y": int(origin.y),
        "width": int(rect.right - rect.left),
        "height": int(rect.bottom - rect.top),
    }


def _display_transform(hwnd: int) -> dict:
    user32 = ctypes.windll.user32
    dpi = int(user32.GetDpiForWindow(hwnd) or 96)
    scale = dpi / 96.0
    monitor = user32.MonitorFromWindow(hwnd, 2)
    info = _MonitorInfo()
    info.cbSize = ctypes.sizeof(_MonitorInfo)
    if not monitor or not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        raise RuntimeError("monitor_info_unavailable")
    physical = {
        "x": int(info.rcMonitor.left),
        "y": int(info.rcMonitor.top),
        "width": int(info.rcMonitor.right - info.rcMonitor.left),
        "height": int(info.rcMonitor.bottom - info.rcMonitor.top),
    }
    dip = {
        "x": round(physical["x"] / scale),
        "y": round(physical["y"] / scale),
        "width": round(physical["width"] / scale),
        "height": round(physical["height"] / scale),
    }
    return {"dpi": dpi, "scaleFactor": scale, "physicalBounds": physical, "dipBounds": dip}


def _normalize_stage_geometry(payload: dict) -> dict:
    node_source = r"""
const fs = require('fs');
const { normalizeGroundingGeometry } = require('./electron/coordinate_space');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const transform = input.displayTransform;
const scale = Number(transform.scaleFactor);
const physical = transform.physicalBounds;
const dip = transform.dipBounds;
const screenApi = {
  screenToDipPoint(point) {
    return {
      x: dip.x + ((point.x - physical.x) / scale),
      y: dip.y + ((point.y - physical.y) / scale),
    };
  },
  screenToDipRect(_window, rect) {
    return {
      x: Math.round(dip.x + ((rect.x - physical.x) / scale)),
      y: Math.round(dip.y + ((rect.y - physical.y) / scale)),
      width: Math.round(rect.width / scale),
      height: Math.round(rect.height / scale),
    };
  },
};
const result = normalizeGroundingGeometry({
  ...input.geometry,
  stageBounds: dip,
  screenApi,
});
process.stdout.write(JSON.stringify(result));
"""
    completed = subprocess.run(
        ["node", "-e", node_source],
        cwd=ROOT,
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"grounding_geometry_failed:{completed.stderr.strip()[:240]}")
    return dict(json.loads(completed.stdout))


def _project_stage_target(stage_target: dict, display_transform: dict) -> dict[str, int]:
    scale = float(display_transform["scaleFactor"])
    physical = display_transform["physicalBounds"]
    dip = display_transform["dipBounds"]
    global_left_dip = float(dip["x"]) + float(stage_target["x"])
    global_top_dip = float(dip["y"]) + float(stage_target["y"])
    global_right_dip = global_left_dip + float(stage_target["width"])
    global_bottom_dip = global_top_dip + float(stage_target["height"])
    left = round(float(physical["x"]) + (global_left_dip - float(dip["x"])) * scale)
    top = round(float(physical["y"]) + (global_top_dip - float(dip["y"])) * scale)
    right = round(float(physical["x"]) + (global_right_dip - float(dip["x"])) * scale)
    bottom = round(float(physical["y"]) + (global_bottom_dip - float(dip["y"])) * scale)
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def _edge_error_dip(expected: dict, observed: dict, scale_factor: float) -> dict[str, float]:
    return {
        "left": round(abs(expected["x"] - observed["x"]) / scale_factor, 3),
        "top": round(abs(expected["y"] - observed["y"]) / scale_factor, 3),
        "right": round(abs(
            expected["x"] + expected["width"] - observed["x"] - observed["width"]
        ) / scale_factor, 3),
        "bottom": round(abs(
            expected["y"] + expected["height"] - observed["y"] - observed["height"]
        ) / scale_factor, 3),
    }


def validate_alignment_evidence(evidence: dict) -> tuple[bool, list[str]]:
    errors = [f"missing:{key}" for key in sorted(REQUIRED_EVIDENCE_FIELDS - evidence.keys())]
    edge_error = evidence.get("edgeErrorDip")
    if not isinstance(edge_error, dict):
        errors.append("invalid:edgeErrorDip")
    else:
        try:
            values = [float(edge_error[key]) for key in ("left", "top", "right", "bottom")]
        except (KeyError, TypeError, ValueError):
            errors.append("invalid:edgeErrorDip")
        else:
            if any(not (value >= 0.0) for value in values):
                errors.append("invalid:edgeErrorDip")
            elif max(values) > 2.0:
                errors.append("edge_error_exceeds_2_dip")
    return not errors, errors


def main() -> int:
    if not EDGE.exists():
        raise RuntimeError("microsoft_edge_not_found")
    enable_dpi_awareness()
    EVIDENCE_ROOT.mkdir(parents=True, exist_ok=True)
    profile_path = PROFILE_ROOT / f"run-{os.getpid()}-{time.time_ns()}"
    profile_path.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen([
        str(EDGE),
        f"--remote-debugging-port={PORT}",
        "--remote-allow-origins=*",
        f"--user-data-dir={profile_path}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-features=msEdgeTranslate,Translate",
        "--force-renderer-accessibility",
        "--window-position=120,80",
        "--window-size=1040,900",
        FIXTURE.resolve().as_uri(),
    ])
    try:
        page = _wait_for_page()
        window = _wait_for_window()
        geometry = _evaluate(page["webSocketDebuggerUrl"], """(() => {
          const target = document.getElementById('target');
          const stale = document.getElementById('stale');
          const range = document.createRange();
          range.selectNodeContents(stale);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          const rect = target.getBoundingClientRect();
          return {
            outerWidth: window.outerWidth, outerHeight: window.outerHeight,
            innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            target: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            staleText: selection.toString()
          };
        })()""")
        dom_target_rect = _physical_dom_rect(window, geometry)
        target_point = _physical_target_point(window, geometry)
        _bring_to_foreground(int(window["hwnd"]), target_point)
        ctypes.windll.user32.SetCursorPos(target_point["x"], target_point["y"])
        time.sleep(0.5)
        probe = _run_uia_selection_probe(int(window["hwnd"]), target_point=target_point, timeout=5)
        raw = dict(probe.data or {})
        probe_passed = bool(
            probe.ok
            and raw.get("result_kind") == "point_element"
            and "TARGET COPY THIS" in str(raw.get("text") or "")
            and raw.get("rejected_selection_reason") == "selection_outside_target_point"
        )
        adapter_target_rect = _xywh_rect((raw.get("rectangles") or [raw.get("element_rect")])[0])
        if adapter_target_rect is None:
            raise RuntimeError(
                "adapter_target_rectangle_unavailable:"
                + json.dumps({
                    "raw": raw,
                    "windowBbox": window.get("bbox"),
                    "browserGeometry": geometry,
                    "domTargetRectPhysical": dom_target_rect,
                    "targetPointPhysical": target_point,
                }, ensure_ascii=True)[:2400]
            )
        display_transform = _display_transform(int(window["hwnd"]))
        grounding = _normalize_stage_geometry({
            "displayTransform": display_transform,
            "geometry": {
                "pointer": target_point,
                "pointerSpace": "physical_screen_pixels",
                "targetRects": [adapter_target_rect],
                "targetSpace": "physical_screen_pixels",
                "targetFormat": "xywh",
            },
        })
        if grounding.get("state") != "resolved":
            raise RuntimeError(f"grounding_geometry_not_resolved:{grounding.get('reason')}")
        stage_target = dict(grounding["stageTarget"])
        projected_target = _project_stage_target(stage_target, display_transform)
        edge_error = _edge_error_dip(
            dom_target_rect,
            projected_target,
            float(display_transform["scaleFactor"]),
        )

        left, top, right, bottom = [int(value) for value in window["bbox"]]
        image = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
        draw = ImageDraw.Draw(image)
        def local_box(rect: dict) -> tuple[int, int, int, int]:
            return (
                rect["x"] - left,
                rect["y"] - top,
                rect["x"] + rect["width"] - left,
                rect["y"] + rect["height"] - top,
            )

        draw.rectangle(local_box(dom_target_rect), outline="#16a34a", width=5)
        draw.rectangle(local_box(projected_target), outline="#d946ef", width=2)
        local_x, local_y = target_point["x"] - left, target_point["y"] - top
        draw.ellipse((local_x - 12, local_y - 12, local_x + 12, local_y + 12), outline="#ff2d55", width=4)
        draw.line((local_x - 18, local_y, local_x + 18, local_y), fill="#ff2d55", width=3)
        draw.line((local_x, local_y - 18, local_x, local_y + 18), fill="#ff2d55", width=3)
        screenshot = EVIDENCE_ROOT / "dom-uia-stage-overlap.png"
        image.save(screenshot)

        evidence = {
            "schemaVersion": 2,
            "fixture": str(FIXTURE),
            "window": window,
            "targetPointPhysical": target_point,
            "domTargetRectPhysical": dom_target_rect,
            "adapterTargetRectPhysical": adapter_target_rect,
            "stageTargetDip": stage_target,
            "projectedStageTargetPhysical": projected_target,
            "edgeErrorDip": edge_error,
            "coordinateTransforms": {
                "domCssToPhysical": _dom_to_physical_mapping(window, geometry),
                "physicalToDip": display_transform,
                "groundingState": grounding.get("state"),
            },
            "staleSelectionText": geometry.get("staleText"),
            "returnedText": raw.get("text"),
            "resultKind": raw.get("result_kind"),
            "rejectedSelectionReason": raw.get("rejected_selection_reason"),
            "returnedRectangles": raw.get("rectangles"),
            "screenshot": str(screenshot),
            "probeError": probe.error,
        }
        schema_passed, validation_errors = validate_alignment_evidence(evidence)
        passed = probe_passed and schema_passed
        evidence["passed"] = passed
        evidence["validationErrors"] = validation_errors
        current_scale = round(float(display_transform["scaleFactor"]) * 100)
        evidence["displayScaleCoverage"] = [
            {
                "scalePercent": scale,
                "status": "verified" if scale == current_scale else "blocked",
                "reason": None if scale == current_scale else "display_mode_unavailable",
            }
            for scale in (100, 125, 150, 200)
        ]
        output = EVIDENCE_ROOT / "evidence.json"
        output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(evidence, ensure_ascii=True))
        return 0 if passed else 1
    finally:
        subprocess.run(
            ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )


if __name__ == "__main__":
    raise SystemExit(main())
