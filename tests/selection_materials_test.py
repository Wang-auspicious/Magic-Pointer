from pathlib import Path

from app.adapters.base import AdapterReadContext
from app.grounding.explorer_adapter import ExplorerFileGrounder, ExplorerItem, is_explorer_window
from app.grounding.schema import PointerSelection
from scripts import selection_bridge as command
from scripts import selection_snapshot_bridge as capture


def test_window_ownership_is_captured_before_slow_structure(monkeypatch, tmp_path):
    import hashlib
    from PIL import Image
    windows = [
        {"hwnd": 31, "pid": 4242, "title": "chat", "process_name": "chat.exe", "bbox": [600, 0, 1200, 900]},
        {"hwnd": 20, "pid": 9, "title": "Desktop", "class_name": "Progman", "bbox": [0, 0, 2800, 1700]},
    ]
    live = list(windows)
    monkeypatch.setattr(capture, "list_visible_windows", lambda: list(live))
    monkeypatch.setattr(capture, "get_foreground_window_handle", lambda: 31)
    monkeypatch.setattr(capture, "_desktop_window", lambda: windows[1])
    gesture = {"schemaVersion": 2, "coordinateSpace": "physical_screen_pixels", "strokes": [
        {"points": [{"x": 700, "y": 600}, {"x": 800, "y": 620}]},
        {"points": [{"x": 100, "y": 700}, {"x": 160, "y": 740}]},
    ]}
    gesture = capture._normalized_gesture(gesture)
    def read(wins, **kwargs):
        # The user starts typing after capture; the IME now covers a mark.
        live[:] = [{"hwnd": 99, "pid": 50, "title": "IME", "bbox": [0, 0, 2800, 1700]}, *windows]
        return wins[0] if wins else None, None, {}, None, None
    monkeypatch.setattr(capture, "_fuse_snapshot_perception", read)
    frame = tmp_path / "frame.png"
    Image.new("RGB", (2800, 1700), "white").save(frame)
    lease = {"schemaVersion": 1, "frameLeaseId": "frame-materials", "epochId": "epoch-materials",
             "capturedAtMonotonicMs": 1, "capturedAtUtc": "2026-09-19T05:32:08.000Z", "source": "gdi-fallback",
             "targetWindow": {"hwnd": 31, "processId": 4242, "title": "chat", "processName": "chat.exe"},
             "surfaceBoundsPx": [0, 0, 2800, 1700], "displayId": "display-1", "scaleFactor": 1,
             "gesture": gesture, "localArtifact": {"path": str(frame), "mimeType": "image/png", "width": 2800, "height": 1700},
             "contentHash": "sha256:" + hashlib.sha256(frame.read_bytes()).hexdigest(), "overlayExcluded": True, "captureLatencyMs": 0}
    result = capture.capture_snapshot(gesture=gesture, target_hwnd=31, frame_lease=lease,
                                      identity_probe=lambda: windows[0])
    assert result.get("ok"), result
    assert [m["source_window"]["hwnd"] for m in result["selectionSnapshot"]["selection_materials"]] == [31, 20]


def test_three_strokes_keep_their_own_windows_and_file_source(monkeypatch, tmp_path: Path):
    pdf = tmp_path / "selected.pdf"
    pdf.write_bytes(b"%PDF-1.7")
    windows = [
        {"hwnd": 10, "title": "微信", "process_name": "Weixin.exe", "bbox": [600, 0, 1200, 900]},
        {"hwnd": 20, "title": "Desktop", "process_name": "explorer.exe", "class_name": "Progman", "bbox": [0, 0, 1200, 900]},
    ]
    strokes = [{"points": [{"x": x, "y": y}, {"x": x + 80, "y": y + 50}]} for x, y in [(700, 600), (900, 300), (100, 700)]]
    def fuse(wins, **kwargs):
        win = wins[0]
        file = win["hwnd"] == 20
        ctx = AdapterReadContext(adapter="explorer_file" if file else "wechat", app="explorer" if file else "wechat", window=win,
            content=str(pdf) if file else "selected message", label=pdf.name if file else "微信", method="test",
            artifacts={"local_file": {"path": str(pdf)}} if file else {})
        box = kwargs["gesture"]["bbox"]
        return win, ctx, {}, None, [box[k] for k in ("x", "y", "width", "height")]
    monkeypatch.setattr(capture, "_fuse_snapshot_perception", fuse)
    materials = capture._capture_stroke_materials(windows, {"strokes": strokes}, registry=None)
    assert [m["source_window"]["hwnd"] for m in materials] == [10, 10, 20]
    snapshot = {"snapshot_id": "selection-multi", "captured_at": "2026-09-18T05:00:00+00:00",
                "selection_gesture": {"strokes": strokes}, "selection_materials": materials}
    sources, refs, coverage, task_input = command._initial_task_context("task-multi", "汇总", "s", windows[0], None, snapshot)
    assert len(sources) == 3
    assert sources[2].kind == "document"
    assert sources[2].identity["absolutePath"] == str(pdf.resolve())
    assert [r.binding.source_id for r in refs] == [s.source_id for s in sources]
    assert [r.binding.reference_id for r in refs] == [f"reference:selection-multi:{i}" for i in range(3)]
    assert task_input.source_ids == tuple(s.source_id for s in sources)
    resolver = command._frozen_reference_resolver(refs, snapshot)
    assert resolver(refs[2].binding.reference_id) == (100, 700, 180, 750)


def test_desktop_uia_file_uses_known_desktop_folder(monkeypatch, tmp_path):
    import app.grounding.explorer_adapter as explorer
    pdf = tmp_path / "selected.pdf"
    pdf.write_bytes(b"%PDF-1.7")
    window = {"hwnd": 20, "class_name": "Progman", "title": "Program Manager", "process_name": "explorer.exe"}
    assert is_explorer_window(window)
    monkeypatch.setattr(explorer, "desktop_directories", lambda: (str(tmp_path),))
    grounder = ExplorerFileGrounder()
    monkeypatch.setattr(grounder, "_read_shell_window", lambda hwnd: (None, [], []))
    monkeypatch.setattr(grounder, "_read_uia_items", lambda *args: ([ExplorerItem("selected.pdf", bbox=(100, 100, 180, 170))], []))
    monkeypatch.setattr(grounder, "_read_powershell_explorer_state", lambda hwnd: (None, [], [], []))
    result = grounder.ground(PointerSelection(id="pick", point=(140, 140), bbox=(90, 90, 190, 180), selected_at="now", source="gesture"), windows=[window])
    assert result.primary.metadata["path"] == str(pdf)


def test_saved_frozen_material_is_readable_after_reopening_task():
    from app.context_pack.sources import SourceReaderRegistry, SourceRef
    context = AdapterReadContext(adapter="screen_region", app="screen", window={}, content="The selected sentence.", label="selection", method="local-ocr")
    sources, refs, _, _ = command._initial_task_context("task", "summarize", "s", None, context,
        {"snapshot_id": "pick", "selection_bbox": [10, 20, 100, 40]})
    restored = SourceRef.from_dict(sources[0].to_dict())
    result = SourceReaderRegistry().for_source(restored).read(restored, refs[0].binding.locator, None, 8)
    assert result.fragments[0].text == "The selected sentence."
    assert result.evidence_status == "ok"
