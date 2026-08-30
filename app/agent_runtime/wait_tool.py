"""Wait：确定性条件等待（模型可调用）。

桌面 agent 的高频序列是"动作 → 等 UI 出现 → 下一个动作"。没有 Wait 时
模型只能连发 get_app_state 空转，一轮一秒地烧；CC 的 SleepTool 是裸 sleep
（等少了不够、等多了浪费），Hermes 的 watch_patterns 只覆盖后台输出。
Wait 把"等 UI/文件就绪"变成一次带超时的确定性调用：

- window_title: 任一可见窗口标题包含该子串
- element_text: window_title 过滤（可选）的窗口里，UIA 元素文本包含该子串
- file_exists: 工作区内路径出现
- 进程退出等进程条件不在这里（后台 job 的完成推送已覆盖）

全部条件 OR 关系；诚实返回 {satisfied, condition, elapsed_s, note}。
注入探针（windows/elements），本模块不碰真实桌面，测试用 fake。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = ["WaitTool"]

DEFAULT_TIMEOUT_S = 20.0
MAX_TIMEOUT_S = 120.0
_ELEMENT_SCAN_EVERY = 2
"""元素树扫描比窗口枚举贵（UIA 走 COM），隔一次轮询扫一次。"""


class WaitTool:
    """条件等待：任一条件成立即返回；超时诚实返回 unsatisfied。"""

    def __init__(
        self,
        *,
        windows_probe: Callable[[], list[dict[str, Any]]],
        elements_probe: Callable[[int], list[dict[str, Any]]],
        workspace_root: str | Path | None = None,
    ) -> None:
        self._windows_probe = windows_probe
        self._elements_probe = elements_probe
        self._workspace_root = Path(workspace_root) if workspace_root else None

    def wait(
        self,
        *,
        window_title: str = "",
        element_text: str = "",
        file_exists: str = "",
        timeout_s: float = DEFAULT_TIMEOUT_S,
        poll_ms: int = 250,
    ) -> dict[str, Any]:
        if not any(str(c or "").strip() for c in (window_title, element_text, file_exists)):
            raise ValueError("wait requires at least one condition: window_title / element_text / file_exists")
        bounded_timeout = max(0.05, min(float(timeout_s or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S))
        interval = max(0.01, min(float(poll_ms or 250), 2000.0)) / 1000.0
        deadline = time.monotonic() + bounded_timeout
        scan_tick = 0
        last_error: str | None = None
        while True:
            scan_tick += 1
            try:
                # element_text 在场时 window_title 降级为它的过滤条件，
                # 不再单独成条件（否则过滤条件自己先"满足"）。
                if element_text:
                    if scan_tick % _ELEMENT_SCAN_EVERY == 0 and self._element_ready(
                        element_text, window_title
                    ):
                        return self._satisfied("element_text", bounded_timeout, last_error)
                elif window_title and self._window_ready(window_title):
                    return self._satisfied("window_title", bounded_timeout, last_error)
                if file_exists and self._file_ready(file_exists):
                    return self._satisfied("file_exists", bounded_timeout, last_error)
            except Exception as exc:  # noqa: BLE001 - 探针瞬时失败继续等到超时
                last_error = f"{type(exc).__name__}: {exc}"
            if time.monotonic() >= deadline:
                return {
                    "satisfied": False,
                    "condition": (
                        window_title and "window_title"
                        or element_text and "element_text"
                        or "file_exists"
                    ),
                    "elapsed_s": round(bounded_timeout, 3),
                    "note": (
                        "timeout waiting for condition"
                        + (f"; last probe error: {last_error}" if last_error else "")
                    ),
                }
            time.sleep(interval)

    def _satisfied(self, condition: str, timeout: float, last_error: str | None) -> dict[str, Any]:
        note = None if last_error is None else f"condition met after earlier probe errors: {last_error}"
        return {
            "satisfied": True,
            "condition": condition,
            "elapsed_s": round(timeout, 3),
            **({"note": note} if note else {}),
        }

    def _window_ready(self, needle: str) -> bool:
        needle_cf = needle.casefold()
        return any(
            needle_cf in str(window.get("title") or "").casefold()
            for window in self._windows_probe()
        )

    def _element_ready(self, needle: str, window_title: str) -> bool:
        needle_cf = needle.casefold()
        title_cf = window_title.casefold() if window_title else None
        for window in self._windows_probe():
            if title_cf is not None and title_cf not in str(window.get("title") or "").casefold():
                continue
            hwnd = int(window.get("hwnd") or 0)
            try:
                elements = self._elements_probe(hwnd) or []
            except Exception:  # noqa: BLE001 - 单窗口探针失败看下一个
                continue
            for element in elements:
                haystack = " ".join(
                    str(element.get(key) or "")
                    for key in ("name", "value", "text")
                ).casefold()
                if needle_cf in haystack:
                    return True
        return False

    def _file_ready(self, raw: str) -> bool:
        path = Path(str(raw or "").strip())
        if not path.is_absolute() and self._workspace_root is not None:
            path = self._workspace_root / path
        return path.is_file()

    def _execute(
        self,
        window_title: str = "",
        element_text: str = "",
        file_exists: str = "",
        timeout_s: float = DEFAULT_TIMEOUT_S,
        poll_ms: int = 250,
        **_: Any,
    ) -> str:
        import json

        return json.dumps(
            self.wait(
                window_title=window_title,
                element_text=element_text,
                file_exists=file_exists,
                timeout_s=timeout_s,
                poll_ms=poll_ms,
            ),
            ensure_ascii=False,
        )

    def register(self, registry: ToolRegistry) -> None:
        registry.register(ToolSpec(
            name="wait",
            description=(
                "等一个条件成立再继续（最多 120 秒）：窗口标题出现 "
                "(window_title)、界面元素文本出现 (element_text，可配 "
                "window_title 过滤)、或文件出现 (file_exists)。条件全部不满足"
                "时到超时为止，诚实返回 satisfied=false——不要用 sleep 空等，"
                "也不要连续 Observe 空转。"
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "window_title": {"type": "string", "description": "等窗口标题包含该子串"},
                    "element_text": {"type": "string", "description": "等 UIA 元素文本包含该子串"},
                    "file_exists": {"type": "string", "description": "等该路径出现（相对工作区）"},
                    "timeout_s": {"type": "number", "description": "默认 20，上限 120"},
                    "poll_ms": {"type": "integer", "description": "轮询间隔，默认 250"},
                },
                "required": [],
            },
            execute=self._execute,
            effect=Effect.READ,
            is_concurrency_safe=False,  # UIA 探针与 Observe 共用宿主
            used_backend="wait_probe",
            timeout_ms=130_000,
        ))
