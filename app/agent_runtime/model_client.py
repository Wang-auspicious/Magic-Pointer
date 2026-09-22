
from __future__ import annotations

import json
import os
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Protocol

from app import ai_client as _ai_client
from app.agent_runtime.effort import normalize_effort, native_effort_fields
from app.agent_runtime.context_projection import project_context_messages
from app.agent_runtime.errors import (
    CONTEXT_OVERFLOW_REASON,
    MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
    is_context_overflow_error,
)
from app.agent_runtime.types import AgentMessage, Role, ToolCall
from app.governance.cancellation import CancelledError

__all__ = [
    "MAX_OUTPUT_TOKENS_RECOVERY_LIMIT",
    "AiClientBackend",
    "AiClientMessagesBackend",
    "LoopModelClient",
    "MessageDelta",
    "ModelBackend",
    "ModelTurnEvent",
    "ModelUnsupported",
    "ReasoningDelta",
    "StreamingMessagesBackend",
    "ToolCallArrived",
    "TurnDone",
    "TurnStarted",
    "TurnWithheld",
    "prompt_cache_enabled",
]

_DEFAULT_TRUNCATION_SUFFIX: str | None = None
_MIN_HTTP_TIMEOUT_S = 0.05

ESCALATED_MAX_TOKENS = 64_000

MAX_OUTPUT_TOKEN_ESCALATIONS = 2

_ESCALATION_FLOOR = 16_384

_ESCALATION_FACTOR = 4


def escalated_max_tokens(current: int, escalations_used: int) -> int:
    if escalations_used >= MAX_OUTPUT_TOKEN_ESCALATIONS:
        return 0
    current = max(1, int(current))
    proposed = min(max(current * _ESCALATION_FACTOR, _ESCALATION_FLOOR), ESCALATED_MAX_TOKENS)
    if proposed <= current:
        return 0
    return proposed


class ModelTurnEvent:

    kind = "event"


@dataclass(frozen=True, slots=True)
class TurnStarted(ModelTurnEvent):
    kind = "turn_started"


@dataclass(frozen=True, slots=True)
class MessageDelta(ModelTurnEvent):
    kind = "message_delta"
    text: str


@dataclass(frozen=True, slots=True)
class ReasoningDelta(ModelTurnEvent):

    kind = "reasoning_delta"
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
    provider_items: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True, slots=True)
class TurnWithheld(ModelTurnEvent):

    kind = "turn_withheld"
    reason: str


@dataclass(frozen=True, slots=True)
class ModelUnsupported(ModelTurnEvent):

    kind = "model_unsupported"
    reason: str


class ModelBackend(Protocol):

    def generate(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None,
        cancel_scope: object,
    ) -> Iterator[ModelTurnEvent]:
        ...


class LoopModelClient:

    def __init__(
        self,
        backend: ModelBackend,
        *,
        truncation_suffix: str | None = _DEFAULT_TRUNCATION_SUFFIX,
        max_provider_retries: int = 2,
        retry_sleeper=time.sleep,
        retry_clock=time.monotonic,
    ) -> None:
        self._backend = backend
        self.truncation_suffix = truncation_suffix
        self.max_provider_retries = max(0, int(max_provider_retries))
        self._retry_sleeper = retry_sleeper
        self._retry_clock = retry_clock
        self.last_usage: dict | None = None
        self.last_reasoning: str | None = None
        self.last_truncated = False
        self.last_errors: list[str] = []
        self.last_events: list[ModelTurnEvent] = []
        self.withheld_count = 0
        self._reserved_call_ids: set[str] = set()
        self._next_synthetic_call_id = 0
        self.output_token_escalations = 0

    def escalate_output_tokens(self) -> int:
        escalate = getattr(self._backend, "escalate_max_tokens", None)
        if not callable(escalate):
            return 0
        try:
            raised = int(escalate(self.output_token_escalations) or 0)
        except Exception:  # noqa: BLE001 -- a backend that cannot escalate is
            return 0
        if raised <= 0:
            return 0
        self.output_token_escalations += 1
        return raised

    @property
    def used_backend(self) -> str:
        declared = str(getattr(self._backend, "used_backend", "") or "").strip()
        if declared:
            return declared
        backend_type = type(self._backend)
        return f"{backend_type.__module__}.{backend_type.__qualname__}"

    @property
    def prompt_cache_requested(self) -> bool:
        return bool(getattr(self._backend, "prompt_cache_requested", False))

    def generate_turn(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None = None,
        cancel_scope: object = None,
    ) -> list[ModelTurnEvent]:
        return list(self.stream_turn(
            messages,
            tools,
            budget_ms=budget_ms,
            cancel_scope=cancel_scope,
        ))

    def stream_turn(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None = None,
        cancel_scope: object = None,
    ) -> Iterator[ModelTurnEvent]:
        self.last_usage = None
        self.last_reasoning = None
        self.last_events = []
        for message in messages:
            if message.tool_call_id:
                self._reserved_call_ids.add(str(message.tool_call_id))
            for call in message.tool_calls:
                call_id = str(call.get("id") or "").strip()
                if call_id:
                    self._reserved_call_ids.add(call_id)
        attempt = 0
        deadline = (
            self._retry_clock() + max(0.0, float(budget_ms)) / 1000.0
            if budget_ms is not None
            else None
        )
        while True:
            _check_cancelled(cancel_scope)
            attempt_budget_ms = budget_ms
            if deadline is not None:
                attempt_budget_ms = max(
                    0.0,
                    (deadline - self._retry_clock()) * 1000.0,
                )
                if attempt_budget_ms <= 0.0:
                    self.withheld_count += 1
                    terminal_events: list[ModelTurnEvent] = [
                        TurnWithheld(
                            reason="backend_error:model_request_timeout"
                        ),
                        TurnDone(usage=None, raw_text=None),
                    ]
                    for event in terminal_events:
                        self._accept_event(event)
                        yield event
                    return
            buffered: list[ModelTurnEvent] = []
            committed = False
            terminal_seen = False
            try:
                for event in self._backend.generate(
                    messages, tools, attempt_budget_ms, cancel_scope
                ):
                    if terminal_seen:
                        continue
                    if isinstance(event, TurnWithheld):
                        self.withheld_count += 1
                    if not committed:
                        buffered.append(event)
                        if isinstance(
                            event,
                            (MessageDelta, ReasoningDelta, ToolCallArrived),
                        ):
                            committed = True
                            for held in buffered:
                                self._accept_event(held)
                                yield held
                            buffered.clear()
                        elif isinstance(event, TurnDone):
                            terminal_seen = True
                        continue
                    self._accept_event(event)
                    yield event
                    if isinstance(event, TurnDone):
                        terminal_seen = True
            except CancelledError:
                if not terminal_seen:
                    raise
                if committed:
                    return
            except Exception as exc:
                if terminal_seen:
                    if committed:
                        return
                elif committed:
                    terminal_events = [
                        TurnWithheld(reason=f"backend_error:{type(exc).__name__}"),
                        TurnDone(usage=None, raw_text=None),
                    ]
                    for event in terminal_events:
                        if isinstance(event, TurnWithheld):
                            self.withheld_count += 1
                        self._accept_event(event)
                        yield event
                    return
                else:
                    buffered = [
                        TurnWithheld(reason=f"backend_error:{type(exc).__name__}"),
                        TurnDone(usage=None, raw_text=None),
                    ]
                    self.withheld_count += 1
            if terminal_seen and committed:
                return
            _check_cancelled(cancel_scope)
            backend_failures = [
                event.reason
                for event in buffered
                if isinstance(event, TurnWithheld)
                and event.reason.startswith("backend_error:")
            ]
            retryable = bool(backend_failures) and all(
                _provider_failure_is_retryable(reason)
                for reason in backend_failures
            )
            if not retryable or attempt >= self.max_provider_retries:
                for event in buffered:
                    self._accept_event(event)
                    yield event
                return
            attempt += 1
            retry_delay_s = 0.25 * (2 ** (attempt - 1))
            if (
                deadline is not None
                and self._retry_clock() + retry_delay_s >= deadline
            ):
                for event in buffered:
                    self._accept_event(event)
                    yield event
                return
            self._retry_sleeper(retry_delay_s)
            _check_cancelled(cancel_scope)

    def _accept_event(self, event: ModelTurnEvent) -> None:
        self.last_events.append(event)
        if isinstance(event, TurnDone):
            self.last_usage = event.usage
        elif isinstance(event, ReasoningDelta):
            self.last_reasoning = (self.last_reasoning or "") + event.text

    def parse_tool_calls(
        self,
        events: list[ModelTurnEvent],
        *,
        truncation_suffix: str | None = None,
    ) -> tuple[list[ToolCall], str | None]:
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
                    calls.append(self._reserve_call_id(call))
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

    def _reserve_call_id(self, call: ToolCall) -> ToolCall:
        candidate = str(call.id or "").strip()
        if (
            candidate
            and len(candidate) <= 240
            and all(ord(char) >= 32 for char in candidate)
            and candidate not in self._reserved_call_ids
        ):
            self._reserved_call_ids.add(candidate)
            return call
        while True:
            generated = f"mp_call_{self._next_synthetic_call_id}"
            self._next_synthetic_call_id += 1
            if generated not in self._reserved_call_ids:
                self._reserved_call_ids.add(generated)
                return ToolCall(
                    id=generated,
                    name=call.name,
                    arguments=call.arguments,
                    argument_error=call.argument_error,
                )


class AiClientBackend:

    used_backend = "app.ai_client.ask_text_model_with_tools"

    def __init__(self, *, timeout_s: float = 20.0, max_tokens: int = 240) -> None:
        self.timeout_s = max(1.0, float(timeout_s))
        self.max_tokens = max(1, int(max_tokens))

    def escalate_max_tokens(self, escalations_used: int = 0) -> int:
        raised = escalated_max_tokens(self.max_tokens, escalations_used)
        if raised:
            self.max_tokens = raised
        return raised

    def generate(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None = None,
        cancel_scope: object = None,
    ) -> Iterator[ModelTurnEvent]:
        yield TurnStarted()
        _check_cancelled(cancel_scope)
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
        _check_cancelled(cancel_scope)
        error = (result or {}).get("error") or ""
        if error:
            yield TurnWithheld(reason=f"backend_error:{error}")
            yield TurnDone(usage=None, raw_text=None)
            return
        text = (result or {}).get("text") or ""
        if _is_length_finish(result or {}):
            if text:
                yield MessageDelta(text)
            yield TurnWithheld(reason="max_output_tokens")
            yield TurnDone(usage=None, raw_text=text or None)
            return
        if text:
            yield MessageDelta(text)
        for index, raw in enumerate((result or {}).get("toolCalls") or []):
            name = str(raw.get("name") or "") if isinstance(raw, dict) else ""
            if not name:
                continue
            arguments = raw.get("arguments") if isinstance(raw, dict) else {}
            yield ToolCallArrived(
                call=ToolCall(
                    id=str(raw.get("id") or f"call_{index}"),
                    name=name,
                    arguments=arguments,
                )
            )
        yield TurnDone(usage=None, raw_text=text or None)


_LENGTH_FINISH_REASONS = frozenset({"length", "max_tokens", "max_output_tokens"})


def _is_length_finish(result: dict) -> bool:
    return str(result.get("finishReason") or "").strip().casefold() in _LENGTH_FINISH_REASONS


def _normalize_call(call: ToolCall, errors: list[str]) -> ToolCall | None:
    args = call.arguments
    if isinstance(args, dict):
        return call

    def malformed(message: str) -> ToolCall:
        errors.append(message)
        return ToolCall(
            id=call.id,
            name=call.name,
            arguments={},
            argument_error=message,
        )

    if isinstance(args, str):
        try:
            parsed = json.loads(args)
        except (ValueError, TypeError):
            return malformed(
                f"tool {call.name!r} ({call.id}): malformed arguments JSON: "
                f"{args!r}"
            )
        if not isinstance(parsed, dict):
            return malformed(
                f"tool {call.name!r} ({call.id}): arguments JSON is not an "
                f"object: {parsed!r}"
            )
        return ToolCall(id=call.id, name=call.name, arguments=parsed)
    return malformed(
        f"tool {call.name!r} ({call.id}): arguments must be a dict or JSON "
        f"string, got {type(args).__name__}"
    )


def _reasoning_from_payload(payload: object, api_mode: str) -> str:
    if not isinstance(payload, dict):
        return ""
    if api_mode == "messages":
        parts: list[str] = []
        content = payload.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "thinking":
                    parts.append(str(block.get("thinking") or ""))
        return "".join(parts)
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0] if isinstance(choices[0], dict) else None
    message = first.get("message") if isinstance(first, dict) else None
    if not isinstance(message, dict):
        return ""
    for key in ("reasoning_content", "reasoning"):
        value = message.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


class AiClientMessagesBackend:

    used_backend = "magic_pointer.messages_multiturn"

    @property
    def prompt_cache_requested(self) -> bool:
        _key, base_url, _model = _ai_client.get_ai_config()
        return (
            prompt_cache_enabled()
            and _ai_client.get_ai_api_mode(str(base_url or "")) == "messages"
        )

    def __init__(
        self,
        *,
        timeout_s: float = 20.0,
        max_tokens: int = 240,
        system_prompt: str | None = None,
        effort: object = "high",
    ) -> None:
        self.timeout_s = max(_MIN_HTTP_TIMEOUT_S, float(timeout_s))
        self.max_tokens = max(1, int(max_tokens))
        self.system_prompt = (
            system_prompt.strip() if system_prompt and system_prompt.strip() else None
        )
        self.effort = normalize_effort(effort)
        self._client_factory = None

    def escalate_max_tokens(self, escalations_used: int = 0) -> int:
        raised = escalated_max_tokens(self.max_tokens, escalations_used)
        if raised:
            self.max_tokens = raised
        return raised

    def generate(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None = None,
        cancel_scope: object = None,
    ) -> Iterator[ModelTurnEvent]:
        yield TurnStarted()
        _check_cancelled(cancel_scope)
        api_key, base_url, model = _ai_client.get_ai_config()
        base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        api_mode = _ai_client.get_ai_api_mode(base_url)
        blocked = _ai_client.short_circuit_message(base_url)
        if blocked:
            yield TurnWithheld(reason=f"backend_error:{blocked}")
            yield TurnDone(usage=None, raw_text=None)
            return
        if not api_key and api_mode != "local":
            yield TurnWithheld(reason="backend_error:credential_missing")
            yield TurnDone(usage=None, raw_text=None)
            return
        budget = max(
            _MIN_HTTP_TIMEOUT_S,
            (budget_ms / 1000.0) if budget_ms is not None else self.timeout_s,
        )
        endpoint = _ai_client._completion_endpoint(base_url, api_mode)
        headers = _ai_client._completion_headers(api_key or "", api_mode, base_url=base_url)
        payload = _messages_payload(
            model,
            messages,
            tools,
            self.max_tokens,
            api_mode,
            system_prompt=self.system_prompt,
            effort=self.effort,
        )
        try:
            import httpx  # noqa: PLC0415 -- optional transport dependency

            if self._client_factory is not None:
                client = self._client_factory(budget)
            else:
                client = _ai_client._httpx_client(httpx, timeout=budget)
            with client:
                response = client.post(endpoint, headers=headers, json=payload)
                if 400 <= response.status_code < 500:
                    stripped = _ai_client._without_optional_request_fields(payload)
                    if stripped is not None:
                        response = client.post(
                            endpoint,
                            headers=headers,
                            json=stripped,
                        )
            _check_cancelled(cancel_scope)
        except CancelledError:
            raise
        except httpx.TimeoutException:
            yield TurnWithheld(reason="backend_error:model_request_timeout")
            yield TurnDone(usage=None, raw_text=None)
            return
        except Exception as exc:
            _ai_client.record_failure(
                status=None,
                exception_name=type(exc).__name__,
                detail=str(exc)[:300],
                model=model,
                base_url=base_url,
            )
            yield TurnWithheld(reason=f"backend_error:{type(exc).__name__}")
            yield TurnDone(usage=None, raw_text=None)
            return
        if response.status_code >= 400:
            _ai_client.record_failure(
                status=response.status_code,
                detail=response.text[:300],
                model=model,
                base_url=base_url,
            )
            yield TurnWithheld(reason=f"backend_error:http_{response.status_code}")
            yield TurnDone(usage=None, raw_text=None)
            return
        try:
            response_payload = response.json()
            parsed = _ai_client._tool_completion_response(response_payload, api_mode)
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            _ai_client.record_failure(
                status=None,
                exception_name=type(exc).__name__,
                detail="unparseable model response",
                model=model,
                base_url=base_url,
            )
            yield TurnWithheld(reason=f"backend_error:unparseable_response:{type(exc).__name__}")
            yield TurnDone(usage=None, raw_text=None)
            return
        hit_token_limit = _response_hit_token_limit(response_payload, api_mode)
        failure_reason = _response_failure_reason(response_payload, api_mode)
        if failure_reason:
            _ai_client.record_failure(
                status=None,
                exception_name="IncompleteModelResponse",
                detail=failure_reason,
                model=model,
                base_url=base_url,
            )
            yield TurnWithheld(reason=f"backend_error:{failure_reason}")
            usage = response_payload.get("usage")
            yield TurnDone(
                usage=dict(usage) if isinstance(usage, dict) else None,
                raw_text=None,
                provider_items=_provider_items(response_payload, api_mode),
            )
            return
        text = str(parsed.get("text") or "")
        valid_calls = [
            raw
            for raw in (parsed.get("toolCalls") or [])
            if isinstance(raw, dict) and str(raw.get("name") or "")
        ]
        if not text and not valid_calls and not hit_token_limit:
            _ai_client.record_failure(
                status=None,
                exception_name="EmptyModelResponse",
                detail="HTTP 200 contained neither text nor tool calls",
                model=model,
                base_url=base_url,
            )
            yield TurnWithheld(reason="backend_error:empty_response")
            yield TurnDone(usage=None, raw_text=None)
            return
        _ai_client.record_success(model=model, base_url=base_url)
        reasoning_text = _reasoning_from_payload(response_payload, api_mode)
        if reasoning_text:
            yield ReasoningDelta(reasoning_text)
        if text:
            yield MessageDelta(text)
        for index, raw in enumerate(valid_calls):
            name = str(raw.get("name") or "")
            arguments = raw.get("arguments")
            yield ToolCallArrived(
                call=ToolCall(
                    id=str(raw.get("id") or f"call_{index}"),
                    name=name,
                    arguments=arguments,
                )
            )
        if hit_token_limit:
            yield TurnWithheld(reason="max_output_tokens")
        usage = response_payload.get("usage")
        yield TurnDone(
            usage=dict(usage) if isinstance(usage, dict) else None,
            raw_text=text or None,
            provider_items=_provider_items(response_payload, api_mode),
        )


def _response_hit_token_limit(payload: object, api_mode: str) -> bool:
    if not isinstance(payload, dict):
        return False
    if api_mode == "responses":
        details = payload.get("incomplete_details")
        return (
            str(payload.get("status") or "") == "incomplete"
            and isinstance(details, dict)
            and str(details.get("reason") or "") == "max_output_tokens"
        )
    if api_mode == "messages":
        return str(payload.get("stop_reason") or "") == "max_tokens"
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return False
    first = choices[0]
    return (
        isinstance(first, dict)
        and str(first.get("finish_reason") or "") == "length"
    )


def _response_failure_reason(payload: object, api_mode: str) -> str:
    if api_mode != "responses" or not isinstance(payload, dict):
        return ""
    status = str(payload.get("status") or "")
    if status == "incomplete" and not _response_hit_token_limit(payload, api_mode):
        details = payload.get("incomplete_details")
        reason = str(details.get("reason") or "unknown") if isinstance(details, dict) else "unknown"
        return f"response_incomplete:{reason}"
    if status == "failed":
        error = payload.get("error")
        return str(error.get("code") or "response_failed") if isinstance(error, dict) else "response_failed"
    return ""


def _message_entry(message: AgentMessage, api_mode: str) -> dict:
    if message.role is Role.ASSISTANT:
        chat_reasoning = next(({'reasoning_content': item['reasoning_content']}
            for item in message.provider_items if item.get('type') == 'chat_reasoning'
            and isinstance(item.get('reasoning_content'), str)), {}) if api_mode != 'messages' else {}
        if message.tool_calls:
            if api_mode == "messages":
                blocks: list[dict] = [dict(item) for item in message.provider_items
                    if item.get('type') in {'thinking', 'redacted_thinking'}]
                if message.content:
                    blocks.append({"type": "text", "text": message.content})
                for call in message.tool_calls:
                    blocks.append({
                        "type": "tool_use",
                        "id": str(call.get("id") or "?"),
                        "name": str(call.get("name") or "tool"),
                        "input": call.get("arguments") or {},
                    })
                return {"role": "assistant", "content": blocks}
            return {
                "role": "assistant",
                "content": message.content or "",
                **chat_reasoning,
                "tool_calls": [
                    {
                        "id": str(call.get("id") or "?"),
                        "type": "function",
                        "function": {
                            "name": str(call.get("name") or "tool"),
                            "arguments": json.dumps(
                                call.get("arguments") or {}, ensure_ascii=False
                            ),
                        },
                    }
                    for call in message.tool_calls
                ],
            }
        if api_mode == 'messages' and message.provider_items:
            blocks = [dict(item) for item in message.provider_items
                      if item.get('type') in {'thinking', 'redacted_thinking'}]
            if message.content:
                blocks.append({'type': 'text', 'text': message.content})
            if blocks:
                return {'role': 'assistant', 'content': blocks}
        return {"role": "assistant", "content": message.content or "", **chat_reasoning}
    if message.role is Role.TOOL:
        if api_mode == "messages":
            return {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": str(message.tool_call_id or "?"),
                    "content": message.content or "",
                    "is_error": bool(message.is_error),
                }],
            }
        return {
            "role": "tool",
            "tool_call_id": str(message.tool_call_id or "?"),
            "content": message.content or "",
        }
    return {"role": "user", "content": message.content or ""}


def _messages_blocks(content: object) -> list[dict[str, Any]]:
    if isinstance(content, list):
        blocks: list[dict[str, Any]] = []
        for block in content:
            if isinstance(block, dict):
                blocks.append(dict(block))
            elif block is not None:
                blocks.append({"type": "text", "text": str(block)})
        return blocks
    if content is None or content == "":
        return []
    return [{"type": "text", "text": str(content)}]


def _merge_messages_entries(entries: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for raw in entries:
        entry = dict(raw)
        content = entry.get("content")
        previous = merged[-1] if merged else None
        if previous is not None and previous.get("role") == entry.get("role"):
            previous["content"] = [
                *_messages_blocks(previous.get("content")),
                *_messages_blocks(content),
            ]
            continue
        if isinstance(content, list):
            entry["content"] = _messages_blocks(content)
        merged.append(entry)
    return merged


def prompt_cache_enabled() -> bool:
    return os.environ.get("MAGIC_POINTER_PROMPT_CACHE", "1").strip().casefold() not in {
        "0", "false", "no", "off",
    }


def _mark_entry_cache_boundary(entry: dict[str, Any]) -> None:
    blocks = _messages_blocks(entry.get("content"))
    if not blocks:
        return
    blocks[-1] = {
        **blocks[-1],
        "cache_control": {"type": "ephemeral"},
    }
    entry["content"] = blocks


def _messages_payload(
    model: str,
    messages: list[AgentMessage],
    tools: list[dict],
    max_tokens: int,
    api_mode: str,
    *,
    system_prompt: str | None = None,
    effort: object | None = None,
) -> dict:
    messages = project_context_messages(messages)
    if api_mode == "responses":
        payload: dict[str, Any] = {
            "model": model,
            "input": _responses_input(messages),
            "max_output_tokens": max(1, int(max_tokens)),
        }
        if system_prompt:
            payload["instructions"] = system_prompt
        converted = _convert_tools(tools, api_mode)
        if converted:
            payload["tools"] = converted
        if effort is not None:
            payload["reasoning"] = {"effort": normalize_effort(effort)}
        return payload
    entries = [_message_entry(message, api_mode) for message in messages]
    converted = _convert_tools(tools, api_mode)
    if api_mode == "messages":
        entries = _merge_messages_entries(entries)
        use_prompt_cache = prompt_cache_enabled()
        payload: dict = {
            "model": model,
            "max_tokens": max(1, int(max_tokens)),
            "thinking": {"type": "disabled"},
            "messages": entries,
        }
        payload.update(native_effort_fields(model, api_mode, effort))
        if system_prompt:
            payload["system"] = (
                [{
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }]
                if use_prompt_cache
                else system_prompt
            )
        if converted:
            if use_prompt_cache:
                converted = [dict(tool) for tool in converted]
                converted[-1]["cache_control"] = {"type": "ephemeral"}
            payload["tools"] = converted
        if use_prompt_cache:
            user_indices = [
                index
                for index, entry in enumerate(entries)
                if entry.get("role") == "user"
            ]
            if user_indices and user_indices[-1] > 0:
                _mark_entry_cache_boundary(entries[user_indices[-1] - 1])
        return payload
    payload = {
        "model": model,
        "max_tokens": max(1, int(max_tokens)),
        "messages": entries,
    }
    if system_prompt:
        payload["messages"] = [
            {"role": "system", "content": system_prompt},
            *payload["messages"],
        ]
    if converted:
        payload["tools"] = converted
        payload["tool_choice"] = "auto"
    if effort is not None:
        payload["reasoning_effort"] = normalize_effort(effort)
    return payload


def _convert_tools(tools: list[dict], api_mode: str) -> list[dict]:
    converted: list[dict] = []
    for raw in tools:
        if not isinstance(raw, dict) or not raw.get("name"):
            continue
        if api_mode == "responses":
            function = raw.get("function") if isinstance(raw.get("function"), dict) else raw
            converted.append({
                "type": "function",
                "name": str(function.get("name") or "tool"),
                "description": str(function.get("description") or ""),
                "parameters": function.get("parameters") or {"type": "object", "properties": {}},
                "strict": False,
            })
        elif api_mode == "messages":
            converted.append({
                "name": str(raw["name"]),
                "description": str(raw.get("description") or ""),
                "input_schema": raw.get("parameters")
                or {"type": "object", "properties": {}},
            })
        else:
            converted.append({
                "type": "function",
                "function": {
                    "name": str(raw["name"]),
                    "description": str(raw.get("description") or ""),
                    "parameters": raw.get("parameters")
                    or {"type": "object", "properties": {}},
                },
            })
    return converted


def _responses_input(messages: list[AgentMessage]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for message in messages:
        content = str(message.content or "")
        if message.role is Role.USER:
            if content:
                items.append({"role": "user", "content": [{"type": "input_text", "text": content}]})
            continue
        if message.role is Role.ASSISTANT:
            items.extend(dict(item) for item in message.provider_items
                         if isinstance(item, dict) and item.get('type') == 'reasoning')
            if content:
                items.append({"role": "assistant", "content": content})
            for call in message.tool_calls:
                items.append({
                    "type": "function_call",
                    "call_id": str(call.get("id") or "call_unknown"),
                    "name": str(call.get("name") or "tool"),
                    "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False),
                })
            continue
        if message.role is Role.TOOL:
            items.append({
                "type": "function_call_output",
                "call_id": str(message.tool_call_id or "call_unknown"),
                "output": content,
            })
    return items or [{"role": "user", "content": [{"type": "input_text", "text": "请基于提供的上下文回答。"}]}]


def _provider_items(payload: object, api_mode: str) -> tuple[dict[str, Any], ...]:
    if api_mode == 'messages' and isinstance(payload, dict):
        return tuple(dict(item) for item in payload.get('content', [])
                     if isinstance(item, dict) and item.get('type') in {'thinking', 'redacted_thinking'})
    if api_mode not in {'responses', 'messages'} and isinstance(payload, dict):
        choices = payload.get('choices') or []
        message = choices[0].get('message') or {} if choices else {}
        if isinstance(message.get('reasoning_content'), str):
            return ({'type': 'chat_reasoning', 'reasoning_content': message['reasoning_content']},)
    return _responses_provider_items(payload)


def _responses_provider_items(payload: object) -> tuple[dict[str, Any], ...]:
    if not isinstance(payload, dict):
        return ()
    output = payload.get("output")
    if not isinstance(output, list):
        return ()
    return tuple(
        dict(item)
        for item in output
        if isinstance(item, dict) and item.get("type") == "reasoning"
    )


class StreamingMessagesBackend(AiClientMessagesBackend):

    used_backend = "magic_pointer.messages_multiturn_streaming"

    def _post_streaming(
        self,
        endpoint: str,
        headers: dict,
        payload: dict,
        budget: float,
        api_mode: str,
        *,
        cancel_scope: object = None,
    ) -> Iterator[ModelTurnEvent]:
        import httpx  # noqa: PLC0415 -- optional transport dependency

        request_payload = payload
        stripped_retry_used = False
        while True:
            if self._client_factory is not None:
                client = self._client_factory(budget)
            else:
                client = _ai_client._httpx_client(httpx, timeout=budget)
            with client, client.stream(
                "POST", endpoint, headers=headers, json=request_payload
            ) as response:
                if 400 <= response.status_code < 500 and not stripped_retry_used:
                    stripped = _ai_client._without_optional_request_fields(
                        request_payload
                    )
                    if stripped is not None:
                        request_payload = stripped
                        stripped_retry_used = True
                        continue
                if response.status_code >= 400:
                    try:
                        error_body = response.read().decode("utf-8", "replace")
                    except Exception:  # noqa: BLE001 -- classification is best-effort
                        error_body = ""
                    if is_context_overflow_error(error_body):
                        yield TurnWithheld(reason=CONTEXT_OVERFLOW_REASON)
                        return
                    yield TurnWithheld(
                        reason=f"backend_error:http_{response.status_code}"
                    )
                    return
                yield from _parse_sse(
                    response.iter_lines(),
                    api_mode=api_mode,
                    cancel_scope=cancel_scope,
                )
                return

    def generate(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None = None,
        cancel_scope: object = None,
    ) -> Iterator[ModelTurnEvent]:
        yield TurnStarted()
        _check_cancelled(cancel_scope)
        api_key, base_url, model = _ai_client.get_ai_config()
        base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        api_mode = _ai_client.get_ai_api_mode(base_url)
        blocked = _ai_client.short_circuit_message(base_url)
        if blocked:
            yield TurnWithheld(reason=f"backend_error:{blocked}")
            yield TurnDone(usage=None, raw_text=None)
            return
        if not api_key and api_mode != "local":
            yield TurnWithheld(reason="backend_error:credential_missing")
            yield TurnDone(usage=None, raw_text=None)
            return
        budget = max(
            _MIN_HTTP_TIMEOUT_S,
            (budget_ms / 1000.0) if budget_ms is not None else self.timeout_s,
        )
        deadline = time.monotonic() + budget
        endpoint = _ai_client._completion_endpoint(base_url, api_mode)
        headers = _ai_client._completion_headers(api_key or "", api_mode, base_url=base_url)
        payload = _messages_payload(
            model, messages, tools, self.max_tokens, api_mode,
            system_prompt=self.system_prompt,
            effort=self.effort,
        )
        payload["stream"] = True
        buffered: list[ModelTurnEvent] = []
        committed = False
        committed_terminal_seen = False
        committed_failure_reason = ""
        try:
            for event in self._post_streaming(
                endpoint,
                headers,
                payload,
                budget,
                api_mode,
                cancel_scope=cancel_scope,
            ):
                if (
                    isinstance(event, TurnWithheld)
                    and event.reason.startswith("backend_error:")
                ):
                    committed_failure_reason = event.reason
                if not committed:
                    buffered.append(event)
                    if isinstance(
                        event,
                        (MessageDelta, ReasoningDelta, ToolCallArrived),
                    ):
                        committed = True
                        yield from buffered
                        buffered.clear()
                    continue
                if isinstance(event, TurnDone):
                    committed_terminal_seen = True
                yield event
        except CancelledError:
            if not committed_terminal_seen:
                raise
        except Exception as exc:  # noqa: BLE001
            if not committed_terminal_seen:
                _ai_client.record_failure(
                    status=None,
                    exception_name=type(exc).__name__,
                    detail=str(exc)[:300],
                    model=model,
                    base_url=base_url,
                )
                if committed:
                    _ai_client.record_note(
                        detail=f"streaming_committed_error:{type(exc).__name__}",
                        model=model,
                        base_url=base_url,
                    )
                    yield TurnWithheld(
                        reason=f"backend_error:{type(exc).__name__}"
                    )
                    yield TurnDone(usage=None, raw_text=None)
                    return
                _ai_client.record_note(
                    detail=f"streaming_fallback:{type(exc).__name__}",
                    model=model,
                    base_url=base_url,
                )
                yield from self._fallback_generate(
                    messages,
                    tools,
                    max(0.0, (deadline - time.monotonic()) * 1000.0),
                    cancel_scope,
                )
                return
        if committed:
            if committed_failure_reason:
                _ai_client.record_failure(
                    status=None,
                    exception_name="StreamError",
                    detail=committed_failure_reason[:300],
                    model=model,
                    base_url=base_url,
                )
                _ai_client.record_note(
                    detail=f"streaming_committed_error:{committed_failure_reason}",
                    model=model,
                    base_url=base_url,
                )
            else:
                _ai_client.record_success(model=model, base_url=base_url)
            return
        backend_failure = next(
            (
                event
                for event in buffered
                if isinstance(event, TurnWithheld)
                and event.reason.startswith("backend_error:")
            ),
            None,
        )
        if backend_failure is not None:
            _ai_client.record_note(
                detail=f"streaming_fallback:{backend_failure.reason}",
                model=model,
                base_url=base_url,
            )
            yield from self._fallback_generate(
                messages,
                tools,
                max(0.0, (deadline - time.monotonic()) * 1000.0),
                cancel_scope,
            )
            return
        has_withheld = any(isinstance(event, TurnWithheld) for event in buffered)
        if not has_withheld:
            _ai_client.record_note(
                detail="streaming_fallback:empty_sse",
                model=model,
                base_url=base_url,
            )
            yield from self._fallback_generate(
                messages,
                tools,
                max(0.0, (deadline - time.monotonic()) * 1000.0),
                cancel_scope,
            )
            return
        _ai_client.record_success(model=model, base_url=base_url)
        yield from buffered

    def _fallback_generate(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None,
        cancel_scope: object,
    ) -> Iterator[ModelTurnEvent]:
        if budget_ms is not None and budget_ms <= 0.0:
            yield TurnWithheld(reason="backend_error:model_request_timeout")
            yield TurnDone(usage=None, raw_text=None)
            return
        for event in super().generate(messages, tools, budget_ms, cancel_scope):
            if isinstance(event, TurnStarted):
                continue
            yield event


def _provider_failure_is_retryable(reason: str) -> bool:

    value = str(reason or "").casefold()
    if not value.startswith("backend_error:"):
        return False
    non_retryable = (
        "credential_missing",
        "auth",
        "http_400",
        "http_401",
        "http_403",
        "quota",
        "insufficient",
        "invalid_request",
        "circuit",
        "余额不足",
        "response_incomplete",
        "content_filter",
    )
    return not any(marker in value for marker in non_retryable)


def _check_cancelled(cancel_scope: object) -> None:
    checker = getattr(cancel_scope, "raise_if_cancelled", None)
    if callable(checker):
        checker()


def _parse_sse(
    lines,
    *,
    api_mode: str = "chat",
    cancel_scope: object = None,
) -> Iterator[ModelTurnEvent]:
    if api_mode == "messages":
        yield from _parse_messages_sse(lines, cancel_scope=cancel_scope)
        return
    if api_mode == "responses":
        yield from _parse_responses_sse(lines, cancel_scope=cancel_scope)
        return
    text_parts: list[str] = []
    saw_reasoning = False
    chat_reasoning_parts: list[str] = []
    pending: dict[int, dict[str, Any]] = {}
    finish_reason: str | None = None
    usage: dict[str, Any] = {}
    for raw in lines:
        _check_cancelled(cancel_scope)
        if not raw:
            continue
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if data == "[DONE]":
            break
        try:
            frame = json.loads(data)
        except ValueError:
            continue
        if isinstance(frame.get("usage"), dict):
            usage.update(frame["usage"])
        choices = frame.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        delta = choice.get("delta") or {}
        if isinstance(delta.get("content"), str) and delta["content"]:
            text_parts.append(delta["content"])
            yield MessageDelta(delta["content"])
        if isinstance(delta.get('reasoning_content'), str):
            chat_reasoning_parts.append(delta['reasoning_content'])
        for reasoning_key in ("reasoning_content", "reasoning"):
            reasoning_value = delta.get(reasoning_key)
            if isinstance(reasoning_value, str) and reasoning_value:
                saw_reasoning = True
                yield ReasoningDelta(reasoning_value)
                break
        for fragment in delta.get("tool_calls") or []:
            index = int(fragment.get("index") or 0)
            slot = pending.setdefault(index, {"id": "", "name": "", "arguments": ""})
            if fragment.get("id"):
                slot["id"] = str(fragment["id"])
            if fragment.get("function", {}).get("name"):
                slot["name"] = str(fragment["function"]["name"])
            if fragment.get("function", {}).get("arguments"):
                slot["arguments"] += str(fragment["function"]["arguments"])
        if choice.get("finish_reason"):
            finish_reason = str(choice["finish_reason"])
    text = "".join(text_parts)
    for index in sorted(pending):
        slot = pending[index]
        if not slot["name"]:
            continue
        try:
            arguments = json.loads(slot["arguments"] or "{}")
        except ValueError:
            arguments = slot["arguments"]
        yield ToolCallArrived(
            call=ToolCall(
                id=slot["id"] or f"call_{index}",
                name=slot["name"],
                arguments=arguments,
            )
        )
    has_tool_call = any(str(slot.get("name") or "") for slot in pending.values())
    if finish_reason == "length":
        yield TurnWithheld(reason="max_output_tokens")
    elif finish_reason is None and (text or has_tool_call or saw_reasoning):
        yield TurnWithheld(reason="max_output_tokens")
    elif saw_reasoning and not text and not has_tool_call:
        yield TurnWithheld(reason="backend_error:empty_response")
    yield TurnDone(usage=usage or None, raw_text=text or None,
        provider_items=({'type': 'chat_reasoning', 'reasoning_content': ''.join(chat_reasoning_parts)},)
        if chat_reasoning_parts else ())


def _parse_responses_sse(
    lines, *, cancel_scope: object = None
) -> Iterator[ModelTurnEvent]:
    text_parts: list[str] = []
    pending: dict[int, dict[str, Any]] = {}
    usage: dict[str, Any] = {}
    terminal: dict[str, Any] | None = None
    provider_items: tuple[dict[str, Any], ...] = ()
    failure = ""
    for raw in lines:
        _check_cancelled(cancel_scope)
        line = str(raw or "").strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if data == "[DONE]":
            break
        try:
            frame = json.loads(data)
        except ValueError:
            continue
        if not isinstance(frame, dict):
            continue
        event_type = str(frame.get("type") or "")
        if event_type == "response.output_text.delta":
            delta = frame.get("delta")
            if isinstance(delta, str) and delta:
                text_parts.append(delta)
                yield MessageDelta(delta)
        elif event_type in {"response.output_item.added", "response.output_item.done"}:
            item = frame.get("item")
            if isinstance(item, dict) and item.get("type") == "function_call":
                index = int(frame.get("output_index") or 0)
                slot = pending.setdefault(index, {"id": "", "name": "", "arguments": ""})
                slot["id"] = str(item.get("call_id") or item.get("id") or slot["id"])
                slot["name"] = str(item.get("name") or slot["name"])
                if item.get("arguments"):
                    slot["arguments"] = str(item["arguments"])
        elif event_type == "response.function_call_arguments.delta":
            index = int(frame.get("output_index") or 0)
            slot = pending.setdefault(index, {"id": "", "name": "", "arguments": ""})
            slot["arguments"] += str(frame.get("delta") or "")
        elif event_type == "response.function_call_arguments.done":
            index = int(frame.get("output_index") or 0)
            slot = pending.setdefault(index, {"id": "", "name": "", "arguments": ""})
            if frame.get("arguments") is not None:
                slot["arguments"] = str(frame["arguments"])
        elif event_type in {"response.completed", "response.incomplete", "response.failed"}:
            response = frame.get("response")
            if isinstance(response, dict):
                terminal = response
                if isinstance(response.get("usage"), dict):
                    usage.update(response["usage"])
                provider_items = _responses_provider_items(response)
                if event_type == "response.failed":
                    error = response.get("error")
                    failure = str(error.get("code") or "response_failed") if isinstance(error, dict) else "response_failed"
        elif event_type == "error":
            failure = str(frame.get("code") or "stream_error")

    text = "".join(text_parts)
    for index in sorted(pending):
        slot = pending[index]
        if not slot["name"]:
            continue
        raw_arguments = slot["arguments"] or "{}"
        try:
            arguments = json.loads(raw_arguments)
        except ValueError:
            arguments = raw_arguments
        yield ToolCallArrived(call=ToolCall(
            id=slot["id"] or f"call_{index}", name=slot["name"], arguments=arguments,
        ))
    failure = failure or _response_failure_reason(terminal, "responses")
    if failure:
        yield TurnWithheld(reason=f"backend_error:{failure}")
    elif _response_hit_token_limit(terminal, "responses") or (terminal is None and (text or pending)):
        yield TurnWithheld(reason="max_output_tokens")
    yield TurnDone(
        usage=usage or None,
        raw_text=text or None,
        provider_items=provider_items,
    )


def _parse_messages_sse(
    lines, *, cancel_scope: object = None
) -> Iterator[ModelTurnEvent]:
    text_parts: list[str] = []
    reasoning_blocks: dict[int, dict[str, Any]] = {}
    saw_reasoning = False
    pending: dict[int, dict[str, Any]] = {}
    usage: dict[str, Any] = {}
    stop_reason: str | None = None
    for raw in lines:
        _check_cancelled(cancel_scope)
        if not raw:
            continue
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if data == "[DONE]":
            break
        try:
            frame = json.loads(data)
        except ValueError:
            continue
        frame_type = str(frame.get("type") or "")
        if frame_type == "error":
            error = frame.get("error")
            error_type = str(error.get("type") or "stream_error") if isinstance(error, dict) else "stream_error"
            yield TurnWithheld(reason=f"backend_error:{error_type}")
            continue
        message = frame.get("message")
        if isinstance(message, dict) and isinstance(message.get("usage"), dict):
            usage.update(message["usage"])
        if isinstance(frame.get("usage"), dict):
            usage.update(frame["usage"])
        delta = frame.get("delta")
        if (
            frame_type == "message_delta"
            and isinstance(delta, dict)
            and delta.get("stop_reason")
        ):
            stop_reason = str(delta["stop_reason"])
        if frame_type == "content_block_start":
            index = int(frame.get("index") or 0)
            block = frame.get("content_block")
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text"):
                value = str(block["text"])
                text_parts.append(value)
                yield MessageDelta(value)
            elif block.get("type") == "thinking":
                reasoning_blocks[index] = dict(block)
                if block.get("thinking"):
                    value = str(block["thinking"])
                    saw_reasoning = True
                    yield ReasoningDelta(value)
            elif block.get('type') == 'redacted_thinking':
                reasoning_blocks[index] = dict(block)
            elif block.get("type") == "tool_use":
                initial = block.get("input")
                pending[index] = {
                    "id": str(block.get("id") or ""),
                    "name": str(block.get("name") or ""),
                    "arguments": (
                        json.dumps(initial, ensure_ascii=False)
                        if isinstance(initial, dict) and initial
                        else ""
                    ),
                }
            continue
        if frame_type != "content_block_delta":
            continue
        index = int(frame.get("index") or 0)
        delta = frame.get("delta")
        if not isinstance(delta, dict):
            continue
        if delta.get("type") == "text_delta" and delta.get("text"):
            value = str(delta["text"])
            text_parts.append(value)
            yield MessageDelta(value)
        elif delta.get("type") == "thinking_delta":
            if delta.get("thinking"):
                value = str(delta["thinking"])
                saw_reasoning = True
                block = reasoning_blocks.setdefault(index, {'type': 'thinking', 'thinking': ''})
                block['thinking'] = str(block.get('thinking') or '') + value
                yield ReasoningDelta(value)
        elif delta.get('type') == 'signature_delta' and index in reasoning_blocks:
            block = reasoning_blocks[index]
            block['signature'] = str(block.get('signature') or '') + str(delta.get('signature') or '')
        elif delta.get("type") == "input_json_delta":
            slot = pending.setdefault(
                index, {"id": "", "name": "", "arguments": ""}
            )
            slot["arguments"] += str(delta.get("partial_json") or "")

    text = "".join(text_parts)
    for index in sorted(pending):
        slot = pending[index]
        if not slot["name"]:
            continue
        raw_arguments = slot["arguments"] or "{}"
        try:
            arguments = json.loads(raw_arguments)
        except ValueError:
            arguments = raw_arguments
        yield ToolCallArrived(call=ToolCall(
            id=slot["id"] or f"call_{index}",
            name=slot["name"],
            arguments=arguments,
        ))
    has_tool_call = any(str(slot.get("name") or "") for slot in pending.values())
    if stop_reason == "max_tokens":
        yield TurnWithheld(reason="max_output_tokens")
    elif stop_reason is None and (text or has_tool_call or saw_reasoning):
        yield TurnWithheld(reason="max_output_tokens")
    elif saw_reasoning and not text and not has_tool_call:
        yield TurnWithheld(reason="backend_error:empty_response")
    yield TurnDone(usage=usage or None, raw_text=text or None,
                   provider_items=tuple(reasoning_blocks[index] for index in sorted(reasoning_blocks)))


def _serialize_messages(messages: list[AgentMessage]) -> str:
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
