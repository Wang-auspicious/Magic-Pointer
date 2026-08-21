"""Replay-history sanitization for crash resume (Hermes replay_cleanup, MIT).

A killed turn can leave an unanswered assistant(tool_calls) in the durable
transcript. Repair fills the open turn; this module is the model-facing extra
pass so a leftover tail cannot be re-issued as an infinite tool loop.
"""

from __future__ import annotations

from app.agent_runtime.replay_cleanup import sanitize_replay_history
from app.agent_runtime.types import ORIGIN_DATA, ORIGIN_INSTRUCTION, AgentMessage, Role


def _user(text: str) -> AgentMessage:
    return AgentMessage(
        role=Role.USER,
        content=text,
        tool_call_id=None,
        name=None,
        origin=ORIGIN_INSTRUCTION,
    )


def _assistant_calls(*calls: tuple[str, str]) -> AgentMessage:
    return AgentMessage(
        role=Role.ASSISTANT,
        content="",
        tool_call_id=None,
        name=None,
        origin=ORIGIN_DATA,
        tool_calls=tuple(
            {"id": call_id, "name": name, "arguments": {}}
            for call_id, name in calls
        ),
    )


def _tool(call_id: str, name: str, content: str) -> AgentMessage:
    return AgentMessage(
        role=Role.TOOL,
        content=content,
        tool_call_id=call_id,
        name=name,
        origin=ORIGIN_DATA,
        is_error=True,
    )


def _unanswered_ids(messages: list[AgentMessage]) -> set[str]:
    pending: set[str] = set()
    for message in messages:
        if message.role is Role.ASSISTANT:
            for call in message.tool_calls:
                call_id = str(call.get("id") or "")
                if call_id:
                    pending.add(call_id)
        elif message.role is Role.TOOL and message.tool_call_id:
            pending.discard(str(message.tool_call_id))
    return pending


def test_dangling_read_only_tail_is_stripped_so_the_model_cannot_reissue_it() -> None:
    history = [
        _user("圈选了什么"),
        _assistant_calls(("c1", "look")),
    ]

    cleaned = sanitize_replay_history(history)

    assert cleaned[-1].role is Role.USER
    assert _unanswered_ids(cleaned) == set()
    assert not any(message.tool_calls for message in cleaned)


def test_dangling_side_effect_tail_is_recovered_as_unknown_not_erased() -> None:
    history = [
        _user("点保存"),
        _assistant_calls(("c2", "click")),
    ]

    cleaned = sanitize_replay_history(history)

    assert cleaned[-1].role is Role.TOOL
    assert cleaned[-1].tool_call_id == "c2"
    assert "UNKNOWN" in (cleaned[-1].content or "")
    assert _unanswered_ids(cleaned) == set()


def test_unanswered_look_buried_under_a_new_user_message_is_closed() -> None:
    # generate_turn runs after the next user line is already appended, so a
    # tail-only stripper would miss this and the provider would see a broken
    # tool_call / user sequence.
    history = [
        _user("先读"),
        _assistant_calls(("c3", "look")),
        _user("接着干"),
    ]

    cleaned = sanitize_replay_history(history)

    assert cleaned[-1].content == "接着干"
    assert _unanswered_ids(cleaned) == set()


def test_interrupted_read_only_block_is_stripped() -> None:
    history = [
        _user("读"),
        _assistant_calls(("c4", "look")),
        _tool(
            "c4",
            "look",
            "TOOL_NOT_STARTED: The tool call was interrupted before the Harness "
            "recorded it as started. Retry it if it is still needed.",
        ),
        _user("继续"),
    ]

    cleaned = sanitize_replay_history(history)

    assert not any(message.name == "look" for message in cleaned)
    assert cleaned[-1].content == "继续"
    assert _unanswered_ids(cleaned) == set()


def test_interrupted_side_effect_stays_visible_as_unknown() -> None:
    history = [
        _user("发送"),
        _assistant_calls(("c5", "click")),
        _tool(
            "c5",
            "click",
            "TOOL_OUTCOME_UNKNOWN: The tool call was interrupted after it was "
            "recorded, but no result was durably recorded. Its outcome is unknown. "
            "这一步可能已经对外产生不可撤销的效果：不要重试。",
        ),
        _user("还在吗"),
    ]

    cleaned = sanitize_replay_history(history)

    assert any(
        message.role is Role.TOOL and "UNKNOWN" in (message.content or "")
        for message in cleaned
    )
    assert cleaned[-1].content == "还在吗"
    assert _unanswered_ids(cleaned) == set()


def test_completed_tool_exchange_is_left_intact() -> None:
    history = [
        _user("读"),
        _assistant_calls(("c6", "look")),
        _tool("c6", "look", '{"status":"ok","value":"保存按钮"}'),
        _user("点它"),
    ]

    cleaned = sanitize_replay_history(history)

    assert cleaned == history
