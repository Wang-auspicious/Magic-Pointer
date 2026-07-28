from __future__ import annotations

import json
from pathlib import Path

from app.fabric.audit import AuditStore


def test_audit_redacts_content_and_keeps_operational_evidence(tmp_path: Path) -> None:
    store = AuditStore(tmp_path / "audit.jsonl")
    event = store.append(
        "recipe.executed",
        {
            "recipeId": "text.ocr_copy",
            "prompt": "my secret text",
            "content": "private screen",
            "screenshot": "C:/secret/image.png",
            "status": "succeeded",
            "durationMs": 42,
        },
    )
    assert event["data"]["prompt"] == "[redacted]"
    assert event["data"]["content"] == "[redacted]"
    assert event["data"]["screenshot"] == "[redacted]"
    assert event["data"]["status"] == "succeeded"
    stored = json.loads((tmp_path / "audit.jsonl").read_text(encoding="utf-8"))
    assert stored["eventId"] == event["eventId"]


def test_audit_redacts_nested_locations_and_window_titles(tmp_path: Path) -> None:
    store = AuditStore(tmp_path / "audit.jsonl")
    event = store.append(
        "recipe.planned",
        {
            "path": r"D:\private\customer.png",
            "cwd": r"D:\private\project",
            "project": r"D:\private",
            "title": "Customer contract.pdf",
            "attachments": [r"D:\private\customer.png"],
            "nested": {
                "artifact": r"D:\private\packet.json",
                "url": "https://example.test/private",
            },
            "planId": "plan-1",
        },
    )
    assert event["data"]["path"] == "[redacted]"
    assert event["data"]["cwd"] == "[redacted]"
    assert event["data"]["project"] == "[redacted]"
    assert event["data"]["title"] == "[redacted]"
    assert event["data"]["attachments"] == "[redacted]"
    assert event["data"]["nested"]["artifact"] == "[redacted]"
    assert event["data"]["nested"]["url"] == "[redacted]"
    assert event["data"]["planId"] == "plan-1"


def test_audit_tail_is_bounded_and_corrupt_lines_are_ignored(tmp_path: Path) -> None:
    path = tmp_path / "audit.jsonl"
    store = AuditStore(path)
    for index in range(5):
        store.append("activation", {"index": index})
    with path.open("a", encoding="utf-8") as handle:
        handle.write("{bad\n")
    tail = store.tail(limit=2)
    assert [item["data"]["index"] for item in tail] == [3, 4]
