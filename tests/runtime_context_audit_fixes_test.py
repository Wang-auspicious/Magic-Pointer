"""RT14–RT18 data preservation regressions, no models or network."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from openpyxl import Workbook
from app.agent_runtime.memory import compact_messages
from app.agent_runtime.types import AgentMessage, Role
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import ToolRegistry
from app.context_pack.chat_reader import ChatReader, _adjacent_overlap
from app.context_pack.document_reader import DocumentReader
from app.context_pack.sources import SourceRef, FragmentLocator, SourceReaderRegistry
from app.context_pack.source_store import register_source
from app.context_pack.tools import register_context_tools


def source(path, kind='file'):
    return SourceRef('source:audit', 'task-audit', kind, path.name,
                     {'absolutePath': str(path)}, {}, ('read', 'search', 'follow'), 'user-attached', None)


def test_compaction_sends_all_history_in_bounded_batches():
    messages = [AgentMessage(Role.USER, f'MARKER_{i:02d} ' + 'x' * 18000, None, None) for i in range(12)]
    received = []
    def summarize(text):
        received.append(text)
        return 'summary'
    compacted = compact_messages(messages, summarize, force=True)
    assert len(compacted) < len(messages)
    assert max(map(len, received)) <= 48000
    for i in range(12):
        assert f'MARKER_{i:02d}' in ''.join(received)


def test_failed_compaction_batch_preserves_all_messages():
    messages = [AgentMessage(Role.USER, f'{i} ' + 'x' * 18000, None, None) for i in range(8)]
    calls = []
    def summarize(text):
        calls.append(text)
        return 'summary' if len(calls) == 1 else ''
    assert compact_messages(messages, summarize, force=True) == messages


def test_compaction_preserves_long_tool_arguments():
    from app.agent_runtime.memory import _compaction_source_line
    message = AgentMessage(Role.ASSISTANT, '', None, None, tool_calls=({'id': 'write', 'name': 'Write', 'arguments': {'content': 'x' * 13000 + 'LAST_ARGUMENT_FACT'}},))
    assert 'LAST_ARGUMENT_FACT' in _compaction_source_line(message)


def test_native_message_ids_prevent_false_overlap():
    a = {'nativeMessageId': 'old', 'speaker': 'A', 'time': '10:01', 'text': 'okay'}
    b = {**a, 'nativeMessageId': 'new'}
    assert _adjacent_overlap([a], [b]) == 0
    assert _adjacent_overlap([a], [a]) == 1


def test_excel_range_reads_matching_cells(tmp_path):
    path = tmp_path / 'data.xlsx'
    book = Workbook()
    book.active.title = 'Sheet1'
    book.active['A1'] = 'outside'
    book.active['B2'] = 'chosen1'
    book.active['C3'] = 'chosen2'
    book.save(path)
    result = DocumentReader().read(source(path), FragmentLocator('cell-range', {
        'workbook': str(path), 'sheet': 'Sheet1', 'range': '$B$2:$C$3'}), None, 10)
    texts = [item.text for item in result.fragments]
    assert any('chosen1' in text for text in texts)
    assert any('chosen2' in text for text in texts)


def test_url_only_attachment_is_explicitly_unresolved():
    from chat_reader_test import _FixtureChatBackend, _source
    backend = _FixtureChatBackend()
    for page in backend.payload['pages']:
        for message in page['messages']:
            for attachment in message.get('attachments', []):
                attachment.pop('absolutePath', None)
                attachment['url'] = 'https://example.test/file.pdf'
    reader = ChatReader(backend)
    result = reader.read(_source(), None, None, 20)
    fragment = next(item for item in result.fragments if item.metadata['attachments'])
    attached = reader.follow(_source(), fragment.fragment_id)[0]
    assert 'read' not in attached.capabilities
    assert attached.identity['downloadState'] == 'requires-download'


def test_search_reader_failures_are_tool_errors(tmp_path):
    session = FileSessionStore(tmp_path / 'sessions').open_or_create('task-audit')
    missing = source(tmp_path / 'missing.txt')
    register_source(session, missing)
    readers = SourceReaderRegistry()
    readers.register('file', DocumentReader())
    tools = ToolRegistry()
    register_context_tools(tools, session=session, readers=readers)
    result = tools.execute_tool('Context.search', {'query': 'contract'})
    assert result.is_error
    assert 'evidenceStatus' in result.error_message
