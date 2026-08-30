"""B4 Wait 工具：等条件成立（窗口/元素/文件/进程），带超时轮询。

三家（CC/Hermes/Pi）都没有的能力：桌面 agent 刚需。点开菜单→等菜单渲染
→点菜单项，现在靠模型连发 Observe 烧轮次；Wait 把它变成一次确定性等待。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.agent_runtime.tool_registry import Effect, ToolRegistry
from app.agent_runtime.wait_tool import WaitTool


@pytest.fixture()
def registry_workspace(tmp_path: Path) -> Path:
    return tmp_path


def _windows(titles: list[str]):
    def probe():
        return [
            {"hwnd": 100 + i, "title": title, "process_name": "app.exe", "pid": 1}
            for i, title in enumerate(titles)
        ]

    return probe


def _elements(items: list[dict]):
    def probe(hwnd: int):
        return items

    return probe


def test_wait_satisfied_by_window_title() -> None:
    tool = WaitTool(windows_probe=_windows(["主窗口"]), elements_probe=_elements([]))
    evidence = tool.wait(window_title="主窗口", timeout_s=2.0, poll_ms=0.02)
    assert evidence["satisfied"] is True
    assert evidence["condition"] == "window_title"
    assert evidence["elapsed_s"] <= 2.0


def test_wait_times_out_honestly() -> None:
    tool = WaitTool(windows_probe=_windows([]), elements_probe=_elements([]))
    evidence = tool.wait(window_title="永不出现", timeout_s=0.3, poll_ms=0.05)
    assert evidence["satisfied"] is False
    assert "timeout" in str(evidence.get("note") or "").casefold()


def test_wait_element_text_scans_windows_matching_filter() -> None:
    def elements(hwnd: int):
        if hwnd == 100:
            return [{"index": 1, "role": "button", "name": "保存", "rect": [0, 0, 10, 10]}]
        return []

    tool = WaitTool(windows_probe=_windows(["主窗口"]), elements_probe=elements)
    evidence = tool.wait(element_text="保存", window_title="主窗口", timeout_s=2.0, poll_ms=0.02)
    assert evidence["satisfied"] is True
    assert evidence["condition"] == "element_text"


def test_wait_file_condition(registry_workspace: Path) -> None:
    target = registry_workspace / "marker.txt"
    tool = WaitTool(windows_probe=_windows([]), elements_probe=_elements([]))
    import threading

    timer = threading.Timer(0.1, target.write_text, ["done"])
    timer.start()
    evidence = tool.wait(file_exists=str(target), timeout_s=5.0, poll_ms=0.02)
    assert evidence["satisfied"] is True


def test_wait_requires_at_least_one_condition() -> None:
    tool = WaitTool(windows_probe=_windows([]), elements_probe=_elements([]))
    with pytest.raises(Exception):
        tool.wait(timeout_s=1.0)


def test_wait_registered_with_effect_read() -> None:
    registry = ToolRegistry()
    tool = WaitTool(windows_probe=_windows([]), elements_probe=_elements([]))
    tool.register(registry)
    spec = registry.get("wait")
    assert spec.effect is Effect.READ
    assert "wait" in {s.name for s in registry.list()}
