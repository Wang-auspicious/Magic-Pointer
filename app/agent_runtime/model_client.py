"""Agent runtime loop model client (harness loop batch, plan T2.3).

Ported semantics from the CC query-loop and Pi agent-loop study notes
(``docs/harness-port-notes/2026-08-12-cc-query-loop.md``,
``docs/harness-port-notes/2026-08-12-pi-agent-loop.md``):

- ``ModelTurnEvent`` union: the per-turn model stream is a discriminated
  union of frozen dataclasses, discriminated via ``isinstance`` (the Python
  form of the CC ``StreamEvent`` union; the loop layer consumes the list
  returned by :meth:`LoopModelClient.generate_turn`).
- CC withhold-until-recover: output-token ``TurnWithheld`` is passed to the
  semantic loop, whose recovery ceiling is
  ``MAX_OUTPUT_TOKENS_RECOVERY_LIMIT``. Provider/backend failures are a
  different layer: retryable failures repeat the unchanged request below the
  agent loop; exhausted or non-retryable failures surface once as
  ``TurnWithheld(reason="backend_error:...")`` and never become fake user
  messages or additional semantic turns.
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
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Protocol

from app import ai_client as _ai_client
from app.agent_runtime.errors import MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
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
    "StreamingMessagesBackend",
    "ToolCallArrived",
    "TurnDone",
    "TurnStarted",
    "TurnWithheld",
]

_DEFAULT_TRUNCATION_SUFFIX = "…"
_MIN_HTTP_TIMEOUT_S = 0.05


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
        self.last_truncated = False
        self.last_errors: list[str] = []
        self.withheld_count = 0
        self._reserved_call_ids: set[str] = set()
        self._next_synthetic_call_id = 0

    @property
    def used_backend(self) -> str:
        """Stable, non-secret identity of the backend that executes turns."""
        declared = str(getattr(self._backend, "used_backend", "") or "").strip()
        if declared:
            return declared
        backend_type = type(self._backend)
        return f"{backend_type.__module__}.{backend_type.__qualname__}"

    def generate_turn(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None = None,
        cancel_scope: object = None,
    ) -> list[ModelTurnEvent]:
        """Consume the backend generator; events come back untouched.

        Output-token ``TurnWithheld`` events are passed through as-is and the
        loop owns their recovery ceiling. Retryable ``backend_error`` events
        cause this client to repeat the exact same request up to
        ``max_provider_retries``; they do not consume agent turns or mutate
        messages. ``last_usage`` is reset per turn and set from each
        ``TurnDone``.
        """
        self.last_usage = None
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
                    return [
                        TurnWithheld(
                            reason="backend_error:model_request_timeout"
                        ),
                        TurnDone(usage=None, raw_text=None),
                    ]
            events: list[ModelTurnEvent] = []
            try:
                for event in self._backend.generate(
                    messages, tools, attempt_budget_ms, cancel_scope
                ):
                    if isinstance(event, TurnWithheld):
                        self.withheld_count += 1
                    elif isinstance(event, TurnDone):
                        self.last_usage = event.usage
                    events.append(event)
            except CancelledError:
                raise
            except Exception as exc:  # third-party model adapter seam
                events = [
                    TurnWithheld(reason=f"backend_error:{type(exc).__name__}"),
                    TurnDone(usage=None, raw_text=None),
                ]
            _check_cancelled(cancel_scope)
            backend_failures = [
                event.reason
                for event in events
                if isinstance(event, TurnWithheld)
                and event.reason.startswith("backend_error:")
            ]
            retryable = bool(backend_failures) and all(
                _provider_failure_is_retryable(reason)
                for reason in backend_failures
            )
            if not retryable or attempt >= self.max_provider_retries:
                return events
            attempt += 1
            retry_delay_s = 0.25 * (2 ** (attempt - 1))
            if (
                deadline is not None
                and self._retry_clock() + retry_delay_s >= deadline
            ):
                return events
            self._retry_sleeper(retry_delay_s)
            _check_cancelled(cancel_scope)

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
        """Keep provider ids when safe; synthesize a conversation-unique id."""
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


def _normalize_call(call: ToolCall, errors: list[str]) -> ToolCall | None:
    """Return ``call`` with dict arguments, or None with an error recorded.

    Backends may pre-parse arguments into a dict or pass the raw JSON
    string through; anything else is malformed and fail-closed.
    """
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


class AiClientMessagesBackend:
    """Real multi-turn backend: the loop's history as a native messages array.

    The gateway receives the full message list (chat-completions or
    Anthropic-style messages protocol, auto-detected from the base URL):
    instruction user messages and harness-injected data messages project to
    ``user`` entries, assistant text to ``assistant`` entries, and tool
    results to their native OpenAI ``tool`` / Anthropic ``tool_result``
    shapes, paired with the assistant tool-call ids preserved in loop state.

    Honest limitations (same class of gaps as :class:`AiClientBackend`):
    - Non-streaming: one HTTP round trip per turn.
    - ``cancel_scope`` is accepted but not enforced (synchronous call).
    - The gateway protocol reports no usage; ``TurnDone.usage`` is None.
    - A request-level timeout is reported as a withheld
      ``backend_error:model_request_timeout`` without poisoning endpoint
      health; other failures record health per endpoint.
    """

    used_backend = "magic_pointer.messages_multiturn"

    def __init__(
        self,
        *,
        timeout_s: float = 20.0,
        max_tokens: int = 240,
        system_prompt: str | None = None,
    ) -> None:
        self.timeout_s = max(_MIN_HTTP_TIMEOUT_S, float(timeout_s))
        self.max_tokens = max(1, int(max_tokens))
        self.system_prompt = (
            system_prompt.strip() if system_prompt and system_prompt.strip() else None
        )
        self._client_factory = None

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
        blocked = _ai_client.short_circuit_message(base_url)
        if blocked:
            yield TurnWithheld(reason=f"backend_error:{blocked}")
            yield TurnDone(usage=None, raw_text=None)
            return
        if not api_key:
            yield TurnWithheld(reason="backend_error:credential_missing")
            yield TurnDone(usage=None, raw_text=None)
            return
        budget = max(
            _MIN_HTTP_TIMEOUT_S,
            (budget_ms / 1000.0) if budget_ms is not None else self.timeout_s,
        )
        api_mode = _ai_client.get_ai_api_mode(base_url)
        endpoint = _ai_client._completion_endpoint(base_url, api_mode)
        headers = _ai_client._completion_headers(api_key, api_mode)
        payload = _messages_payload(
            model,
            messages,
            tools,
            self.max_tokens,
            api_mode,
            system_prompt=self.system_prompt,
        )
        try:
            import httpx  # noqa: PLC0415 -- optional transport dependency

            if self._client_factory is not None:
                client = self._client_factory(budget)
            else:
                client = _ai_client._httpx_client(httpx, timeout=budget)
            with client:
                response = client.post(endpoint, headers=headers, json=payload)
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
        )


def _response_hit_token_limit(payload: object, api_mode: str) -> bool:
    """Read the native non-streaming completion reason without guessing."""
    if not isinstance(payload, dict):
        return False
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


def _message_entry(message: AgentMessage, api_mode: str) -> dict:
    """Project one loop message into a gateway messages-array entry.

    Assistant messages carrying tool_calls emit the API-native shape
    (chat-completions ``tool_calls`` / messages ``tool_use`` blocks) and tool
    results emit the native ``tool`` role / ``tool_result`` block so
    multi-turn tool history round-trips through the gateway (T4.2).
    """
    if message.role is Role.ASSISTANT:
        if message.tool_calls:
            if api_mode == "messages":
                blocks: list[dict] = []
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
        return {"role": "assistant", "content": message.content or ""}
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


def _messages_payload(
    model: str,
    messages: list[AgentMessage],
    tools: list[dict],
    max_tokens: int,
    api_mode: str,
    *,
    system_prompt: str | None = None,
) -> dict:
    entries = [_message_entry(message, api_mode) for message in messages]
    converted = _convert_tools(tools, api_mode)
    if api_mode == "messages":
        payload: dict = {
            "model": model,
            "max_tokens": max(1, int(max_tokens)),
            "thinking": {"type": "disabled"},
            "messages": entries,
        }
        if system_prompt:
            payload["system"] = system_prompt
        if converted:
            payload["tools"] = converted
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
    return payload


def _convert_tools(tools: list[dict], api_mode: str) -> list[dict]:
    """Convert the loop's tool-schema shape into the gateway protocol shape."""
    converted: list[dict] = []
    for raw in tools:
        if not isinstance(raw, dict) or not raw.get("name"):
            continue
        if api_mode == "messages":
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


class StreamingMessagesBackend(AiClientMessagesBackend):
    """Streaming variant: SSE chunks are parsed into MessageDelta events.

    Same payload contract as :class:`AiClientMessagesBackend` plus
    ``"stream": true``; ``data: {...}`` lines accumulate
    ``choices[0].delta.content`` and ``delta.tool_calls`` until
    ``finish_reason`` arrives. The real-endpoint verification is a
    真机 item; the parser is fully covered by fake chunk sequences.
    """

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
    ) -> list[ModelTurnEvent]:
        import httpx  # noqa: PLC0415 -- optional transport dependency

        if self._client_factory is not None:
            client = self._client_factory(budget)
        else:
            client = _ai_client._httpx_client(httpx, timeout=budget)
        with client, client.stream(
            "POST", endpoint, headers=headers, json=payload
        ) as response:
            if response.status_code >= 400:
                return [
                    TurnWithheld(reason=f"backend_error:http_{response.status_code}")
                ]
            return _parse_sse(
                response.iter_lines(),
                api_mode=api_mode,
                cancel_scope=cancel_scope,
            )

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
        blocked = _ai_client.short_circuit_message(base_url)
        if blocked:
            yield TurnWithheld(reason=f"backend_error:{blocked}")
            yield TurnDone(usage=None, raw_text=None)
            return
        if not api_key:
            yield TurnWithheld(reason="backend_error:credential_missing")
            yield TurnDone(usage=None, raw_text=None)
            return
        budget = max(
            _MIN_HTTP_TIMEOUT_S,
            (budget_ms / 1000.0) if budget_ms is not None else self.timeout_s,
        )
        deadline = time.monotonic() + budget
        api_mode = _ai_client.get_ai_api_mode(base_url)
        endpoint = _ai_client._completion_endpoint(base_url, api_mode)
        headers = _ai_client._completion_headers(api_key, api_mode)
        payload = _messages_payload(
            model, messages, tools, self.max_tokens, api_mode,
            system_prompt=self.system_prompt,
        )
        payload["stream"] = True
        try:
            events = self._post_streaming(
                endpoint,
                headers,
                payload,
                budget,
                api_mode,
                cancel_scope=cancel_scope,
            )
        except CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _ai_client.record_failure(
                status=None,
                exception_name=type(exc).__name__,
                detail=str(exc)[:300],
                model=model,
                base_url=base_url,
            )
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
        if _stream_looks_empty(events):
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
        backend_failure = next(
            (
                event
                for event in events
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
        _ai_client.record_success(model=model, base_url=base_url)
        yield from events

    def _fallback_generate(
        self,
        messages: list[AgentMessage],
        tools: list[dict],
        budget_ms: float | None,
        cancel_scope: object,
    ) -> Iterator[ModelTurnEvent]:
        """One non-streaming retry via the parent backend (auto-degrade).

        The parent records its own health; the loop sees the same event
        vocabulary, so a successful fallback is indistinguishable from a
        successful stream (except ``used_backend``).
        """
        if budget_ms is not None and budget_ms <= 0.0:
            yield TurnWithheld(reason="backend_error:model_request_timeout")
            yield TurnDone(usage=None, raw_text=None)
            return
        for event in super().generate(messages, tools, budget_ms, cancel_scope):
            if isinstance(event, TurnStarted):
                continue
            yield event


def _stream_looks_empty(events: list[ModelTurnEvent]) -> bool:
    """True when the SSE pass produced no text, no tool calls and no
    withheld — the gateway ignored ``stream: true`` or sent a foreign
    content type. A real model that says nothing still produces a
    ``finish_reason`` frame; here we cannot distinguish, so a genuinely
    empty answer costs one extra non-streaming round trip."""
    if any(isinstance(event, TurnWithheld) for event in events):
        return False
    text = "".join(
        event.text for event in events if isinstance(event, MessageDelta)
    )
    has_calls = any(isinstance(event, ToolCallArrived) for event in events)
    return not text and not has_calls


def _provider_failure_is_retryable(reason: str) -> bool:
    """Classify request failures for retries below the semantic agent loop."""

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
) -> list[ModelTurnEvent]:
    """Parse an SSE line iterator into loop model events.

    OpenAI chat-completions and Anthropic messages streams share the same
    event vocabulary on output. Comment/event-name/keep-alive lines are
    skipped; fragmented tool arguments stay raw when malformed so the loop
    can return a structured correction instead of silently dropping a call.
    """
    if api_mode == "messages":
        return _parse_messages_sse(lines, cancel_scope=cancel_scope)
    text_parts: list[str] = []
    pending: dict[int, dict[str, Any]] = {}
    events: list[ModelTurnEvent] = []
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
    if text:
        events.append(MessageDelta(text))
    for index in sorted(pending):
        slot = pending[index]
        if not slot["name"]:
            continue
        try:
            arguments = json.loads(slot["arguments"] or "{}")
        except ValueError:
            arguments = slot["arguments"]
        events.append(ToolCallArrived(
            call=ToolCall(
                id=slot["id"] or f"call_{index}",
                name=slot["name"],
                arguments=arguments,
            )
        ))
    if finish_reason == "length":
        events.append(TurnWithheld(reason="max_output_tokens"))
    events.append(TurnDone(usage=usage or None, raw_text=text or None))
    return events


def _parse_messages_sse(
    lines, *, cancel_scope: object = None
) -> list[ModelTurnEvent]:
    """Parse Anthropic Messages SSE frames into the common turn events."""
    text_parts: list[str] = []
    pending: dict[int, dict[str, Any]] = {}
    usage: dict[str, Any] = {}
    events: list[ModelTurnEvent] = []
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
            events.append(TurnWithheld(reason=f"backend_error:{error_type}"))
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
                text_parts.append(str(block["text"]))
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
            text_parts.append(str(delta["text"]))
        elif delta.get("type") == "input_json_delta":
            slot = pending.setdefault(
                index, {"id": "", "name": "", "arguments": ""}
            )
            slot["arguments"] += str(delta.get("partial_json") or "")

    text = "".join(text_parts)
    if text:
        events.append(MessageDelta(text))
    for index in sorted(pending):
        slot = pending[index]
        if not slot["name"]:
            continue
        raw_arguments = slot["arguments"] or "{}"
        try:
            arguments = json.loads(raw_arguments)
        except ValueError:
            arguments = raw_arguments
        events.append(ToolCallArrived(call=ToolCall(
            id=slot["id"] or f"call_{index}",
            name=slot["name"],
            arguments=arguments,
        )))
    if stop_reason == "max_tokens":
        events.append(TurnWithheld(reason="max_output_tokens"))
    events.append(TurnDone(usage=usage or None, raw_text=text or None))
    return events


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
