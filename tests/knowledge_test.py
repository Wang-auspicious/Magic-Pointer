from __future__ import annotations

import json
from pathlib import Path

from app.context_pack.knowledge import KnowledgeCatalog


def _write_index(path: Path, artifact: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([
        {
            "id": "stash-quote",
            "capturedAt": 1_770_000_000_000,
            "sourceTimeMs": 1_769_999_000_000,
            "sourceId": "source:quote-pdf",
            "locator": {"kind": "pdf-region", "value": {"page": 2}},
            "originalArtifactPath": str(artifact),
            "relPath": artifact.name,
            "summary": "含税报价为 18 万元",
            "userCategory": "报价",
            "desc": "供应商报价",
            "text": "",
            "media": "file",
        },
        {
            "id": "stash-note",
            "capturedAt": 1_770_000_100_000,
            "sourceId": "source:note",
            "locator": {"kind": "text", "value": {"line": 1}},
            "relPath": "note.txt",
            "summary": "交付前复核税率",
            "userCategory": "待办",
            "desc": "复核税率",
            "text": "交付前复核税率",
            "media": "text",
        },
    ], ensure_ascii=False), encoding="utf-8")


def test_knowledge_search_resolve_and_delete_preserve_the_authoritative_source(tmp_path: Path) -> None:
    artifact = tmp_path / "quote.pdf"
    artifact.write_bytes(b"%PDF-real-source")
    (tmp_path / "note.txt").write_text("交付前复核税率", encoding="utf-8")
    index = tmp_path / "index.json"
    _write_index(index, artifact)
    catalog = KnowledgeCatalog(index)

    matches = catalog.search("18 万", category="报价")
    assert [entry.entry_id for entry in matches] == ["stash-quote"]
    assert matches[0].summary == "含税报价为 18 万元"

    resolved = catalog.resolve("stash-quote", task_id="task-daily-wrap")
    assert resolved.available is True
    assert resolved.source.source_id == "source:quote-pdf"
    assert resolved.source.task_id == "task-daily-wrap"
    assert resolved.source.identity["absolutePath"] == str(artifact)
    assert resolved.locator.to_dict() == {"kind": "pdf-region", "value": {"page": 2}}

    assert catalog.remove("stash-quote") is True
    assert catalog.search("18 万") == []
    assert catalog.availability(resolved.source) == {
        "available": False,
        "reason": "knowledge_entry_deleted",
    }
    assert artifact.exists(), "删除收藏只删派生索引/副本，不能删除权威原文件"


def test_knowledge_missing_artifact_is_reported_instead_of_returning_stale_material(tmp_path: Path) -> None:
    missing = tmp_path / "missing.pdf"
    index = tmp_path / "index.json"
    _write_index(index, missing)
    catalog = KnowledgeCatalog(index)

    resolved = catalog.resolve("stash-quote", task_id="task-missing")
    assert resolved.available is False
    assert resolved.unavailable_reason == "artifact_missing"
