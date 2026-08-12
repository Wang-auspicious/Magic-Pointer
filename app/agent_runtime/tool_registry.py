"""Agent runtime tool registry (harness loop batch, plan T2.2).

Replaces the executor string if/elif dispatch with a declarative registry
aligned to the Claude Code toolExecution/toolOrchestration port note
(``docs/harness-port-notes/2026-08-12-cc-tool-execution.md``) and the Kimi CU
tool contract note (``docs/harness-port-notes/2026-08-12-kimi-cu-tools.md``):

- ``ToolSpec`` mirrors the CC tool contract, trimmed: name / description /
  input_schema (JSON Schema style, validated structure) / effect /
  is_concurrency_safe (fail-closed False, CC ``isConcurrencySafe``) /
  used_backend (honest reporting, Kimi CU) / execute / timeout_ms.
- ``schemas_for_model`` emits the CC API ``tools`` parameter shape
  (name + description + parameters=input_schema).
- ``concurrency_partition`` mirrors CC ``partitionToolCalls``: safe tools may
  be batched in parallel, unsafe tools stay sequential, input order is
  preserved within each list.
- ``execute_tool`` returns a structured :class:`ToolResult` instead of
  raising tool failures to the caller: ActionFailure passes its
  ``failure_type`` through, any other exception is wrapped as
  ``FailureType.TOOL_ERROR`` (CC ``is_error:true`` tool_result semantics).

``ActionFailure``/``FailureType`` come from ``app.agent_runtime.errors``
(plan T2.1). That module is produced by a parallel swarm agent; until it
lands this module carries a mirrored fallback with the documented failure
vocabulary (stale_anchor / focus_lost / content_changed / blocked_by_modal /
permission_denied / timeout / tool_error) so the registry works standalone.
Once ``errors.py`` exists the import takes precedence.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

import enum
import re
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from app.action_guard.preconditions import Precondition

try:
    from app.agent_runtime.errors import ActionFailure, FailureType  # plan T2.1
except ImportError:  # B2.1 parallel agent has not landed yet; see module docstring
    class FailureType(enum.StrEnum):
        STALE_ANCHOR = "stale_anchor"
        FOCUS_LOST = "focus_lost"
        CONTENT_CHANGED = "content_changed"
        BLOCKED_BY_MODAL = "blocked_by_modal"
        PERMISSION_DENIED = "permission_denied"
        TIMEOUT = "timeout"
        TOOL_ERROR = "tool_error"

    class ActionFailure(Exception):
        """Structured action failure carrying a :class:`FailureType`."""

        def __init__(
            self,
            failure_type: FailureType,
            message: str = "",
            recovery_hint: str | None = None,
        ) -> None:
            super().__init__(message)
            self.failure_type = failure_type
            self.message = message
            self.recovery_hint = recovery_hint


class Effect(enum.StrEnum):
    """Side-effect class of a tool, from most to least benign."""

    READ = "read"
    REVERSIBLE_WRITE = "reversible_write"
    LOCAL_IRREVERSIBLE = "local_irreversible"
    EXTERNAL_SEND = "external_send"
    DESTRUCTIVE = "destructive"
    PURCHASE = "purchase"


_NAME_PATTERN = re.compile(r"[a-z0-9_]+")


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """Static declaration of one tool (CC Tool.ts trimmed contract).

    Validation happens at registration time in :class:`ToolRegistry`; the
    dataclass itself is a frozen value carrier.
    """

    name: str
    description: str
    input_schema: dict[str, object]
    execute: Callable[..., Any]
    effect: Effect = Effect.READ
    is_concurrency_safe: bool = False
    used_backend: str = "local"
    timeout_ms: int = 30000
    preconditions: tuple[Precondition, ...] = ()


@dataclass(frozen=True, slots=True)
class ToolResult:
    """Structured result of one tool execution (CC is_error tool_result).

    ``is_error=False`` on success. On failure ``failure_type`` carries the
    FailureType (ActionFailure passthrough, otherwise ``TOOL_ERROR``) and
    ``value`` is ``None``. ``used_backend``/``latency_ms`` are always
    recorded (Kimi CU honest reporting).
    """

    value: Any = None
    is_error: bool = False
    failure_type: FailureType | None = None
    error_message: str | None = None
    used_backend: str | None = None
    latency_ms: float | None = None


class ToolRegistry:
    """Registered tool store with validation, schema export and execution.

    Registration order is preserved by :meth:`list`. Duplicate names and
    malformed specs are rejected at registration time (fail closed).
    """

    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}
        self._order: list[str] = []

    def register(self, spec: ToolSpec) -> ToolSpec:
        """Register ``spec``; raises on invalid spec or duplicate name."""
        if not isinstance(spec, ToolSpec):
            raise TypeError(f"register expects ToolSpec, got {type(spec).__name__}")
        name = spec.name
        if name in self._tools:
            raise ValueError(f"tool {name!r} is already registered")
        if not isinstance(name, str) or not _NAME_PATTERN.fullmatch(name):
            raise ValueError(
                f"invalid tool name {name!r}: must match [a-z0-9_]+"
            )
        if not isinstance(spec.description, str):
            raise ValueError(f"tool {name!r} description must be a str")
        self._validate_schema(spec.input_schema, name)
        if not isinstance(spec.effect, Effect):
            raise ValueError(
                f"tool {name!r} effect must be an Effect member, got {spec.effect!r}"
            )
        if not isinstance(spec.is_concurrency_safe, bool):
            raise ValueError(f"tool {name!r} is_concurrency_safe must be a bool")
        if not isinstance(spec.used_backend, str) or not spec.used_backend:
            raise ValueError(f"tool {name!r} used_backend must be a non-empty str")
        if not callable(spec.execute):
            raise ValueError(f"tool {name!r} execute must be callable")
        if not isinstance(spec.timeout_ms, int) or spec.timeout_ms <= 0:
            raise ValueError(f"tool {name!r} timeout_ms must be a positive int")
        if not all(callable(getattr(p, "check", None)) for p in spec.preconditions):
            raise ValueError(
                f"tool {name!r} preconditions must be Precondition objects "
                "with a check(context) method"
            )
        self._tools[name] = spec
        self._order.append(name)
        return spec

    @staticmethod
    def _validate_schema(schema: object, name: str) -> None:
        if not isinstance(schema, dict):
            raise ValueError(f"tool {name!r} input_schema must be a dict")
        if schema.get("type") != "object":
            raise ValueError(f"tool {name!r} input_schema type must be 'object'")
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            raise ValueError(f"tool {name!r} input_schema properties must be a dict")
        if not all(isinstance(p, dict) for p in properties.values()):
            raise ValueError(
                f"tool {name!r} input_schema property entries must be dicts"
            )
        required = schema.get("required")
        if not isinstance(required, list) or not all(
            isinstance(r, str) for r in required
        ):
            raise ValueError(
                f"tool {name!r} input_schema required must be a list of str"
            )

    def get(self, name: str) -> ToolSpec:
        """Return the spec for ``name``; :class:`KeyError` when unknown."""
        return self._tools[name]

    def list(self) -> tuple[ToolSpec, ...]:
        """All registered specs in registration order."""
        return tuple(self._tools[n] for n in self._order)

    def schemas_for_model(self) -> list[dict[str, object]]:
        """Emit specs in CC API ``tools`` parameters format.

        Each entry is ``{"name", "description", "parameters": input_schema}``
        (query.ts calls the model with these as the ``tools`` argument).
        """
        return [
            {
                "name": spec.name,
                "description": spec.description,
                "parameters": spec.input_schema,
            }
            for spec in self.list()
        ]

    def validate_input(self, spec: ToolSpec, args: dict[str, object]) -> list[str]:
        """Strictly validate ``args`` against ``spec.input_schema``.

        Returns a list of human-readable errors; an empty list means valid.
        Checks missing required fields, extra fields and JSON Schema type
        mismatches. Raises :class:`TypeError` when ``args`` is not a dict.
        """
        if not isinstance(args, dict):
            raise TypeError(f"args must be a dict, got {type(args).__name__}")
        schema = spec.input_schema
        properties = schema["properties"]
        errors: list[str] = []
        for field_name in schema["required"]:
            if field_name not in args:
                errors.append(f"missing required field {field_name!r}")
        for field_name, value in args.items():
            if field_name not in properties:
                errors.append(f"unexpected field {field_name!r}")
                continue
            prop = properties[field_name]
            type_name = prop.get("type") if isinstance(prop, dict) else None
            if type_name is not None:
                ok = _matches_json_schema_type(value, type_name)
                if ok is False:
                    errors.append(
                        f"field {field_name!r} expects type {type_name!r}, "
                        f"got {type(value).__name__}"
                    )
        return errors

    def concurrency_partition(
        self, tool_names: Iterable[str]
    ) -> tuple[list[str], list[str]]:
        """Partition tool names for execution (CC partitionToolCalls).

        Tools with ``is_concurrency_safe`` are collected in ``parallel`` (may
        be batched), the rest in ``sequential`` (must keep input order, one
        at a time). Order within each list matches the input order. Unknown
        names raise :class:`KeyError`.
        """
        parallel: list[str] = []
        sequential: list[str] = []
        for name in tool_names:
            spec = self.get(name)
            (parallel if spec.is_concurrency_safe else sequential).append(name)
        return parallel, sequential

    def execute_tool(
        self, name: str, args: dict[str, object], scope: object = None
    ) -> ToolResult:
        """Execute the registered tool and wrap the outcome.

        Unknown tool -> :class:`KeyError` (registry lookup, not a tool
        failure). Tool exceptions are never re-raised: ActionFailure passes
        its ``failure_type`` through, any other exception is wrapped as
        ``FailureType.TOOL_ERROR``. ``used_backend`` and ``latency_ms`` are
        recorded on every result. When ``scope`` is not None it is forwarded
        to ``execute`` as a keyword argument.
        """
        spec = self.get(name)
        started = time.perf_counter()

        def result(value: Any, is_error: bool, **extra: object) -> ToolResult:
            return ToolResult(
                value=value,
                is_error=is_error,
                used_backend=spec.used_backend,
                latency_ms=(time.perf_counter() - started) * 1000.0,
                **extra,
            )

        try:
            if scope is None:
                value = spec.execute(**args)
            else:
                value = spec.execute(scope=scope, **args)
        except ActionFailure as exc:
            return result(
                None,
                True,
                failure_type=exc.failure_type,
                error_message=f"Error calling tool ({name}): {exc}",
            )
        except Exception as exc:
            return result(
                None,
                True,
                failure_type=FailureType.TOOL_ERROR,
                error_message=f"Error calling tool ({name}): {exc}",
            )
        return result(value, False)


def _matches_json_schema_type(value: object, type_name: object) -> bool | None:
    """Check ``value`` against a JSON Schema primitive type.

    Returns True/False for known types, None for unknown type names (no
    check possible). ``bool`` is deliberately not an ``integer``/``number``.
    """
    if type_name == "string":
        return isinstance(value, str)
    if type_name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if type_name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if type_name == "boolean":
        return isinstance(value, bool)
    if type_name == "array":
        return isinstance(value, list)
    if type_name == "object":
        return isinstance(value, dict)
    if type_name == "null":
        return value is None
    return None


GLOBAL_REGISTRY = ToolRegistry()
"""Process-wide singleton registry (module-level, per plan T2.2)."""
