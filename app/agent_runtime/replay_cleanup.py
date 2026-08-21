"""Replay-history sanitization shared across resume code paths.

Ported from HermesAgent ``agent/replay_cleanup.py`` (MIT, hermes-agent 0.18.2).
Adapted to Magic Pointer's frozen :class:`AgentMessage` (``name`` lives on the
message, not under OpenAI ``function``) and to this runtime's repair markers
(``TOOL_NOT_STARTED`` / ``TOOL_OUTCOME_UNKNOWN``).

When a turn dies mid-tool-loop the transcript can end with a dangling
``assistant(tool_calls)`` or an interrupted assistant→tool block.  On the next
model call that tail is re-issued as an endless reboot.  These helpers close
that gap on the copy the model sees; the durable JSONL is left intact.

Sanitize immediately before the model call, never while a live tool round is
still waiting for results — at that point the unanswered tail is in-flight.
"""

from __future__ import annotations

from dataclasses import replace

from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role

__all__ = [
    "is_interrupted_tool_result",
    "sanitize_replay_history",
    "tool_may_have_side_effect",
]

_READ_ONLY_TOOLS = frozenset({
    "look",
    "read_around",
    "find_in_window",
    "dump_subtree",
    "get_focused",
    "list_windows",
    "list_apps",
    "get_app_state",
    "describe_capabilities",
    "ask_user_question",
})

_INTERRUPT_MARKERS = (
    "tool_outcome_unknown",
    "tool_not_started",
    "[command interrupted]",
    "orphan recovery",
)

_ORPHAN_UNKNOWN = (
    "[Orphan recovery: this tool may have executed before Magic Pointer "
    "stopped; its effect is UNKNOWN. Inspect current state before retrying.]"
)
_ORPHAN_READ = (
    "[Orphan recovery: this read-only tool did not complete and had no effect.]"
)


def tool_may_have_side_effect(name: str) -> bool:
    """Fail closed: an unknown name is treated as possibly having an effect."""
    return str(name or "") not in _READ_ONLY_TOOLS


def is_interrupted_tool_result(content: str | None) -> bool:
    lowered = (content or "").lower()
    return any(marker in lowered for marker in _INTERRUPT_MARKERS)


def sanitize_replay_history(messages: list[AgentMessage]) -> list[AgentMessage]:
    """Strip interrupted read-only blocks, then close unanswered tool calls."""
    if not messages:
        return messages
    return close_unanswered_tool_calls(strip_interrupted_tool_tails(messages))


def _call_id(call: dict) -> str:
    return str(call.get("id") or call.get("call_id") or "")


def _call_name(call: dict) -> str:
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    return str(call.get("name") or function.get("name") or "")


def _orphan_result(call_id: str, name: str) -> AgentMessage:
    side = tool_may_have_side_effect(name)
    return AgentMessage(
        role=Role.TOOL,
        content=_ORPHAN_UNKNOWN if side else _ORPHAN_READ,
        tool_call_id=call_id,
        name=name,
        is_error=True,
        origin=ORIGIN_DATA,
    )


def strip_interrupted_tool_tails(messages: list[AgentMessage]) -> list[AgentMessage]:
    """Drop interrupted read-only assistant→tool blocks; keep side-effecting ones."""
    cleaned: list[AgentMessage] = []
    index = 0
    length = len(messages)
    while index < length:
        message = messages[index]
        if message.role is Role.ASSISTANT and message.tool_calls:
            cursor = index + 1
            results: list[AgentMessage] = []
            while cursor < length and messages[cursor].role is Role.TOOL:
                results.append(messages[cursor])
                cursor += 1
            if results and any(
                is_interrupted_tool_result(item.content) for item in results
            ):
                if any(
                    tool_may_have_side_effect(_call_name(call))
                    for call in message.tool_calls
                ):
                    cleaned.append(message)
                    names = {
                        _call_id(call): _call_name(call) for call in message.tool_calls
                    }
                    for result in results:
                        if not is_interrupted_tool_result(result.content):
                            cleaned.append(result)
                            continue
                        name = names.get(str(result.tool_call_id or ""), result.name or "")
                        if tool_may_have_side_effect(name):
                            if "UNKNOWN" in (result.content or ""):
                                cleaned.append(result)
                            else:
                                cleaned.append(replace(result, content=_ORPHAN_UNKNOWN))
                        else:
                            cleaned.append(replace(result, content=_ORPHAN_READ))
                    index = cursor
                    continue
                index = cursor
                continue
        if message.role is Role.TOOL and is_interrupted_tool_result(message.content):
            index += 1
            continue
        cleaned.append(message)
        index += 1
    return cleaned


def close_unanswered_tool_calls(messages: list[AgentMessage]) -> list[AgentMessage]:
    """Close unanswered tool_calls anywhere, not only at the tail.

    generate_turn runs after the next user line is already appended, so a
    tail-only stripper would leave a broken assistant/user pair for the provider.
    """
    cleaned: list[AgentMessage] = []
    index = 0
    length = len(messages)
    while index < length:
        message = messages[index]
        if message.role is Role.ASSISTANT and message.tool_calls:
            cursor = index + 1
            results: list[AgentMessage] = []
            while cursor < length and messages[cursor].role is Role.TOOL:
                results.append(messages[cursor])
                cursor += 1
            answered = {
                str(item.tool_call_id)
                for item in results
                if item.tool_call_id
            }
            missing = [
                call
                for call in message.tool_calls
                if _call_id(call) and _call_id(call) not in answered
            ]
            if not missing:
                cleaned.append(message)
                cleaned.extend(results)
                index = cursor
                continue
            if (
                not results
                and not any(
                    tool_may_have_side_effect(_call_name(call))
                    for call in message.tool_calls
                )
            ):
                index = cursor
                continue
            cleaned.append(message)
            cleaned.extend(results)
            cleaned.extend(
                _orphan_result(_call_id(call), _call_name(call)) for call in missing
            )
            index = cursor
            continue
        cleaned.append(message)
        index += 1
    return cleaned
