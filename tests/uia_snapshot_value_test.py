from app.desktop_actions import uia


def test_snapshot_keeps_control_value_separate_from_accessible_name():
    rows = uia.normalize_elements([{
        "name": "Message", "value": "written text", "control_type": 50004,
        "patterns": ["Value"], "rect": [0, 0, 100, 40],
    }])
    assert rows[0]["name"] == "Message"
    assert rows[0]["value"] == "written text"


def test_native_dump_reads_current_value_and_releases_its_pattern(monkeypatch):
    released = []
    monkeypatch.setattr(uia, "_has_pattern", lambda element, pattern: pattern == 10002)
    monkeypatch.setattr(uia, "_runtime_id", lambda element: [42, 2])
    monkeypatch.setattr(uia, "_bstr", lambda *args: "Message")
    monkeypatch.setattr(uia, "_control_type", lambda element: 50004)
    monkeypatch.setattr(uia, "_rect_of", lambda element: [0, 0, 100, 40])
    monkeypatch.setattr(uia, "_release", released.append)

    def read_value(element, held):
        held.append(99)
        return True, "", "written text"

    monkeypatch.setattr(uia, "_read_value", read_value)
    node = uia._dump_element(7, 42)
    assert node["value"] == "written text"
    assert released == [99]
