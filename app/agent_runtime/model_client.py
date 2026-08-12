"""Agent runtime loop model client (harness loop batch, plan T2.3).

Ported semantics from the CC query-loop and Pi agent-loop study notes
(``docs/harness-port-notes/2026-08-12-cc-query-loop.md``,
``docs/harness-port-notes/2026-08-12-pi-agent-loop.md``):

- ``ModelTurnEvent`` union: the per-turn model stream is a discriminated
  union of frozen dataclasses, discriminated via ``isinstance`` (the Python
  form of the CC ``StreamEvent`` union; the loop layer consumes the list
  returned by :meth:`LoopModelClient.generate_turn`).
- CC withhold-until-recover: ``TurnWithheld`` is a *recovery signal*, not a
  failure. The client passes withheld events through untouched and keeps a
  cumulative ``withheld_count``; it never raises. The loop layer owns the
  retry ceiling (``MAX_OUTPUT_TOKENS_RECOVERY_LIMIT``, re-exported here from
  ``app.agent_runtime.errors``) and resets ``withheld_count`` when it decides
  a fresh turn has started.
- Pi StreamFn truncation guard: when the final text ends with a configurable
  truncation suffix (default ``…``) *and* the stream carried tool calls, the
  call is marked truncated (``last_truncated``) so the caller discards the
  calls instead of executing possibly cut-off arguments.
- ``ModelBackend`` is the StreamFn-style contract: a generator that yields
  events and never fabricates. ``AiClientBackend`` wraps the real
  ``app/ai_client`` (read-only) with an honest mapping.

Pure Python, stdlib-only; no network in this module itself.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Protocol

from app import ai_client as _ai_client
from app.agent_runtime.errors import MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
from app.agent_runtime.types import AgentMessage, Role, ToolCall

__all__ = [
    "MAX_OUTPUT_TOKENS_RECOVERY_LIMIT",
    "AiClientBackend",
    "LoopModelClient",
    "MessageDelta",
    "ModelBackend",
    "ModelTurnEvent",
    "ModelUnsupported",
    "ToolCallArrived",
    "TurnDone",
    "TurnStarted",
    "TurnWithheld",
]

_DEFAULT_TRUNCATION_SUFFIX = "…"


class ModelTurnEvent:
    """Base of the model turn event union; discriminate via ``isinstance``."""

    kind = "event"


@dataclass(frozen=True, slots=True)
class TurnStarted(ModelTurnEvent):
    kind = "turn_started"


@dataclass(frozen=True, slots=True)
class MessageDelta(ModelTurnEvent):
    kind = "message_delta"
    text: str


@dataclass(frozen=True, slots=True)
class ToolCallArrived(ModelTurnEvent):
    kind = "tool_call_arrived"
    call: ToolCall


@dataclass(frozen=True, slots=True)
class TurnDone(ModelTurnEvent):
    kind = "turn_done"
    usage: dict | None
    raw_text: str | None


@dataclass(frozen=True, slots=True)
class TurnWithheld(ModelTurnEvent):
    """Recoverable outcome held back (CC max_output_tokens withhold).

    Not a failure: the loop layer decides retries and caps them at
    ``MAX_OUTPUT_TOKENS_RECOVERY_LIMIT``.
    """

    kind = "turn_withheld"
    reason: str


@dataclass(frozen=True, slots=True)
class ModelUnsupported(ModelTurnEvent):
    """Honest capability refusal: no request was (or will be) fabricated."""

    kind = "model_unsupported"
    reason: str


class ModelBackend(Protocol):
    """StreamFn-style backend contract: generator, never raises.

    ``cancel_scope`` is an opaque cancellation token the backend may or may
    not honor; the client passes it through untouched.
    """

    def generate(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None,
        cancel_scope: object,
    ) -> Iterator[ModelTurnEvent]:
        ...


class LoopModelClient:
    """Client over an injected :class:`ModelBackend`.

    ``generate_turn`` consumes the backend generator into a list of events,
    keeping a cumulative ``withheld_count`` (CC recovery counter) and the
    ``last_usage`` aggregate from :class:`TurnDone`. ``parse_tool_calls``
    extracts tool calls and the final text, recording malformed argument
    JSON into ``last_errors`` instead of raising, and sets ``last_truncated``
    per the Pi StreamFn truncation guard.
    """

    def __init__(
        self,
        backend: ModelBackend,
        *,
        truncation_suffix: str | None = _DEFAULT_TRUNCATION_SUFFIX,
    ) -> None:
        self._backend = backend
        self.truncation_suffix = truncation_suffix
        self.last_usage: dict | None = None
        self.last_truncated = False
        self.last_errors: list[str] = []
        self.withheld_count = 0

    def generate_turn(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None = None,
        cancel_scope: object = None,
    ) -> list[ModelTurnEvent]:
        """Consume the backend generator; events come back untouched.

        ``TurnWithheld`` events are passed through as-is and counted
        cumulatively (``withheld_count``); this client never raises on them
        -- withheld is a recovery signal and the loop layer owns the retry
        ceiling (``MAX_OUTPUT_TOKENS_RECOVERY_LIMIT``). ``last_usage`` is
        reset per turn and set from each ``TurnDone``.
        """
        self.last_usage = None
        events: list[ModelTurnEvent] = []
        for event in self._backend.generate(
            messages, tools, budget_ms, cancel_scope
        ):
            if isinstance(event, TurnWithheld):
                self.withheld_count += 1
            elif isinstance(event, TurnDone):
                self.last_usage = event.usage
            events.append(event)
        return events

    def parse_tool_calls(
        self,
        events: list[ModelTurnEvent],
        *,
        truncation_suffix: str | None = None,
    ) -> tuple[list[ToolCall], str | None]:
        """Extract tool calls and the final text from an event stream.

        Returns ``(calls, text)`` where ``text`` is the concatenated
        ``MessageDelta`` text, falling back to the last ``TurnDone.raw_text``
        when no deltas were streamed. Malformed arguments (a string that is
        not valid JSON, or a non-object argument) are recorded into
        ``last_errors`` and the offending call is dropped (fail closed) --
        never raised. ``last_truncated`` is set True when the final text ends
        with ``truncation_suffix`` (default: the client's configured suffix)
        *and* tool calls were extracted; the caller discards the calls in
        that case instead of executing possibly cut-off arguments.
        """
        suffix = (
            self.truncation_suffix
            if truncation_suffix is None
            else truncation_suffix
        )
        calls: list[ToolCall] = []
        text_parts: list[str] = []
        raw_text: str | None = None
        errors: list[str] = []
        for event in events:
            if isinstance(event, MessageDelta):
                text_parts.append(event.text)
            elif isinstance(event, ToolCallArrived):
                call = _normalize_call(event.call, errors)
                if call is not None:
                    calls.append(call)
            elif isinstance(event, TurnDone):
                raw_text = event.raw_text
        text = "".join(text_parts) or (raw_text or "")
        final_text = text or None
        truncated = (
            suffix is not None
            and bool(calls)
            and final_text is not None
            and final_text.endswith(suffix)
        )
        self.last_truncated = truncated
        self.last_errors = errors
        return calls, final_text


class AiClientBackend:
    """Real backend over ``app/ai_client`` (read-only, honest mapping).

    API audit of ``app/ai_client.py``: ``ask_text_model_with_tools`` is a
    chat-completions-style request that accepts a ``tools`` list and returns
    ``{"text", "toolCalls": [{"name", "arguments"}], "error"}``, so tools
    *are* supported and real requests are mapped (no
    ``ModelUnsupported("backend_lacks_tool_protocol")`` needed). Honest
    limitations of the mapping:

    - The wrapped API takes a single ``user_prompt`` string; the message
      list is serialized into it. Multi-turn tool-result history cannot be
      round-tripped through this backend.
    - Tool call ids do not exist in the gateway protocol and are
      synthesized locally (``call_<index>``).
    - ``cancel_scope`` is accepted but not enforced: the wrapped call is
      synchronous.
    - The wrapped API never reports usage; ``TurnDone.usage`` is always
      ``None``.
    - A backend error is emitted as ``TurnWithheld(reason="backend_error:…")``
      (CC recoverable-error withhold) followed by an empty ``TurnDone``.
    """

    used_backend = "app.ai_client.ask_text_model_with_tools"

    def __init__(self, *, timeout_s: float = 20.0, max_tokens: int = 240) -> None:
        self.timeout_s = max(1.0, float(timeout_s))
        self.max_tokens = max(1, int(max_tokens))

    def generate(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None = None,
        cancel_scope: object = None,
    ) -> Iterator[ModelTurnEvent]:
        yield TurnStarted()
        budget = (
            max(1.0, budget_ms / 1000.0)
            if budget_ms is not None
            else self.timeout_s
        )
        result = _ai_client.ask_text_model_with_tools(
            user_prompt=_serialize_messages(messages),
            tools=tools,
            timeout_s=budget,
            max_tokens=self.max_tokens,
        )
        error = (result or {}).get("error") or ""
        if error:
            yield TurnWithheld(reason=f"backend_error:{error}")
            yield TurnDone(usage=None, raw_text=None)
            return
        text = (result or {}).get("text") or ""
        if text:
            yield MessageDelta(text)
        for index, raw in enumerate((result or {}).get("toolCalls") or []):
            name = str(raw.get("name") or "") if isinstance(raw, dict) else ""
            if not name:
                continue
            arguments = raw.get("arguments") if isinstance(raw, dict) else {}
            if not isinstance(arguments, dict):
                arguments = {}
            yield ToolCallArrived(
                call=ToolCall(
                    id=f"call_{index}", name=name, arguments=arguments
                )
            )
        yield TurnDone(usage=None, raw_text=text or None)


def _normalize_call(call: ToolCall, errors: list[str]) -> ToolCall | None:
    """Return ``call`` with dict arguments, or None with an error recorded.

    Backends may pre-parse arguments into a dict or pass the raw JSON
    string through; anything else is malformed and fail-closed.
    """
    args = call.arguments
    if isinstance(args, dict):
        return call
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
        except (ValueError, TypeError):
            errors.append(
                f"tool {call.name!r} ({call.id}): malformed arguments JSON: "
                f"{args!r}"
            )
            return None
        if not isinstance(parsed, dict):
            errors.append(
                f"tool {call.name!r} ({call.id}): arguments JSON is not an "
                f"object: {parsed!r}"
            )
            return None
        return ToolCall(id=call.id, name=call.name, arguments=parsed)
    errors.append(
        f"tool {call.name!r} ({call.id}): arguments must be a dict or JSON "
        f"string, got {type(args).__name__}"
    )
    return None


def _serialize_messages(messages: list[AgentMessage]) -> str:
    """Serialize the message list into the wrapped API's single prompt.

    Honest text projection: the wrapped ``ask_text_model_with_tools`` only
    accepts one ``user_prompt`` string, so prior turns are projected into it
    role-labelled. Empty input degrades to a neutral instruction.
    """
    lines: list[str] = []
    for message in messages:
        if message.role is Role.USER:
            lines.append(f"[user] {message.content or ''}")
        elif message.role is Role.ASSISTANT:
            lines.append(f"[assistant] {message.content or ''}")
        elif message.role is Role.TOOL:
            marker = "[tool_result]" if not message.is_error else "[tool_result][error]"
            lines.append(f"{marker} {message.content or ''}")
    return "\n".join(lines).strip() or "请基于提供的上下文回答。"
