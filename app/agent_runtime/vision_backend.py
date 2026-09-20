"""Shared byte-oriented bridge to Magic Pointer's configured vision model."""

from __future__ import annotations

import os
import tempfile
import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any

from app.ai_client import DEFAULT_SYSTEM_PROMPT, ask_vision_model, is_ai_failure

from .look_tool import VisionTimeout, VisionUnavailable


def _configured_vision_request(
    image_path: Path,
    prompt: str,
    *,
    timeout_s: float,
    attempts: int,
    labeled_extra_images: list[tuple[str, Path]] | None = None,
    system_prompt: str | None = None,
    cancellation_scope: object = None,
) -> str:
    return ask_vision_model(
        image_path,
        prompt,
        timeout_s=timeout_s,
        attempts=attempts,
        labeled_extra_images=labeled_extra_images,
        system_prompt=system_prompt,
        cancellation_scope=cancellation_scope,
    )


class UploadDeniedVisionBackend:
    """视觉后端的位置，但这一轮不许把截图发出去。

    用户关掉 `privacy.upload_screenshots` 之后，Look 和 Observe 都不能悄悄把冻结帧
    或当前画面发走——那正是那个开关的意思。这里仍然放一个后端、而不是放 `None`，
    是为了让拒绝说得出理由：`None` 会让 `Look` 回
    `vision_not_configured`，把人引去查模型配置，而真正的原因是隐私开关。

    没有 `for_frozen_frame`：绑定冻结帧这件事本身就意味着要发图，这个后端不做。
    """

    backend_name = "blocked:screenshot_upload_disabled"

    def __init__(self, reason: str = "screenshot_upload_disabled") -> None:
        self._reason = str(reason or "screenshot_upload_disabled")

    def describe(self, image_bytes: bytes, prompt: str, timeout_ms: int, *, scope: object = None) -> dict[str, Any]:
        raise VisionUnavailable(self._reason)


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
        frozen_context_path: Path | None = None,
        frozen_captured_at: str | None = None,
    ) -> None:
        self._ask = ask or _configured_vision_request
        self._temporary_directory = temporary_directory
        self._backend_name = str(backend_name)
        self._frozen_context_path = frozen_context_path
        self._frozen_captured_at = str(frozen_captured_at or "gesture time")

    def for_frozen_frame(self, path: Path, captured_at: str) -> FileVisionBackend:
        """Bind context only to Look; leave the live Observe instance untouched."""
        return FileVisionBackend(
            ask=self._ask,
            temporary_directory=self._temporary_directory,
            backend_name=self._backend_name,
            frozen_context_path=path,
            frozen_captured_at=captured_at,
        )

    def describe(self, image_bytes: bytes, prompt: str, timeout_ms: int, *, scope: object = None) -> dict[str, Any]:
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
                context_options: dict[str, Any] = {}
                if scope is not None:
                    context_options["cancellation_scope"] = scope
                if self._frozen_context_path is not None:
                    context_options.update({
                        "labeled_extra_images": [(
                            "FROZEN_FRAME_CONTEXT / same historical frame captured at "
                            f"{self._frozen_captured_at} / context only, not another target",
                            self._frozen_context_path,
                        )],
                        "system_prompt": DEFAULT_SYSTEM_PROMPT + (
                            "\n\nFrozen Look image contract: IMAGE A is the selected detail and the only target. "
                            "FROZEN_FRAME_CONTEXT is the full view of that SAME historical frame, not THAT "
                            "and not a previous or second selected object. This context-label rule overrides "
                            "any generic IMAGE B/THAT ordering text. Use the full view only to understand "
                            "the detail's host application, location and surrounding UI; answer about IMAGE A. "
                            "Both images show the frozen gesture time, never the live screen."
                        ),
                    })
                text = self._ask(
                    path,
                    str(prompt),
                    timeout_s=max(0.001, int(timeout_ms) / 1000.0),
                    attempts=1,
                    **context_options,
                )
            except TimeoutError as exc:
                raise VisionTimeout(str(exc)) from exc
        finally:
            with suppress(OSError):
                os.unlink(path)
        if is_ai_failure(text) or not str(text or "").strip():
            raise VisionUnavailable(str(text or "vision model returned no evidence"))
        return {
            "text": str(text),
            "latency_ms": (time.perf_counter() - started) * 1000.0,
            "backend": self._backend_name,
        }


__all__ = ["FileVisionBackend"]
