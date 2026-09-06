"""Shared byte-oriented bridge to Magic Pointer's configured vision model."""

from __future__ import annotations

import os
import tempfile
import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

from app.ai_client import ask_vision_model

from .look_tool import VisionTimeout, VisionUnavailable


def _configured_vision_request(
    image_path: Path,
    prompt: str,
    *,
    timeout_s: float,
    attempts: int,
) -> str:
    return ask_vision_model(
        image_path,
        prompt,
        timeout_s=timeout_s,
        attempts=attempts,
    )


class FileVisionBackend:
    """Adapt in-memory image bytes to the existing path-based AI client.

    The file exists only for the duration of the request. Both historical
    ``Look`` and live ``Observe`` use this adapter so timeout and cleanup
    semantics cannot drift between the two paths.
    """

    def __init__(
        self,
        *,
        ask: Callable[..., str] | None = None,
        temporary_directory: Path | None = None,
        backend_name: str = "app.ai_client.ask_vision_model",
    ) -> None:
        self._ask = ask or _configured_vision_request
        self._temporary_directory = temporary_directory
        self._backend_name = str(backend_name)

    def describe(self, image_bytes: bytes, prompt: str, timeout_ms: int) -> dict[str, Any]:
        if not image_bytes:
            raise VisionUnavailable("image bytes are empty")
        started = time.perf_counter()
        with tempfile.NamedTemporaryFile(
            suffix=".png", delete=False, dir=self._temporary_directory,
        ) as handle:
            path = Path(handle.name)
            handle.write(image_bytes)
        try:
            try:
                text = self._ask(
                    path,
                    str(prompt),
                    timeout_s=max(0.001, int(timeout_ms) / 1000.0),
                    attempts=1,
                )
            except TimeoutError as exc:
                raise VisionTimeout(str(exc)) from exc
        finally:
            with suppress(OSError):
                os.unlink(path)
        return {
            "text": str(text),
            "latency_ms": (time.perf_counter() - started) * 1000.0,
            "backend": self._backend_name,
        }


__all__ = ["FileVisionBackend"]
