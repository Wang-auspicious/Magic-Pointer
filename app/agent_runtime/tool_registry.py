"""Agent runtime tool registry (harness loop batch, plan T2.2).

Replaces the executor string if/elif dispatch with a declarative registry
aligned to the Claude Code toolExecution/toolOrchestration port note
(``docs/harness-port-notes/2026-08-12-cc-tool-execution.md``) and the Kimi CU
tool contract note (``docs/harness-port-notes/2026-08-12-kimi-cu-tools.md``):

- ``ToolSpec`` mirrors the CC/Kimi tool contract: name / description /
  input_schema (JSON Schema style, validated structure) / effect /
  is_concurrency_safe (fail-closed False, CC ``isConcurrencySafe``) /
  resource_keys (Kimi-style static or argument-derived conflict ownership) /
  used_backend (honest reporting) / execute / timeout_ms.
- ``schemas_for_model`` emits the CC API ``tools`` parameter shape
  (name + description + parameters=input_schema).
- ``concurrency_partition`` mirrors CC ``partitionToolCalls``: safe tools may
  be batched in parallel, unsafe tools stay sequential, input order is
  preserved within each list.
- ``execute_tool`` returns a structured :class:`ToolResult` instead of
  raising tool failures to the caller: ActionFailure passes its
  ``failure_type`` through, any other exception is wrapped as
  ``FailureType.TOOL_ERROR`` (CC ``is_error:true`` tool_result semantics).

``ActionFailure``/``FailureType`` have one canonical definition in
``app.agent_runtime.errors`` so callers never compare members from two
look-alike enum classes.

This module is pure Python and has no I/O or platform dependencies.
"""

from __future__ import annotations

import enum
import math
import json
import re
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover - annotation-only
    from app.action_guard.preconditions import Precondition

from app.agent_runtime.errors import ActionFailure, FailureType


class Effect(enum.StrEnum):
    """Side-effect class of a tool, from most to least benign."""

    READ = "read"
    REVERSIBLE_WRITE = "reversible_write"
    LOCAL_IRREVERSIBLE = "local_irreversible"
    EXTERNAL_SEND = "external_send"
    DESTRUCTIVE = "destructive"
    PURCHASE = "purchase"


_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
"""CC 风格工具名（Read/Edit/Bash/Observe…）允许大写驼峰；下划线蛇形
保留作旧名别名兼容（一个版本）。"""

_WORD_SPLIT = re.compile(r"[a-z0-9_]+")

FIND_CAPABILITY_TOOL = "Tools"
"""Canonical name of the capability search tool (CC ToolSearch pattern);
the loop reads its result to load deferred tool schemas into the next round."""

_RESERVED_ARGUMENT_NAMES = frozenset({"scope"})
"""Input-schema property names that collide with the harness-side execution
keyword (``execute_tool`` forwards the cancellation token as ``scope=``)."""


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
    effect_for: Callable[[dict[str, object]], Effect] | None = None
    is_concurrency_safe: bool = False
    is_concurrency_safe_for: Callable[[dict[str, object]], bool] | None = None
    """按调用判并发（CC isConcurrencySafe(input) 同型）：只读子代理
    （delegate readonly=true）可进并行车道，写子代理保持串行。误抛异常
    按 False 处理（并发判定误真会写冲突，误假只损失并行）。"""
    used_backend: str = "local"
    timeout_ms: int = 30000
    resource_keys: tuple[str, ...] | Callable[[dict[str, object]], Iterable[str]] = ()
    verify_result: Callable[[Any], None] | None = None
    discovers_tools: bool = False
    suspends_for_user_input: bool = False
    deferred: bool = False
    """Codex ToolExposure::Deferred: absent from the model's initial tool
    list; discoverable through the search tool (find_capability), which the
    loop turns into next-round schemas. Core tools stay direct."""
    examples: tuple[dict[str, object], ...] = ()
    """CC prompt_sample / Codex examples: one concrete usage per tool,
    surfaced verbatim in the schema so the model does not burn a round
    guessing ARGUMENT shapes (roadmap §1.1)."""
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


def spec_effect(spec: ToolSpec, arguments: Mapping[str, object] | None) -> Effect:
    """按调用解析效果（CC isDestructive(input) 契约）。

    ``effect_for`` 在场且正常返回 Effect 时覆盖静态档；返回非 Effect 或抛错
    一律回落静态档（静态声明是注册时校验过的底线，误分类的调用按工具的
    声明档处理，不让权限链被实现 bug 炸掉）。
    """
    if spec.effect_for is None:
        return spec.effect
    try:
        resolved = spec.effect_for(dict(arguments or {}))
    except Exception:  # noqa: BLE001 - 分类器崩溃回落静态档
        return spec.effect
    return resolved if isinstance(resolved, Effect) else spec.effect


class ToolRegistry:
    """Registered tool store with validation, schema export and execution.

    Registration order is preserved by :meth:`list`. Duplicate names and
    malformed specs are rejected at registration time (fail closed).
    """

    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}
        self._order: list[str] = []
        self._aliases: dict[str, str] = {}
        self._execution_listeners: list[Callable[[str], None]] = []
        self._session_end_listeners: list[Callable[[], None]] = []

    def register_alias(self, alias: str, canonical: str) -> None:
        """旧名 → 新名兼容（一个版本）：模型/historical 权限授权/旧测试
        用旧名仍路由到规范工具。别名绝不进 schema（schemas_for_model 走
        list()，只出规范名）。"""
        alias = str(alias).strip()
        if not _NAME_PATTERN.fullmatch(alias):
            raise ValueError(f"invalid tool alias {alias!r}: must match tool name pattern")
        if alias in self._tools:
            raise ValueError(f"alias {alias!r} collides with a registered tool")
        self._aliases[alias] = canonical

    def canonical_name(self, name: str) -> str:
        return self._aliases.get(name, name)

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
        if spec.effect_for is not None and not callable(spec.effect_for):
            raise ValueError(f"tool {name!r} effect_for must be callable when set")
        if not isinstance(spec.is_concurrency_safe, bool):
            raise ValueError(f"tool {name!r} is_concurrency_safe must be a bool")
        if spec.is_concurrency_safe_for is not None and not callable(
            spec.is_concurrency_safe_for
        ):
            raise ValueError(
                f"tool {name!r} is_concurrency_safe_for must be callable when set"
            )
        if not isinstance(spec.used_backend, str) or not spec.used_backend:
            raise ValueError(f"tool {name!r} used_backend must be a non-empty str")
        if not callable(spec.execute):
            raise ValueError(f"tool {name!r} execute must be callable")
        if not isinstance(spec.timeout_ms, int) or spec.timeout_ms <= 0:
            raise ValueError(f"tool {name!r} timeout_ms must be a positive int")
        if not callable(spec.resource_keys):
            self._validate_resource_keys(spec.resource_keys, name)
        if spec.verify_result is not None and not callable(spec.verify_result):
            raise ValueError(
                f"tool {name!r} verify_result must be callable when set"
            )
        if not isinstance(spec.discovers_tools, bool):
            raise ValueError(f"tool {name!r} discovers_tools must be a bool")
        if not isinstance(spec.suspends_for_user_input, bool):
            raise ValueError(
                f"tool {name!r} suspends_for_user_input must be a bool"
            )
        if not all(callable(getattr(p, "check", None)) for p in spec.preconditions):
            raise ValueError(
                f"tool {name!r} preconditions must be Precondition objects "
                "with a check(context) method"
            )
        self._tools[name] = spec
        self._order.append(name)
        return spec

    @staticmethod
    def _validate_resource_keys(keys: object, name: str) -> tuple[str, ...]:
        if not isinstance(keys, tuple) or not all(
            isinstance(key, str) and bool(key.strip()) for key in keys
        ):
            raise ValueError(
                f"tool {name!r} resource_keys must be a tuple of non-empty str "
                "or a callable returning one"
            )
        return tuple(dict.fromkeys(key.strip() for key in keys))

    def unregister(self, name: str, *, expected: ToolSpec | None = None) -> bool:
        """Remove one exact registration; return whether it was removed.

        ``expected`` prevents a stale plugin disposer from removing a newer
        owner's registration after a reload.
        """
        current = self._tools.get(name)
        if current is None or (expected is not None and current is not expected):
            return False
        del self._tools[name]
        self._order.remove(name)
        return True

    def scope_for(self, context: Any) -> _ScopedToolRegistry:
        """Return a plugin-scope view whose registrations auto-unwind."""
        return _ScopedToolRegistry(self, context)

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
        for reserved in _RESERVED_ARGUMENT_NAMES:
            if reserved in properties:
                raise ValueError(
                    f"tool {name!r} input_schema property {reserved!r} is reserved: "
                    f"it collides with the harness-side execution keyword"
                )
        required = schema.get("required")
        if not isinstance(required, list) or not all(
            isinstance(r, str) for r in required
        ):
            raise ValueError(
                f"tool {name!r} input_schema required must be a list of str"
            )

    def add_execution_listener(self, callback: Callable[[str], None]) -> None:
        """Subscribe to every executed tool name (bounded; oldest dropped).

        工具家族用它实现跨工具的状态机（如 coding 工具的连读熔断：任何
        非 read_file 的执行都打断连读计数）。监听器抛错一律吞掉——它们
        只是提示信号，绝不是执行路径的一部分。
        """
        if not callable(callback):
            raise TypeError("execution listener must be callable")
        self._execution_listeners.append(callback)
        if len(self._execution_listeners) > 32:
            del self._execution_listeners[: len(self._execution_listeners) - 32]

    def notify_executed(self, name: str) -> None:
        for listener in tuple(self._execution_listeners):
            try:
                listener(name)
            except Exception:  # noqa: BLE001 - 信号失败不连累执行
                pass

    def add_session_end_listener(self, callback: Callable[[], None]) -> None:
        """Subscribe to loop termination (any terminal reason, bounded).

        桌面输入锁一类"必须归还"的会话资源在这里挂自动释放——把"记得调
        turn_ended"从模型的责任里拿走（模型忘了调就 COMPUTER_USE_BUSY 卡死
        下一个会话）。loop 的每个终态路径收口处调用一次。
        """
        if not callable(callback):
            raise TypeError("session end listener must be callable")
        self._session_end_listeners.append(callback)
        if len(self._session_end_listeners) > 32:
            del self._session_end_listeners[: len(self._session_end_listeners) - 32]

    def notify_session_end(self) -> None:
        for listener in tuple(self._session_end_listeners):
            try:
                listener()
            except Exception:  # noqa: BLE001 - 清理失败不连累终态
                pass

    def get(self, name: str) -> ToolSpec:
        """Return the spec for ``name`` (old-name aliases resolve); KeyError otherwise."""
        canonical = self._aliases.get(name, name)
        try:
            return self._tools[canonical]
        except KeyError:
            raise KeyError(name) from None

    def list(self) -> tuple[ToolSpec, ...]:
        """All registered specs in registration order."""
        return tuple(self._tools[n] for n in self._order)

    def is_concurrency_safe_for(
        self, name: str, arguments: Mapping[str, object] | None
    ) -> bool:
        """按调用解析并发安全性；动态判定抛错一律按 False（fail-closed）。"""
        spec = self.get(name)
        if spec.is_concurrency_safe_for is None:
            return spec.is_concurrency_safe
        try:
            verdict = bool(spec.is_concurrency_safe_for(dict(arguments or {})))
        except Exception:  # noqa: BLE001
            return False
        return verdict

    def resolve_effect(self, name: str, arguments: Mapping[str, object] | None) -> Effect:
        """按调用解析工具效果；未注册名抛 KeyError。"""
        return spec_effect(self.get(name), arguments)

    def resource_keys_for(
        self, name: str, args: dict[str, object]
    ) -> tuple[str, ...]:
        """Resolve the resources one invocation must own while executing.

        Static declarations cover process-wide resources such as desktop input
        or the clipboard. A callable may derive a narrower key from validated
        arguments, for example ``file:C:/work/a.txt``.
        """
        spec = self.get(name)
        declared = spec.resource_keys
        keys = declared(args) if callable(declared) else declared
        return self._validate_resource_keys(keys, name)

    def schemas_for_model(self) -> list[dict[str, object]]:
        """Emit specs in CC API ``tools`` parameters format.

        Each entry is ``{"name", "description", "parameters": input_schema}``
        (query.ts calls the model with these as the ``tools`` argument).
        When a tool declares ``examples`` they are attached top-level so the
        model sees a concrete usage on the first round.
        """
        emitted: list[dict[str, object]] = []
        for spec in self.list():
            entry: dict[str, object] = {
                "name": spec.name,
                "description": spec.description,
                "parameters": spec.input_schema,
            }
            if spec.examples:
                entry["examples"] = spec.examples
            emitted.append(entry)
        return emitted

    def validate_input(self, spec: ToolSpec, args: dict[str, object]) -> list[str]:
        """Strictly validate ``args`` against ``spec.input_schema``.

        Returns a list of human-readable errors; an empty list means valid.
        Checks missing required fields, extra fields and JSON Schema type
        mismatches. Raises :class:`TypeError` when ``args`` is not a dict.
        """
        if not isinstance(args, dict):
            raise TypeError(f"args must be a dict, got {type(args).__name__}")
        errors: list[str] = []
        _validate_json_schema_value(
            args,
            spec.input_schema,
            path="",
            errors=errors,
            budget=[0],
            root_schema=spec.input_schema,
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

    def search(self, keyword: str, *, limit: int = 8) -> list[ToolSpec]:
        """Keyword search over the full registry (CC ToolSearch pattern).

        Tools beyond the loop's tool_limit are invisible to the model; the
        ``find_capability`` tool searches this index so deferred capabilities
        stay discoverable without paying their schema tokens every turn.
        ASCII keywords match whole words (name/description); CJK keywords
        match substrings (Chinese has no word boundaries). Case-insensitive.
        """
        raw = str(keyword or "").casefold().strip()
        if not raw:
            return []
        ascii_tokens = re.findall(r"[a-z0-9_]+", raw)
        cjk_tokens = re.findall(r"[\u4e00-\u9fff]+", raw)
        if not ascii_tokens and not cjk_tokens:
            return []
        results: list[tuple[int, ToolSpec]] = []
        for spec in self.list():
            example_text = " ".join(
                json.dumps(ex, ensure_ascii=False) for ex in spec.examples
            )
            haystack = (
                f"{spec.name} {spec.description} {example_text}".casefold()
            )
            haystack_words = set(re.findall(r"[a-z0-9_]+", haystack))
            score = sum(
                1 for token in ascii_tokens
                for word in haystack_words
                if token == word or token in word.split("_")
            )
            score += sum(1 for token in cjk_tokens if token in haystack)
            if score > 0:
                results.append((score, spec))
        results.sort(key=lambda item: (-item[0], item[1].name))
        return [spec for _, spec in results[:limit]]

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
            if spec.verify_result is not None:
                spec.verify_result(value)
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
    if isinstance(type_name, list):
        verdicts = [_matches_json_schema_type(value, item) for item in type_name]
        return True if True in verdicts else None if None in verdicts else False
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


def _child_path(path: str, key: str) -> str:
    return f"{path}.{key}" if path else key


def _limit(value: object, default: int = 0) -> int:
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else default


def _resolve_local_schema_ref(root: object, reference: str) -> dict[str, object] | None:
    """Resolve one RFC 6901 JSON pointer inside the tool's own schema."""
    if reference == "#":
        return root if isinstance(root, dict) else None
    if not reference.startswith("#/") or len(reference) > 512:
        return None
    current: object = root
    for raw_token in reference[2:].split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if token not in current:
                return None
            current = current[token]
            continue
        if isinstance(current, list) and token.isdecimal():
            index = int(token)
            if index >= len(current):
                return None
            current = current[index]
            continue
        return None
    return current if isinstance(current, dict) else None


def _validate_json_schema_value(
    value: object,
    schema: object,
    *,
    path: str,
    errors: list[str],
    budget: list[int],
    depth: int = 0,
    root_schema: object | None = None,
    ref_trail: tuple[tuple[str, int], ...] = (),
) -> None:
    """Validate the bounded JSON-Schema subset accepted from model/tool APIs."""
    if len(errors) >= 64:
        return
    budget[0] += 1
    label = path or "input"
    if budget[0] > 10_000:
        if not any("too many values" in item for item in errors):
            errors.append("input contains too many values")
        return
    if depth > 32:
        if not any("nesting" in item for item in errors):
            errors.append(f"field {label!r} exceeds maximum nesting depth")
        return
    if isinstance(value, float) and not math.isfinite(value):
        errors.append(f"field {label!r} must be a finite number")
        return
    if not isinstance(schema, dict):
        errors.append(f"field {label!r} has an invalid schema")
        return
    if root_schema is None:
        root_schema = schema

    reference = schema.get("$ref")
    if reference is not None:
        if not isinstance(reference, str) or not reference.startswith("#"):
            errors.append(f"field {label!r} uses a non-local schema reference")
            return
        resolved = _resolve_local_schema_ref(root_schema, reference)
        if resolved is None:
            errors.append(f"field {label!r} has an unresolved schema reference")
            return
        marker = (reference, id(value))
        if marker in ref_trail:
            errors.append(f"field {label!r} has a cyclic schema reference")
            return
        _validate_json_schema_value(
            value,
            resolved,
            path=path,
            errors=errors,
            budget=budget,
            depth=depth + 1,
            root_schema=root_schema,
            ref_trail=(*ref_trail, marker),
        )
        if len(schema) == 1:
            return

    for keyword in ("allOf",):
        branches = schema.get(keyword)
        if isinstance(branches, list):
            for branch in branches:
                _validate_json_schema_value(
                    value,
                    branch,
                    path=path,
                    errors=errors,
                    budget=budget,
                    depth=depth + 1,
                    root_schema=root_schema,
                    ref_trail=ref_trail,
                )
    for keyword, exact in (("anyOf", False), ("oneOf", True)):
        branches = schema.get(keyword)
        if isinstance(branches, list) and branches:
            matches = 0
            for branch in branches:
                branch_errors: list[str] = []
                _validate_json_schema_value(
                    value,
                    branch,
                    path=path,
                    errors=branch_errors,
                    budget=budget,
                    depth=depth + 1,
                    root_schema=root_schema,
                    ref_trail=ref_trail,
                )
                matches += not branch_errors
            if matches == 0 or (exact and matches != 1):
                errors.append(f"field {label!r} does not match {keyword}")
                return

    if "const" in schema and value != schema["const"]:
        errors.append(f"field {label!r} must equal const value")
    choices = schema.get("enum")
    if isinstance(choices, list) and value not in choices:
        errors.append(f"field {label!r} is not one of the allowed enum values")

    type_name = schema.get("type")
    if type_name is not None:
        matches = _matches_json_schema_type(value, type_name)
        if matches is False:
            errors.append(
                f"field {label!r} expects type {type_name!r}, got {type(value).__name__}"
            )
            return

    if isinstance(value, str):
        minimum = _limit(schema.get("minLength"), -1)
        maximum = _limit(schema.get("maxLength"), -1)
        if minimum >= 0 and len(value) < minimum:
            errors.append(f"field {label!r} violates minLength={minimum}")
        if maximum >= 0 and len(value) > maximum:
            errors.append(f"field {label!r} violates maxLength={maximum}")
        pattern = schema.get("pattern")
        if isinstance(pattern, str):
            try:
                matched = re.search(pattern, value) is not None
            except re.error:
                matched = False
            if not matched:
                errors.append(f"field {label!r} does not match pattern")
        return

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        for keyword, predicate in (
            ("minimum", lambda actual, bound: actual >= bound),
            ("maximum", lambda actual, bound: actual <= bound),
            ("exclusiveMinimum", lambda actual, bound: actual > bound),
            ("exclusiveMaximum", lambda actual, bound: actual < bound),
        ):
            bound = schema.get(keyword)
            if (
                isinstance(bound, (int, float))
                and not isinstance(bound, bool)
                and not predicate(value, bound)
            ):
                errors.append(f"field {label!r} violates {keyword}={bound}")
        return

    if isinstance(value, list):
        minimum = _limit(schema.get("minItems"), -1)
        maximum = _limit(schema.get("maxItems"), -1)
        if minimum >= 0 and len(value) < minimum:
            errors.append(f"field {label!r} violates minItems={minimum}")
        if maximum >= 0 and len(value) > maximum:
            errors.append(f"field {label!r} violates maxItems={maximum}")
        if schema.get("uniqueItems") is True:
            identities = [repr(item) for item in value]
            if len(identities) != len(set(identities)):
                errors.append(f"field {label!r} violates uniqueItems")
        item_schema = schema.get("items")
        for index, item in enumerate(value):
            _validate_json_schema_value(
                item,
                item_schema if isinstance(item_schema, dict) else {},
                path=f"{label}[{index}]",
                errors=errors,
                budget=budget,
                depth=depth + 1,
                root_schema=root_schema,
                ref_trail=ref_trail,
            )
        return

    if isinstance(value, dict):
        properties = schema.get("properties")
        properties = properties if isinstance(properties, dict) else {}
        required = schema.get("required")
        required = required if isinstance(required, list) else []
        for field_name in required:
            if isinstance(field_name, str) and field_name not in value:
                child = _child_path(path, field_name)
                errors.append(f"missing required field {child!r}")
        # Tool call roots are deliberately strict (the existing Harness
        # contract); nested JSON Schema objects follow the standard default
        # and allow unspecified keys unless additionalProperties says no.
        extra_schema = schema.get("additionalProperties", depth != 0)
        for field_name, item in value.items():
            child = _child_path(path, str(field_name))
            property_schema = properties.get(field_name)
            if property_schema is None:
                if extra_schema is False:
                    errors.append(f"unexpected field {child!r}")
                    continue
                property_schema = extra_schema if isinstance(extra_schema, dict) else {}
            _validate_json_schema_value(
                item,
                property_schema,
                path=child,
                errors=errors,
                budget=budget,
                depth=depth + 1,
                root_schema=root_schema,
                ref_trail=ref_trail,
            )


GLOBAL_REGISTRY = ToolRegistry()
"""Process-wide singleton registry (module-level, per plan T2.2)."""


class _ScopedToolRegistry:
    """Context-bound view that turns every registration into an effect."""

    __slots__ = ("_registry", "_context")

    def __init__(self, registry: ToolRegistry, context: Any) -> None:
        self._registry = registry
        self._context = context

    def register(self, spec: ToolSpec) -> ToolSpec:
        execute = spec.execute

        def execute_owned(*args: Any, **kwargs: Any) -> Any:
            with self._context.work():
                return execute(*args, **kwargs)

        registered = self._registry.register(replace(spec, execute=execute_owned))
        try:
            self._context.effect(
                lambda: self._registry.unregister(spec.name, expected=registered)
            )
        except Exception:
            self._registry.unregister(spec.name, expected=registered)
            raise
        return registered

    def __getattr__(self, name: str) -> Any:
        return getattr(self._registry, name)
