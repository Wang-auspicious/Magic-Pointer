
import io
import json

from scripts import selection_bridge


def test_three_material_snapshot_is_not_rejected_as_a_large_user_selection(monkeypatch):
    materials = []
    for index, name in enumerate(("Weixin.exe", "Weixin.exe", "explorer.exe")):
        materials.append({
            "stroke_index": index,
            "source_window": {"hwnd": index + 1, "process_name": name},
            "context": {"content": "selected material", "artifacts": {
                "region_elements": [{"text": f"visible row {row}: " + "This is a selected paragraph. " * 18, "rect": [100, row * 20, 500, 20],
                                     "control_type": "Text", "runtime_id": [42, index, row]}
                                    for row in range(40)],
            }},
        })
    payload = {"command": "基于这些信息，总结200字讲清楚你推荐的最合适选题。",
               "selectionSnapshot": {"selection_materials": materials}}
    raw = json.dumps(payload, ensure_ascii=False).encode("utf8")
    assert 64 * 1024 < len(raw) < 256 * 1024
    monkeypatch.setattr(selection_bridge.sys, "stdin", io.TextIOWrapper(io.BytesIO(raw), encoding="utf8"))
    assert selection_bridge.read_payload() == payload
