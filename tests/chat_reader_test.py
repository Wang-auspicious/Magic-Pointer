from __future__ import annotations

import copy
import json
from pathlib import Path

from app.context_pack.chat_reader import ChatReader
from app.context_pack.sources import SourceRef

FIXTURE = Path(__file__).parent / "fixtures" / "chat" / "two_page_conversation.json"


class _FixtureChatBackend:
    def __init__(self, *, switch_on_second_page: bool = False) -> None:
        self.payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.switch_on_second_page = switch_on_second_page
        self.calls: list[dict] = []

    def read_chat_page(self, **request):
        self.calls.append(dict(request))
        cursor = request.get("cursor")
        page = next(item for item in self.payload["pages"] if item["cursor"] == cursor)
        response = copy.deepcopy(page)
        response["conversationIdentity"] = copy.deepcopy(self.payload["conversation"])
        response["usedBackend"] = "fixture.public-chat-surface"
        if self.switch_on_second_page and cursor == "page-2":
            response["conversationIdentity"].update({
                "conversationKey": "workspace-a:other-group-99",
                "nativeConversationId": "other-group-99",
                "title": "Same visible title is not identity",
            })
            response["messages"] = [{
                "nativeMessageId": "intruder-1",
                "speaker": "Wrong group",
                "time": "2026-08-19T09:14:00+08:00",
                "text": "THIS MUST NEVER ENTER THE RESULT",
            }]
        return response


def _source() -> SourceRef:
    identity = json.loads(FIXTURE.read_text(encoding="utf-8"))["conversation"]
    return SourceRef(
        source_id="source:chat:north-launch",
        task_id="task-chat-reader",
        kind="chat",
        title="North launch",
        identity={"conversationIdentity": identity},
        revision={"boundAt": "2026-08-19T09:15:00+08:00"},
        capabilities=("read", "search", "follow"),
        origin="user-pointed",
        parent_source_id=None,
    )


def test_two_page_read_preserves_order_authors_duplicates_attachments_and_coverage() -> None:
    backend = _FixtureChatBackend()
    reader = ChatReader(backend)

    result = reader.read(_source(), None, None, 20)

    assert [fragment.text for fragment in result.fragments] == [
        "旧报价暂按 18 万元，等待财务确认。",
        "好的",
        "好的",
        "请以财务后续确认作为最终口径。",
        "财务确认版见附件，旧报价作废。",
        "FINAL POLICY：最终金额是 16.8 万元，按这个数字回复。",
    ]
    assert [fragment.metadata["speaker"] for fragment in result.fragments][-2:] == [
        "Mina",
        "Mina",
    ]
    assert [fragment.text for fragment in result.fragments].count("好的") == 2
    attachments = [
        attachment
        for fragment in result.fragments
        for attachment in fragment.metadata["attachments"]
    ]
    assert [(item["name"], item["nativeAttachmentId"]) for item in attachments] == [
        ("报价单.pdf", "att-price-v1"),
        ("报价单.pdf", "att-price-v2"),
    ]
    assert result.coverage.complete is True
    assert result.coverage.next_cursor is None
    assert result.coverage.total_units == 6
    assert result.evidence_status == "ok"
    assert result.used_backend == "fixture.public-chat-surface"
    assert [call["cursor"] for call in backend.calls] == [None, "page-2"]


def test_search_reaches_offscreen_later_correction_and_keeps_reply_relation() -> None:
    reader = ChatReader(_FixtureChatBackend())

    result = reader.search(_source(), "FINAL POLICY", None, 5)

    assert [fragment.text for fragment in result.fragments] == [
        "FINAL POLICY：最终金额是 16.8 万元，按这个数字回复。"
    ]
    assert result.fragments[0].metadata["speaker"] == "Mina"
    assert result.fragments[0].metadata["replyTo"] == "msg-104"
    assert result.fragments[0].locator.value["nativeMessageId"] == "msg-105"
    assert result.coverage.complete is True
    assert len(result.coverage.read_ranges) == 2


def test_follow_discovers_two_same_name_attachment_versions_as_distinct_child_sources() -> None:
    reader = ChatReader(_FixtureChatBackend())
    result = reader.read(_source(), None, None, 20)
    attachment_messages = [
        fragment for fragment in result.fragments if fragment.metadata["attachments"]
    ]

    first = reader.follow(_source(), attachment_messages[0].fragment_id)
    second = reader.follow(_source(), attachment_messages[1].fragment_id)

    assert first[0].title == second[0].title == "报价单.pdf"
    assert first[0].source_id != second[0].source_id
    assert first[0].identity["nativeAttachmentId"] == "att-price-v1"
    assert second[0].identity["nativeAttachmentId"] == "att-price-v2"
    assert first[0].parent_source_id == second[0].parent_source_id == _source().source_id
    assert first[0].origin == second[0].origin == "task-discovered"


def test_conversation_switch_aborts_before_mixing_another_groups_messages() -> None:
    reader = ChatReader(_FixtureChatBackend(switch_on_second_page=True))

    result = reader.read(_source(), None, None, 20)

    assert all("THIS MUST NEVER" not in fragment.text for fragment in result.fragments)
    assert [fragment.text for fragment in result.fragments][-1] == "请以财务后续确认作为最终口径。"
    assert result.coverage.complete is False
    assert result.coverage.next_cursor == "page-2"
    assert result.coverage.missing_reason == "conversation-identity-changed"
    assert result.evidence_status == "degraded"


def test_idless_adjacent_page_overlap_does_not_collapse_real_duplicate_replies() -> None:
    identity = json.loads(FIXTURE.read_text(encoding="utf-8"))["conversation"]

    class IdlessBackend:
        def read_chat_page(self, **request):
            if request["cursor"] is None:
                return {
                    "conversationIdentity": identity,
                    "messages": [
                        {"speaker": "Ada", "time": "09:01", "text": "好的"},
                        {"speaker": "Ada", "time": "09:01", "text": "好的"},
                        {"speaker": "Lin", "time": "09:02", "text": "等待确认"},
                    ],
                    "nextCursor": "next",
                    "complete": False,
                    "usedBackend": "fixture.idless",
                }
            return {
                "conversationIdentity": identity,
                "messages": [
                    {"speaker": "Lin", "time": "09:02", "text": "等待确认"},
                    {"speaker": "Mina", "time": "09:03", "text": "已确认"},
                ],
                "nextCursor": None,
                "complete": True,
                "usedBackend": "fixture.idless",
            }

    result = ChatReader(IdlessBackend()).read(_source(), None, None, 20)

    assert [fragment.text for fragment in result.fragments] == [
        "好的", "好的", "等待确认", "已确认",
    ]
    assert result.coverage.read_ranges[1]["overlapMessages"] == 1
    assert all(
        fragment.metadata["nativeMessageId"] is None
        for fragment in result.fragments
    )
