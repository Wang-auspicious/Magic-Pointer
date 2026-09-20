"""Production adapters with synthetic files/DOM; no application, OCR or model I/O."""
import hashlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from app.adapters import office_adapter as office
from app.adapters import uia_text_adapter as uia
from app.grounding.explorer_adapter import resolve_child_path
from scripts import selection_snapshot_bridge as snapshot


def test_excel_region_script_uses_actual_physical_coordinates(monkeypatch):
    scripts = []
    monkeypatch.setattr(office, "_run_powershell_json", lambda script: scripts.append(script) or office.OfficeProbeResult(False, {}, "intercepted"))
    office.OfficeAdapter().read_context({"hwnd": 42, "class_name": "XLMAIN"}, target_region={"x": 10, "y": 20, "width": 30, "height": 40})
    assert not any(token in scripts[0] for token in ("{region_x}", "{region_y}", "{region_w}", "{region_h}"))
    assert "$x1 = [int]10; $y1 = [int]20" in scripts[0]


def test_hidden_extension_exact_match_wins_over_prefix(tmp_path):
    for name in ("report-old.txt", "report.txt"): (tmp_path / name).write_text(name)
    assert Path(resolve_child_path(str(tmp_path), "report")).name == "report.txt"
    assert resolve_child_path(str(tmp_path), "repo") is None
    assert resolve_child_path(str(tmp_path), "repo…") is None
    assert Path(resolve_child_path(str(tmp_path), "report-o…")).name == "report-old.txt"


@pytest.mark.parametrize("mode", ["deny", "structured_only"])
def test_frozen_pixels_respect_capture_policy(tmp_path, monkeypatch, mode):
    frozen = tmp_path / "frozen.png"
    Image.new("RGB", (320, 200), "white").save(frozen)
    window = {"hwnd": 42, "pid": 7, "process_name": "demo.exe", "title": "Demo", "bbox": [0, 0, 320, 200]}
    gesture = {"schemaVersion": 2, "coordinateSpace": "physical_screen_pixels", "strokes": [{"points": [{"x": 100, "y": 60, "t": 0}, {"x": 220, "y": 140, "t": 50}]}], "bbox": {"x": 100, "y": 60, "width": 120, "height": 80}}
    lease = {"schemaVersion": 1, "frameLeaseId": "frame-audit", "epochId": "epoch-audit", "capturedAtMonotonicMs": 1250.5, "capturedAtUtc": "2026-09-20T00:00:00Z", "source": "gdi-fallback", "targetWindow": {"hwnd": 42, "processId": 7, "processName": "demo.exe", "title": "Demo"}, "surfaceBoundsPx": [0, 0, 320, 200], "displayId": "1", "scaleFactor": 1, "gesture": gesture, "localArtifact": {"path": str(frozen), "mimeType": "image/png", "width": 320, "height": 200}, "contentHash": "sha256:" + hashlib.sha256(frozen.read_bytes()).hexdigest(), "overlayExcluded": True, "captureLatencyMs": 1}
    monkeypatch.setattr("app.perception.pixel_ocr.prewarm_ocr_worker", lambda: None)
    monkeypatch.setattr(snapshot, "_prune_capture_dir", lambda *a, **k: 0)
    monkeypatch.setattr(snapshot, "_fuse_snapshot_perception", lambda *a, **k: (window, None, {}, None, None))
    monkeypatch.setattr(snapshot, "_annotate_frozen_surface", lambda *a: pytest.fail("denied pixels must not be annotated"))
    result = snapshot.capture_snapshot([window], gesture=gesture, frame_lease=lease, target_point={"x": 160, "y": 100}, global_capture_bbox=(0, 0, 320, 200), default_capture_mode=mode)["selectionSnapshot"]
    assert result["capture_path"] is None and result["frame_lease"] is None
    assert (result.get("context") or {}).get("adapter") != "screen_region"


def test_pdf_structured_read_never_recaptures_live_screen(monkeypatch):
    data = {"ok": True, "hwnd": 42, "root_hwnd": 42, "process_id": 7, "text": "Native selected sentence", "result_kind": "text_selection", "page_number": 1, "page_rect": [0, 0, 300, 180], "rectangles": [[10, 10, 200, 20]]}
    monkeypatch.setattr(uia, "_run_uia_selection_probe", lambda *a, **k: uia.UiaProbeResult(True, data))
    monkeypatch.setattr(uia, "recover_local_pdf_selection", lambda *a, **k: pytest.fail("no authorized frozen pixels supplied"))
    result = uia.UiaTextSelectionAdapter().read_context({"hwnd": 42, "pid": 7, "class_name": "Chrome_WidgetWin_1", "title": "demo.pdf - Edge"})
    assert result.content == "Native selected sentence"
    assert result.artifacts["pdf_visual_verification"] == "not_attempted_no_frozen_pixels"


def test_browser_long_node_is_fully_pageable_and_search_contains_match():
    from app.adapters.browser_devtools_adapter import BROWSER_DOCUMENT_READ_SCRIPT, ChromeDevToolsDocumentClient
    from app.context_pack.browser_reader import BrowserContextReader
    from app.context_pack.sources import SourceRef
    body = "A" * 15000 + " NEEDLE " + "B" * 5000
    prelude = """
globalThis.performance = {timeOrigin:123}; globalThis.location = {href:'https://example.test/'};
globalThis.window = {innerWidth:800,innerHeight:600,CSS:null}; globalThis.Element = class Element {};
const node = Object.assign(new Element(), {id:'long',nodeType:1,tagName:'PRE',parentElement:null,
innerText:TEXT,textContent:TEXT,getAttribute:()=>null,getBoundingClientRect:()=>({x:0,y:0,width:800,height:2000,top:0,left:0,right:800,bottom:2000})});
globalThis.document = {title:'Long',querySelectorAll:s=>s==='body *'||s==='#long'?[node]:[],querySelector:()=>null};
"""
    def evaluate(instance, target, request):
        code = "const TEXT=" + json.dumps(body) + ";" + prelude + "const read=" + BROWSER_DOCUMENT_READ_SCRIPT + ";process.stdout.write(JSON.stringify(read(" + json.dumps(request) + ")));"
        return json.loads(subprocess.run(["node", "-e", code], capture_output=True, text=True, check=True).stdout)
    client = ChromeDevToolsDocumentClient(targets=lambda: [("browser", {"id": "tab"})], evaluate=evaluate)
    source = SourceRef("source", "task", "web", "Long", {"browserInstanceId": "browser", "targetId": "tab", "documentEpoch": "123:https://example.test/"}, {}, ("read", "search"), "user-pointed", None)
    reader = BrowserContextReader(client)
    first = reader.read(source, None, None, 1)
    if first.coverage.next_cursor:
        second = reader.read(source, None, first.coverage.next_cursor, 1)
        assert first.fragments[0].text + second.fragments[0].text == body
        assert second.coverage.complete is True
    else:
        assert first.fragments[0].text == body
    found = reader.search(source, "NEEDLE", None, 20)
    assert any("NEEDLE" in fragment.text for fragment in found.fragments)
