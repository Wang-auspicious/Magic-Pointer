# Adapted from ByteDance UI-TARS action parsing and coordinate conversion.
# Copyright (c) 2025 Bytedance Ltd. and/or its affiliates.
# SPDX-License-Identifier: Apache-2.0
"""Safe, data-only adapter for UI-TARS model action text.

Unlike the upstream convenience path, this module never emits Python code and
never uses ``eval``. It produces unprivileged intents; Magic Pointer core must
assign an ``Effect`` before an intent can become an executable action.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from typing import Any

from app.agent_runtime.tool_registry import Effect

from .schema import ComputerAction, ComputerActionKind, OperatorObservation


@dataclass(frozen=True, slots=True)
class UiTarsActionIntent:
    kind: ComputerActionKind
    start: tuple[float, float] | None = None
    end: tuple[float, float] | None = None
    text: str | None = None
    keys: tuple[str, ...] = ()
    scroll_delta: int = 0
    duration_ms: int = 0
    thought: str = ""


_KIND_MAP = {
    "click": ComputerActionKind.CLICK,
    "left_single": ComputerActionKind.CLICK,
    "left_double": ComputerActionKind.DOUBLE_CLICK,
    "right_single": ComputerActionKind.RIGHT_CLICK,
    "hover": ComputerActionKind.HOVER,
    "drag": ComputerActionKind.DRAG,
    "select": ComputerActionKind.DRAG,
    "scroll": ComputerActionKind.SCROLL,
    "type": ComputerActionKind.TYPE_TEXT,
    "hotkey": ComputerActionKind.HOTKEY,
    "press": ComputerActionKind.HOTKEY,
    "keydown": ComputerActionKind.KEY_DOWN,
    "release": ComputerActionKind.KEY_UP,
    "keyup": ComputerActionKind.KEY_UP,
    "wait": ComputerActionKind.WAIT,
    "finished": ComputerActionKind.FINISH,
    "call_user": ComputerActionKind.REQUEST_USER,
}

_START_ARGUMENTS = frozenset({"start_box", "start_point", "point"})
_END_ARGUMENTS = frozenset({"end_box", "end_point"})
_ALLOWED_ARGUMENTS = {
    "click": _START_ARGUMENTS,
    "left_single": _START_ARGUMENTS,
    "left_double": _START_ARGUMENTS,
    "right_single": _START_ARGUMENTS,
    "hover": _START_ARGUMENTS,
    "drag": _START_ARGUMENTS | _END_ARGUMENTS,
    "select": _START_ARGUMENTS | _END_ARGUMENTS,
    "scroll": _START_ARGUMENTS | {"direction"},
    "type": frozenset({"content"}),
    "hotkey": frozenset({"key", "hotkey", "press"}),
    "press": frozenset({"key", "hotkey", "press"}),
    "keydown": frozenset({"key", "hotkey", "press"}),
    "keyup": frozenset({"key", "hotkey", "press"}),
    "release": frozenset({"key", "hotkey", "press"}),
    "wait": frozenset({"duration", "duration_ms"}),
    "finished": frozenset({"content"}),
    "call_user": frozenset({"content"}),
}


def _split_calls(value: str) -> list[str]:
    calls: list[str] = []
    start: int | None = None
    depth = 0
    quote = ""
    escaped = False
    for index, char in enumerate(value):
        if start is None:
            if char.isspace():
                continue
            start = index
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            continue
        if char in {"'", '"'}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth < 0:
                raise ValueError("unbalanced UI-TARS action")
            if depth == 0 and start is not None:
                calls.append(value[start:index + 1].strip())
                start = None
    if quote or depth != 0 or (start is not None and value[start:].strip()):
        raise ValueError("unbalanced UI-TARS action")
    return calls


def _literal_call(value: str) -> tuple[str, dict[str, Any]]:
    try:
        expression = ast.parse(value, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"invalid UI-TARS action syntax: {exc.msg}") from exc
    call = expression.body
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.args:
        raise ValueError("UI-TARS action must be a direct keyword-only function call")
    arguments: dict[str, Any] = {}
    for keyword in call.keywords:
        if keyword.arg is None:
            raise ValueError("UI-TARS action does not allow **kwargs")
        if keyword.arg in arguments:
            raise ValueError(f"duplicate UI-TARS action argument: {keyword.arg}")
        try:
            arguments[keyword.arg] = ast.literal_eval(keyword.value)
        except (ValueError, TypeError) as exc:
            raise ValueError("UI-TARS action arguments must be literal values") from exc
    return call.func.id.casefold(), arguments


def _box_center(
    value: Any,
    *,
    model_image_size: tuple[int, int] | None = None,
) -> tuple[float, float] | None:
    if value is None or value == "":
        return None
    parsed = value
    if isinstance(value, str):
        clean = value.strip()
        point_match = re.fullmatch(r"<point>\s*([0-9.]+)\s+([0-9.]+)\s*</point>", clean)
        if point_match:
            parsed = [float(point_match.group(1)), float(point_match.group(2))]
        else:
            try:
                parsed = ast.literal_eval(clean)
            except (SyntaxError, ValueError) as exc:
                raise ValueError("coordinate box must be a literal sequence") from exc
    if not isinstance(parsed, (list, tuple)) or len(parsed) not in {2, 4}:
        raise ValueError("coordinate box must contain two or four numbers")
    try:
        numbers = [float(item) for item in parsed]
    except (TypeError, ValueError) as exc:
        raise ValueError("coordinate box must contain only numbers") from exc
    if any(item < 0.0 for item in numbers):
        raise ValueError("coordinates must be normalized to [0, 1]")
    if any(item > 1.0 for item in numbers):
        if model_image_size is None:
            raise ValueError(
                "coordinates must be normalized to [0, 1] or include model_image_size"
            )
        if (
            len(model_image_size) != 2
            or int(model_image_size[0]) <= 0
            or int(model_image_size[1]) <= 0
        ):
            raise ValueError("model_image_size must contain positive width and height")
        width, height = (float(item) for item in model_image_size)
        numbers = [
            item / (width if index % 2 == 0 else height)
            for index, item in enumerate(numbers)
        ]
        if any(item > 1.0 for item in numbers):
            raise ValueError("absolute coordinates exceed model_image_size")
    if len(numbers) == 2:
        return numbers[0], numbers[1]
    return (numbers[0] + numbers[2]) / 2.0, (numbers[1] + numbers[3]) / 2.0


def _thought(value: str) -> str:
    prefix = value.split("Action:", 1)[0]
    for marker in ("Action_Summary:", "Thought:", "Reflection:"):
        if marker in prefix:
            return prefix.rsplit(marker, 1)[-1].strip()[:2000]
    return ""


def parse_ui_tars_response(
    value: str,
    *,
    model_image_size: tuple[int, int] | None = None,
) -> list[UiTarsActionIntent]:
    """Parse UI-TARS text without granting it permission to execute anything."""
    text = str(value or "").strip().replace("[EOS]", "")
    if "Action:" not in text:
        raise ValueError("UI-TARS response is missing Action:")
    action_blob = text.rsplit("Action:", 1)[-1].strip()
    calls = _split_calls(action_blob)
    if not calls:
        raise ValueError("UI-TARS response contains no actions")
    thought = _thought(text)
    intents: list[UiTarsActionIntent] = []
    for raw_call in calls:
        name, arguments = _literal_call(raw_call)
        kind = _KIND_MAP.get(name)
        if kind is None:
            raise ValueError(f"unsupported UI-TARS action: {name}")
        unsupported = set(arguments) - set(_ALLOWED_ARGUMENTS[name])
        if unsupported:
            raise ValueError(
                f"unsupported argument for UI-TARS action {name}: "
                f"{', '.join(sorted(unsupported))}"
            )
        start = _box_center(
            arguments.get("start_box", arguments.get("start_point", arguments.get("point"))),
            model_image_size=model_image_size,
        )
        end = _box_center(
            arguments.get("end_box", arguments.get("end_point")),
            model_image_size=model_image_size,
        )
        content = arguments.get("content")
        key_value = arguments.get("key", arguments.get("hotkey", arguments.get("press", "")))
        keys = tuple(
            key.casefold()
            for key in re.split(r"[+\s]+", str(key_value).strip())
            if key
        )
        direction = str(arguments.get("direction") or "").casefold()
        scroll_delta = 5 if "up" in direction else -5 if "down" in direction else 0
        raw_duration = arguments.get("duration_ms", arguments.get("duration", 1000))
        try:
            duration_ms = int(float(raw_duration) * (1000 if name == "wait" and float(raw_duration) <= 30 else 1))
        except (TypeError, ValueError) as exc:
            raise ValueError("wait duration must be numeric") from exc
        intents.append(UiTarsActionIntent(
            kind=kind,
            start=start,
            end=end,
            text=str(content) if content is not None else None,
            keys=keys,
            scroll_delta=scroll_delta,
            duration_ms=duration_ms if kind is ComputerActionKind.WAIT else 0,
            thought=thought,
        ))
    return intents


def compile_ui_tars_intent(
    intent: UiTarsActionIntent,
    *,
    action_id: str,
    effect: Effect,
    source_observation: OperatorObservation,
) -> ComputerAction:
    """Core policy assigns the effect; the UI-TARS model never does."""
    if not isinstance(intent, UiTarsActionIntent):
        raise TypeError("intent must be UiTarsActionIntent")
    if not isinstance(source_observation, OperatorObservation):
        raise TypeError("source_observation must be OperatorObservation")
    return ComputerAction(
        action_id=action_id,
        kind=intent.kind,
        effect=effect,
        source_observation_id=source_observation.observation_id,
        source_image_sha256=source_observation.image_sha256,
        start=intent.start,
        end=intent.end,
        text=intent.text,
        keys=intent.keys,
        scroll_delta=intent.scroll_delta,
        duration_ms=intent.duration_ms,
        rationale=intent.thought,
    )
