from dataclasses import replace

import fitz

from app.context_pack.document_reader import DocumentReader
from app.context_pack.sources import SourceRef


def source_for(path):
    return SourceRef("source:doc", "task:read", "document", path.name,
                     {"absolutePath": str(path)}, {"capturedAt": "first"},
                     ("read", "search"), "user-attached", None)


def test_read_search_and_describe_reuse_one_native_parse(tmp_path, monkeypatch):
    path = tmp_path / "material.pdf"
    with fitz.open() as document:
        for index in range(3):
            page = document.new_page()
            page.insert_text((72, 72), f"Evidence from page {index + 1}")
        document.save(path)
    source = source_for(path)
    reader = DocumentReader()
    original = reader._parse_pdf
    calls = []

    def parse(path):
        calls.append(path)
        return original(path)

    monkeypatch.setattr(reader, "_parse_pdf", parse)
    first = reader.read(source, None, None, 1)
    second = reader.read(source, None, first.coverage.next_cursor, 1)
    found = reader.search(source, "page 3", None, 8)
    description = reader.describe(source)
    assert first.fragments[0].text == "Evidence from page 1"
    assert second.fragments[0].text == "Evidence from page 2"
    assert found.fragments and description.fragments
    assert len(calls) == 1


def test_reader_observes_file_edits_and_source_revision(tmp_path):
    path = tmp_path / "material.txt"
    path.write_text("Before", encoding="utf-8")
    source = source_for(path)
    reader = DocumentReader()
    assert reader.read(source, None, None, 8).fragments[0].text == "Before"
    path.write_text("After an actual document edit", encoding="utf-8")
    updated = replace(source, revision={"capturedAt": "second"})
    result = reader.read(updated, None, None, 8)
    assert result.fragments[0].text == "After an actual document edit"
    assert result.fragments[0].metadata["sourceRevision"] == updated.revision
    path.unlink()
    assert reader.read(updated, None, None, 8).evidence_status == "error"


def test_preview_cursor_does_not_skip_the_remainder_of_a_fragment(tmp_path):
    path = tmp_path / "material.txt"
    path.write_text("Opening " + "evidence " * 90 + "DECISIVE CONCLUSION", encoding="utf-8")
    source = source_for(path)
    reader = DocumentReader()
    preview = reader.preview(source, max_chars=80)
    assert "DECISIVE CONCLUSION" not in preview.fragments[0].text
    continued = reader.read(source, None, preview.coverage.next_cursor, 8)
    assert "DECISIVE CONCLUSION" in "\n".join(f.text for f in continued.fragments)
