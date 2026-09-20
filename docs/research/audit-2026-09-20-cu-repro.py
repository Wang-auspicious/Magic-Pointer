"""Read-only CU audit witnesses; injected fakes, never touch the desktop."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.desktop_actions.session import DesktopActionSession, InputOwnershipLock
from app.computer_operator.windows import Win32InputDriver
from app.adapters.office_adapter import OfficeAdapter, OfficeProbeResult
from app.agent_runtime.tool_registry import ToolRegistry
from app.desktop_actions.session import register_desktop_action_tools

WINDOW = {"hwnd": 42, "pid": 100, "rect": [0, 0, 1000, 1000], "window_id": "w-42"}

class Driver:
    def __init__(self): self.calls = []
    def click(self, point, **kw): self.calls.append(["click", point, kw])
    def scroll(self, point, **kw): self.calls.append(["scroll", point, kw])
    def type_text(self, text): self.calls.append(["type", text])
    def key_down(self, key):
        self.calls.append(["down", key])
        if key == "unsupported": raise ValueError("unsupported_key")
    def key_up(self, key): self.calls.append(["up", key])
    def drag(self, start, end, **kw): self.calls.append(["drag", start, end, kw])

def row(i=1, name="Body", **kw):
    return {"index": i, "role": "edit", "name": name, "value": "prefix", "rect": [10, 20+i, 400, 30+i], "patterns": ["Value"], **kw}

def session(rows=None, driver=None, **kw):
    return DesktopActionSession(driver=driver or Driver(), windows_probe=lambda: [dict(WINDOW)], elements_probe=lambda _: rows if rows is not None else [row()], launcher=lambda _: {}, uia_act=lambda *args: {"ok": True, "value": "prefixsuffix"}, session_id="loop", **kw)

out = {}
s = session()
out["focus"] = {"result": json.loads(s.activate_window("w-42")), "driver_calls": list(s.driver.calls), "production_driver_has_activate": hasattr(Win32InputDriver, "activate")}
snap = json.loads(s.get_app_state())["snapshot_id"]
s.scroll(snapshot_id=snap, index=1, dx=3, dy=0)
out["horizontal_scroll"] = s.driver.calls[-1]
s = session([row(i, "Target" if i == 101 else f"item-{i}") for i in range(1, 102)])
state = json.loads(s.observe_ui())["state_id"]
out["full_tree_search"] = {"raw_nodes": len(s._snapshots[state].raw_elements), "visible_nodes": len(s._snapshots[state].elements), "search": json.loads(s.search_ui(state, text="Target"))}
s = session([row(name="a" * 100 + " Needle", value="")])
state = json.loads(s.observe_ui())["state_id"]
out["long_text_search"] = {"read_text": json.loads(s.read_text(state, "@e1"))["text"], "search": json.loads(s.search_ui(state, text="Needle"))}
s = session()
state = json.loads(s.observe_ui())["state_id"]
try: s.press_key(state, "ctrl+unsupported")
except ValueError: pass
out["chord_error_calls"] = s.driver.calls
raw = Win32InputDriver.__new__(Win32InputDriver)
entries = []
raw._send = lambda items: entries.extend(items)
raw.type_text("one\ntwo\tthree")
out["type_control_keys"] = [{"vk": e.ki.wVk, "flags": e.ki.dwFlags} for e in entries if e.ki.wVk]
s = session()
state = json.loads(s.observe_ui())["state_id"]
out["append_verification"] = json.loads(s.type_text(state, "suffix", index=1, clear=False))
lock = InputOwnershipLock()
first, second = session(ownership=lock), session(ownership=lock)
first._require_input()
second._require_input()
out["same_owner_for_two_sessions"] = {"first": first.session_id, "second": second.session_id, "holder": lock.holder}
s = session()
reg = ToolRegistry()
register_desktop_action_tools(reg, s)
state = json.loads(s.observe_ui())["state_id"]
r = reg.execute_tool("act_ui", {"state_id": state, "actions": [{"action": "typeText", "text": "already written"}, {"action": "keypress", "keys": ["unsupported"]}]})
out["partial_batch"] = {"driver_calls": s.driver.calls, "is_error": r.is_error, "value": str(r.value), "error": r.error_message}
s = session()
state = json.loads(s.observe_ui())["state_id"]
s.act_ui(state, [{"action": "drag", "path": [{"x": 10, "y": 20}, {"x": 300, "y": 400}, {"x": 500, "y": 20}]}])
out["drag_path"] = s.driver.calls
s = session([row(runtime_id=[1])])
state = json.loads(s.observe_ui())["state_id"]
s.elements_probe = lambda _: [row(runtime_id=[2])]
s.click(state, index=1)
out["changed_runtime_id"] = s.driver.calls
s = session()
state = json.loads(s.observe_ui())["state_id"]
s.elements_probe = lambda _: []
out["absent_after_failed_probe"] = json.loads(s.wait_for(state, text="Body", until="absent", timeout_ms=100))
s = session()
for _ in range(200): s.get_app_state()
out["snapshot_retention"] = len(s._snapshots)
out["visual_mode"] = json.loads(s.observe_ui(mode="visual"))
scripts = []
def capture_script(script, **kw):
    scripts.append(script)
    return OfficeProbeResult(False, {}, "audit intercepted; not executed")
with patch("app.adapters.office_adapter._run_powershell_json", capture_script):
    OfficeAdapter().read_context({"hwnd": 42, "class_name": "XLMAIN"}, target_region={"x": 10, "y": 20, "width": 30, "height": 40})
out["excel_unreplaced"] = [token for token in ("{region_x}", "{region_y}", "{region_w}", "{region_h}") if token in scripts[0]]

# Expanded read-only witnesses. Real production functions, fake files/DOM/UIA;
# no browser, screenshot, input, network, OCR worker, or model is started.
import hashlib
import subprocess
import tempfile
from types import SimpleNamespace
from PIL import Image
from app.grounding.explorer_adapter import resolve_child_path
from app.adapters.uia_text_adapter import UiaTextSelectionAdapter, UiaProbeResult
from app.adapters.browser_devtools_adapter import BROWSER_DOCUMENT_READ_SCRIPT, ChromeDevToolsDocumentClient
from app.context_pack.browser_reader import BrowserContextReader
from app.context_pack.sources import SourceRef
from scripts.selection_snapshot_bridge import capture_snapshot

with tempfile.TemporaryDirectory(prefix="mp-cu-audit-") as scratch:
    folder = Path(scratch).resolve()
    assert folder.parent == Path(tempfile.gettempdir()).resolve()
    (folder / "report-old.txt").write_text("wrong file", encoding="utf-8")
    (folder / "report.txt").write_text("correct file", encoding="utf-8")
    out["explorer_hidden_extension"] = {
        "visible_name": "report", "children": [p.name for p in folder.iterdir()],
        "resolved": Path(resolve_child_path(str(folder), "report")).name,
        "expected": "report.txt",
    }
    frozen = folder / "frozen.png"
    Image.new("RGB", (320, 200), "white").save(frozen)
    window = {"hwnd": 42, "pid": 7, "process_name": "demo.exe", "title": "Demo", "bbox": [0, 0, 320, 200]}
    gesture = {"schemaVersion": 2, "coordinateSpace": "physical_screen_pixels", "strokes": [{"points": [{"x": 100, "y": 60, "t": 0}, {"x": 220, "y": 140, "t": 50}]}], "bbox": {"x": 100, "y": 60, "width": 120, "height": 80}}
    lease = {
        "schemaVersion": 1, "frameLeaseId": "frame-audit", "epochId": "epoch-audit",
        "capturedAtMonotonicMs": 1250.5, "capturedAtUtc": "2026-09-20T00:00:00Z",
        "source": "gdi-fallback", "targetWindow": {"hwnd": 42, "processId": 7, "processName": "demo.exe", "title": "Demo"},
        "surfaceBoundsPx": [0, 0, 320, 200], "displayId": "1", "scaleFactor": 1,
        "gesture": gesture, "localArtifact": {"path": str(frozen), "mimeType": "image/png", "width": 320, "height": 200},
        "contentHash": "sha256:" + hashlib.sha256(frozen.read_bytes()).hexdigest(),
        "overlayExcluded": True, "captureLatencyMs": 1,
    }
    with patch("app.perception.pixel_ocr.prewarm_ocr_worker"), patch("scripts.selection_snapshot_bridge._annotate_frozen_surface", return_value=None), patch("scripts.selection_snapshot_bridge._prune_capture_dir", return_value=0):
        result = capture_snapshot([window], gesture=gesture, frame_lease=lease, target_point={"x": 160, "y": 100}, global_capture_bbox=(0, 0, 320, 200), default_capture_mode="deny")
    snapshot = result["selectionSnapshot"]
    out["frozen_policy_deny"] = {
        "status": snapshot["status"], "summary_has_visual": result["captureSummary"]["hasVisual"],
        "allow_local_pixels": snapshot["capture_policy"]["allowLocalPixels"],
        "capture_path_still_exported": bool(snapshot["capture_path"]),
        "context_adapter": (snapshot.get("context") or {}).get("adapter"),
        "frame_lease_still_exported": bool(snapshot["frame_lease"]),
    }
    pdf_data = {"ok": True, "hwnd": 42, "root_hwnd": 42, "process_id": 7,
                "text": "A valid selected PDF sentence", "result_kind": "text_selection", "page_number": 1,
                "page_rect": [0, 0, 300, 180], "rectangles": [[10, 10, 200, 20]]}
    pdf_window = {"hwnd": 42, "pid": 7, "class_name": "Chrome_WidgetWin_1", "title": "demo.pdf - Microsoft Edge"}
    with patch("app.adapters.uia_text_adapter._run_uia_selection_probe", return_value=UiaProbeResult(True, pdf_data)), patch("app.adapters.pdf_selection_recovery._local_pdf_path", return_value=folder / "demo.pdf"), patch.dict(sys.modules, {"fitz": SimpleNamespace()}):
        with patch("app.adapters.pdf_selection_recovery._foreground_window_handle", return_value=42), patch("app.adapters.pdf_selection_recovery._capture_screen", return_value=(Image.new("RGB", (320, 200)), (0, 0))) as capture, patch("app.adapters.pdf_selection_recovery.extend_highlight_rectangles", return_value=[]):
            result = UiaTextSelectionAdapter().read_context(pdf_window)
            out["pdf_hidden_live_capture"] = {"screen_capture_calls": capture.call_count, "error": result.artifacts.get("pdf_recovery_error")}
        with patch("app.adapters.pdf_selection_recovery._foreground_window_handle", return_value=99):
            result = UiaTextSelectionAdapter().read_context(pdf_window)
            out["pdf_stage_foreground"] = {"error": result.artifacts.get("pdf_recovery_error")}

long_text = "A" * 15000 + " NEEDLE " + "B" * 5000
js_prelude = """
globalThis.performance = {timeOrigin:123};
globalThis.location = {href:'https://example.test/'};
globalThis.window = {innerWidth:800,innerHeight:600,CSS:null};
globalThis.Element = class Element {};
const node = Object.assign(new Element(), {id:'long',nodeType:1,tagName:'PRE',parentElement:null,
  innerText:TEXT, textContent:TEXT, getAttribute:()=>null,
  getBoundingClientRect:()=>({x:0,y:0,width:800,height:2000,top:0,left:0,right:800,bottom:2000})});
globalThis.document = {title:'Long text',querySelectorAll:s=>s==='body *'||s==='#long'?[node]:[],querySelector:()=>null};
"""
def fake_dom_evaluate(instance, target, request):
    code = "const TEXT=" + json.dumps(long_text) + ";\n" + js_prelude + "\nconst read=" + BROWSER_DOCUMENT_READ_SCRIPT + ";\nprocess.stdout.write(JSON.stringify(read(" + json.dumps(request) + ")));"
    return json.loads(subprocess.run(["node", "-e", code], check=True, capture_output=True, text=True).stdout)
client = ChromeDevToolsDocumentClient(targets=lambda: [("audit-instance", {"id": "audit-tab"})], evaluate=fake_dom_evaluate)
source = SourceRef("source-audit", "task-audit", "web", "Long text", {"browserInstanceId": "audit-instance", "targetId": "audit-tab", "documentEpoch": "123:https://example.test/"}, {}, ("read", "search"), "user-pointed", None)
reader = BrowserContextReader(client)
for key, result in (("browser_long_document", reader.read(source, None, None, 20)), ("browser_long_search", reader.search(source, "NEEDLE", None, 20))):
    out[key] = {"original_chars": len(long_text), "returned_chars": [len(f.text) for f in result.fragments], "contains_query": any("NEEDLE" in f.text for f in result.fragments), "coverage": result.coverage.to_dict(), "status": result.evidence_status}
print(json.dumps(out, ensure_ascii=False, indent=2))
