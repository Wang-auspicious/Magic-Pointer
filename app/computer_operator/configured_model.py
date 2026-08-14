# Adapted from ByteDance UI-TARS desktop action prompt.
# Copyright (c) 2025 Bytedance Ltd. and/or its affiliates.
# SPDX-License-Identifier: Apache-2.0
"""Configured multimodal-gateway adapter for the UI-TARS action loop."""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from PIL import Image

from app import ai_client

from .agent import UiTarsPrediction
from .schema import OperatorObservation

_MAX_MODEL_EDGE = 1600
_MAX_HISTORY_ITEMS = 8
_MAX_HISTORY_CHARS = 12_000
_HISTORY_FIELDS = (
    "round",
    "modelResponse",
    "actionId",
    "executed",
    "verified",
    "error",
    "beforeSha256",
    "afterSha256",
)

UI_TARS_SYSTEM_PROMPT = """You are a GUI action model operating one explicitly granted application surface.
Return exactly this data format and no Markdown fence:
Thought: a brief Chinese explanation of the next single action
Action: exactly one supported function call

Supported calls:
click(start_box='[x, y]')
left_double(start_box='[x, y]')
right_single(start_box='[x, y]')
hover(start_box='[x, y]')
drag(start_box='[x1, y1]', end_box='[x2, y2]')
scroll(start_box='[x, y]', direction='up or down')
hotkey(key='ctrl a')
type(content='text')
wait(duration=1)
finished(content='result summary')
call_user(content='what the user must do or confirm')

Coordinates are pixels in the exact screenshot supplied with this request.
Never emit two actions from one screenshot. After one executable action, wait
for a fresh screenshot. Use call_user when the target is ambiguous or an
action may send, delete, purchase, disclose a secret, or be hard to reverse.
Do not invent controls that are not visible."""


def _scaled_image_size(path: Path, fallback: tuple[int, int]) -> tuple[int, int]:
    try:
        with Image.open(path) as image:
            width, height = image.size
    except Exception:
        width, height = fallback
    scale = min(1.0, _MAX_MODEL_EDGE / max(width, height))
    return max(1, int(width * scale)), max(1, int(height * scale))


def _bounded_history(history: Sequence[dict[str, Any]]) -> str:
    rows: list[dict[str, Any]] = []
    for raw in list(history)[-_MAX_HISTORY_ITEMS:]:
        row = {key: raw[key] for key in _HISTORY_FIELDS if key in raw}
        if "modelResponse" in row:
            row["modelResponse"] = str(row["modelResponse"])[:2_000]
        if "actionId" in row:
            row["actionId"] = str(row["actionId"])[:240]
        if "error" in row:
            row["error"] = str(row["error"] or "")[:1_000]
        for key in ("beforeSha256", "afterSha256"):
            if key in row:
                row[key] = str(row[key] or "")[:64]
        rows.append(row)
    prefix = "Verified action history: "
    while rows:
        serialized = json.dumps(
            rows,
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        )
        if len(prefix) + len(serialized) <= _MAX_HISTORY_CHARS:
            return prefix + serialized
        rows.pop(0)
    return prefix + "[]"


class ConfiguredUiTarsModel:
    """Use Magic Pointer's configured vision endpoint as an action model."""

    used_backend = "magic_pointer.configured_vision_ui_tars"

    def __init__(
        self,
        *,
        predictor: Callable[..., str] = ai_client.ask_vision_model,
        timeout_s: float = 45.0,
    ) -> None:
        if not callable(predictor):
            raise TypeError("predictor must be callable")
        if not 1.0 <= float(timeout_s) <= 120.0:
            raise ValueError("timeout_s must be between 1 and 120")
        self.predictor = predictor
        self.timeout_s = float(timeout_s)

    def predict(
        self,
        task: str,
        observation: OperatorObservation,
        history: Sequence[dict[str, Any]],
        *,
        scope: Any = None,
    ) -> UiTarsPrediction:
        image_path = Path(observation.image_ref)
        if not image_path.is_file():
            raise FileNotFoundError(f"operator observation is missing: {image_path}")
        model_size = _scaled_image_size(
            image_path,
            (observation.width, observation.height),
        )
        history_text = _bounded_history(history)
        prompt = (
            f"Task: {str(task).strip()}\n"
            f"Screenshot coordinate size: {model_size[0]}x{model_size[1]}.\n"
            "Return exactly one next action."
        )
        response = self.predictor(
            image_path,
            prompt,
            context_text=history_text,
            system_prompt=UI_TARS_SYSTEM_PROMPT,
            timeout_s=self.timeout_s,
            attempts=1,
            max_tokens=600,
            cancellation_scope=scope,
        )
        text = str(response or "").strip()
        if "Action:" not in text:
            raise RuntimeError("vision_model_returned_no_action")
        return UiTarsPrediction(text=text, model_image_size=model_size)
