from __future__ import annotations

from app.context_pack.runtime_document_smoke import verify_document_dependencies


def test_runtime_document_smoke_creates_and_reopens_all_supported_formats() -> None:
    result = verify_document_dependencies()

    assert result == {
        "pdf": "runtime pdf target",
        "docx": "runtime docx table target",
        "pptx": "runtime pptx target",
        "xlsx": "runtime xlsx target",
    }
