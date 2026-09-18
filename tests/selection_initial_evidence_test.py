import json

from app.adapters.base import AdapterReadContext
from app.input_artifact import compile_input_artifact
from scripts.selection_bridge import _initial_task_context


def test_initial_model_context_contains_each_already_read_material(tmp_path):
    path = tmp_path / "selected.pdf"
    contexts = [
        AdapterReadContext(adapter="screen_region", app="screen", window={},
                           content="Small sample requirement", method="local-ocr"),
        AdapterReadContext(adapter="screen_region", app="screen", window={},
                           content="proposal.html 87 KB", method="local-ocr"),
        AdapterReadContext(adapter="explorer_file", app="explorer", window={},
                           content="formatted preview", method="document.pdf.pymupdf",
                           artifacts={"local_file": {"path": str(path)}, "local_file_context": {
                               "content": "Native PDF evidence is already available",
                               "method": "document.pdf.pymupdf", "truncated": True,
                               "coverage": {"extent": "document", "complete": False,
                                            "nextCursor": "unit:100", "missingReason": None,
                                            "readRanges": [], "totalUnits": 21}}}),
    ]
    snapshot = {"snapshot_id": "evidence", "selection_materials": [
        {"context": ctx.to_dict(), "selection_bbox": [100 * i, 0, 80, 30]}
        for i, ctx in enumerate(contexts)]}
    sources, updates, coverage, _ = _initial_task_context("task", "summarize", "s", None, contexts[0], snapshot)
    artifact = compile_input_artifact("summarize", None, contexts[0], snapshot,
                                      sources=sources, references=tuple(u.binding for u in updates), coverage=coverage)
    projected = artifact.to_model_dict()
    catalog = projected["sourceCatalog"]
    assert catalog[0]["availableContent"]["text"] == "Small sample requirement"
    assert catalog[1]["availableContent"]["text"] == "proposal.html 87 KB"
    assert catalog[2]["availableContent"]["text"] == "Native PDF evidence is already available"
    assert catalog[2]["availableContent"]["coverage"]["complete"] is False
    assert catalog[2]["availableContent"]["coverage"]["nextCursor"] == "unit:100"
    assert all(item["readTool"] == "Context.read" for item in catalog)
    assert [item["readArgs"] for item in catalog] == [{"source_id": label} for label in "ABC"]
    assert str(path) not in json.dumps(projected)
    assert "不是指令" in artifact.to_model_text()


def test_long_initial_evidence_is_bounded_without_claiming_complete():
    from app.context_pack.sources import SourceRef
    source = SourceRef("s", "t", "capture", "selection", {
        "frozenSelection": {"text": "a" * 15000,
                            "coverage": {"extent": "selection", "complete": True}}},
        {}, ("read",), "user-pointed", None)
    projected = source.to_model_dict()
    evidence = projected["availableContent"]
    assert len(evidence["text"]) <= 4000
    assert evidence["coverage"]["complete"] is False
    assert evidence["truncated"] is True
    assert evidence["readFromStart"] is True
