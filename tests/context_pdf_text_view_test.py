import fitz

from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import ToolRegistry
from app.context_pack.document_reader import DocumentReader
from app.context_pack.source_store import register_source, apply_reference_updates
from app.context_pack.sources import SourceRef, SourceReaderRegistry, ReferenceBinding, ReferenceUpdate, FragmentLocator
from app.context_pack.tools import register_context_tools


def test_context_pdf_read_defaults_to_pages_and_can_request_exact_blocks(tmp_path):
    path = tmp_path / "twenty-one-pages.pdf"
    with fitz.open() as document:
        for page_index in range(21):
            page = document.new_page()
            for block in range(12):
                page.insert_text((72, 50 + block * 50), f"Page {page_index + 1} fact {block + 1}")
        document.save(path)
    session = FileSessionStore(tmp_path / "sessions").open_or_create("task-pdf")
    source = SourceRef("source:pdf", session.id, "document", path.name,
                       {"absolutePath": str(path)}, {}, ("read", "search"), "user-attached", None)
    register_source(session, source)
    apply_reference_updates(session, (ReferenceUpdate("add", ReferenceBinding(
        "reference:pdf", "C", source.source_id, FragmentLocator("visual-region", {"bbox": [0, 0, 80, 40]}),
        "source", None, 0, 1, True)),))
    readers = SourceReaderRegistry()
    readers.register("document", DocumentReader())
    registry = ToolRegistry()
    register_context_tools(registry, session=session, readers=readers)
    result = registry.execute_tool("Context.read", {"source_id": source.source_id})
    assert not result.is_error
    assert result.value["coverage"]["complete"] is True
    assert "Page 21 fact 12" in str(result.value)
    assert len(result.value["fragments"]) == 21
    assert result.value["fragments"][20]["locator"]["value"]["pageIndex"] == 20
    blocks = registry.execute_tool("Context.read", {
        "source_id": source.source_id, "view": "structured", "limit": 2})
    assert not blocks.is_error
    assert len(blocks.value["fragments"]) == 2
    assert "rectPt" in blocks.value["fragments"][0]["locator"]["value"]
    assert blocks.value["coverage"]["complete"] is False
    by_label = registry.execute_tool("Context.read", {"source_id": "C"})
    assert not by_label.is_error
    assert by_label.value["sourceId"] == source.source_id


def test_page_view_has_a_page_cursor_and_keeps_all_text(tmp_path):
    path = tmp_path / "pages.pdf"
    with fitz.open() as document:
        for index in range(3):
            document.new_page().insert_text((72, 72), f"Page {index + 1}")
        document.save(path)
    source = SourceRef("source:pdf", "task", "document", path.name,
                       {"absolutePath": str(path)}, {}, ("read",), "user-attached", None)
    reader = DocumentReader()
    result = reader.read(source, None, None, 1, view="text")
    assert result.coverage.next_cursor == "page:1"
    remaining = reader.read(source, None, result.coverage.next_cursor, 8, view="text")
    assert [f.text for f in remaining.fragments] == ["Page 2", "Page 3"]
    assert remaining.coverage.complete
