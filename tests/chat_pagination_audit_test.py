from app.context_pack.chat_reader import ChatReader
from app.context_pack.sources import SourceRef


IDENTITY = {"adapterId": "chat-test", "conversationKey": "bound-chat"}
SOURCE = SourceRef("source:chat", "task-chat", "chat", "Chat",
                   {"conversationIdentity": IDENTITY}, {}, ("read", "search"),
                   "user-pointed", None)


class ViewportBackend:
    def __init__(self):
        self.calls = []

    def read_chat_page(self, **request):
        self.calls.append(request)
        return {
            "conversationIdentity": IDENTITY,
            "messages": [{"nativeMessageId": f"id-{i}", "text": f"match {i}"} for i in range(5)],
            "complete": True, "nextCursor": None,
        }


def test_chat_search_pages_all_acquired_matches_without_rescrolling():
    backend = ViewportBackend()
    reader = ChatReader(backend)
    first = reader.search(SOURCE, "match", None, 2)
    assert not first.coverage.complete
    assert first.coverage.next_cursor
    second = reader.search(SOURCE, "match", first.coverage.next_cursor, 2)
    third = reader.search(SOURCE, "match", second.coverage.next_cursor, 2)
    assert [f.text for page in (first, second, third) for f in page.fragments] == [f"match {i}" for i in range(5)]
    assert third.coverage.complete
    assert third.coverage.next_cursor is None
    assert len(backend.calls) == 1


def test_chat_read_does_not_discard_remainder_of_a_visible_page():
    backend = ViewportBackend()
    reader = ChatReader(backend)
    first = reader.read(SOURCE, None, None, 1)
    assert not first.coverage.complete
    rest = reader.read(SOURCE, None, first.coverage.next_cursor, 10)
    assert [f.text for f in rest.fragments] == [f"match {i}" for i in range(1, 5)]
    assert rest.coverage.complete
    assert len(backend.calls) == 1


def test_chat_cached_search_cursor_cannot_be_reused_for_another_query():
    reader = ChatReader(ViewportBackend())
    first = reader.search(SOURCE, "match", None, 2)
    assert first.coverage.next_cursor
    wrong = reader.search(SOURCE, "another query", first.coverage.next_cursor, 2)
    assert wrong.evidence_status == "error"
    assert not wrong.fragments


def test_task_chat_reads_are_serialized_because_they_may_scroll(tmp_path):
    from app.agent_runtime.session import FileSessionStore
    from app.agent_runtime.tool_registry import ToolRegistry
    from app.context_pack.source_store import register_source
    from app.context_pack.sources import SourceReaderRegistry
    from app.context_pack.tools import register_context_tools

    session = FileSessionStore(tmp_path).open_or_create(SOURCE.task_id)
    register_source(session, SOURCE)
    document = SourceRef("source:doc", SOURCE.task_id, "document", "Doc", {}, {},
                         ("read", "search"), "user-attached", None)
    register_source(session, document)
    registry = ToolRegistry()
    register_context_tools(registry, session=session, readers=SourceReaderRegistry())
    assert not registry.is_concurrency_safe_for("Context.read", {"source_id": SOURCE.source_id})
    assert not registry.is_concurrency_safe_for("Context.search", {"query": "match"})
    assert registry.is_concurrency_safe_for("Context.read", {"source_id": document.source_id})
    assert registry.is_concurrency_safe_for("Context.search", {"source_ids": [document.source_id], "query": "match"})
