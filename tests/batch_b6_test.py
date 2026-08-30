"""B6 小项：Todo 枚举校验、web_fetch 缓存与重定向回显、Recall 聚合、
只读子代理并发。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.agent_runtime.tool_registry import ToolRegistry


# --- Todo status 枚举 ---------------------------------------------------------


def _todo_registry() -> ToolRegistry:
    from app.agent_runtime.ask_todo_tools import register_todo_write

    reg = ToolRegistry()
    register_todo_write(reg)
    return reg


def test_todo_rejects_unknown_status() -> None:
    registry = _todo_registry()
    result = registry.execute_tool("todo_write", {
        "todos": [{"content": "步骤", "status": "doing"}],
    })
    assert result.is_error is True
    assert "pending" in str(result.error_message or "")


def test_todo_accepts_canonical_statuses() -> None:
    registry = _todo_registry()
    ok = registry.execute_tool("todo_write", {
        "todos": [
            {"content": "a", "status": "pending"},
            {"content": "b", "status": "in_progress"},
            {"content": "c", "status": "completed"},
        ],
    })
    assert ok.is_error is False, ok.error_message
    assert len(json.loads(str(ok.value))["plan"]) == 3


# --- web_fetch 缓存 + 重定向回显 --------------------------------------------------


def test_web_fetch_caches_same_url(monkeypatch) -> None:
    import app.agent_runtime.web_tools as wt

    calls = {"n": 0}

    class FakeResponse:
        status_code = 200
        headers = {"content-type": "text/html"}
        text = "<html><body>cache me</body></html>"
        content = b"cache me"

        def raise_for_status(self):
            return None

    def fake_get(url, **kw):
        calls["n"] += 1
        return FakeResponse()

    monkeypatch.setattr(wt.httpx, "get", fake_get)
    wt._FETCH_CACHE.clear()
    first = wt.web_fetch("https://example.com/a")
    second = wt.web_fetch("https://example.com/a")
    assert calls["n"] == 1, "同 URL 第二次必须走缓存"
    assert first == second


def test_web_fetch_reports_redirect_instead_of_following(monkeypatch) -> None:
    import app.agent_runtime.web_tools as wt

    followed = {"urls": []}

    class FakeRedirect:
        status_code = 302
        headers = {"location": "https://elsewhere.example/login"}
        text = ""

        def raise_for_status(self):
            return None

    def fake_get(url, **kw):
        followed["urls"].append(url)
        assert kw.get("follow_redirects") is False, "不得自动跟随重定向"
        return FakeRedirect()

    monkeypatch.setattr(wt.httpx, "get", fake_get)
    wt._FETCH_CACHE.clear()
    result = wt.web_fetch("https://example.com/redirect")
    assert "https://elsewhere.example/login" in str(result)
    assert len(followed["urls"]) == 1, "重定向不二次请求"


# --- Recall（search_history）同文件聚合 -------------------------------------------


def test_search_history_caps_per_file_hits(tmp_path: Path) -> None:
    from app.agent_runtime.memory_tools import register_history_search

    session_file = tmp_path / "s1.jsonl"
    session_file.write_text(
        "\n".join(json.dumps({"event": i, "kw": "needle"}) for i in range(10)),
        encoding="utf-8",
    )
    registry = ToolRegistry()
    register_history_search(registry, sessions_root=tmp_path)
    result = registry.execute_tool("search_history", {"query": "needle"})
    value = str(result.value or "")
    per_file = [
        line.split(":")[0] for line in value.splitlines() if line.startswith("s1.jsonl")
    ]
    assert 0 < len(per_file) <= 3, f"同文件最多 3 条: {per_file}"


# --- 只读子代理并发 ---------------------------------------------------------------


def test_delegate_readonly_is_read_effect_and_concurrency_safe() -> None:
    from app.agent_runtime.subagent import register_delegate_tool
    from app.agent_runtime.tool_registry import Effect

    registry = ToolRegistry()

    class _Provider:
        def create_client(self, **kw):
            return object()

    register_delegate_tool(
        registry, llm_provider=_Provider(), workspace_root=Path(".")
    )
    spec = registry.get("delegate_task")
    assert spec.effect_for is not None
    assert spec.effect_for({"readonly": True}) is Effect.READ
    assert spec.effect_for({}) is Effect.REVERSIBLE_WRITE
    assert registry.is_concurrency_safe_for("delegate_task", {"readonly": True}) is True
    assert registry.is_concurrency_safe_for("delegate_task", {}) is False


def test_delegate_readonly_child_has_no_write_tools(monkeypatch) -> None:
    from app.fabric import engine as engine_module

    captured: dict = {}

    def fake_run(prompt, registry=None, client=None, **kw):
        captured["names"] = sorted(s.name for s in registry.list())
        captured["effects"] = kw.get("allowed_effects")
        from app.agent_runtime.types import Terminal, TransitionReason

        return Terminal(reason=TransitionReason.COMPLETED, message="好", turns=1, results=())

    monkeypatch.setattr(engine_module, "run_agent_turn", fake_run)
    if True:
        registry = ToolRegistry()

        class _Provider:
            def create_client(self, **kw):
                return object()

        from pathlib import Path as _P

        subagent_mod = __import__('app.agent_runtime.subagent', fromlist=['x'])
        subagent_mod.register_delegate_tool(
            registry, llm_provider=_Provider(), workspace_root=_P(".")
        )
        registry.execute_tool("delegate_task", {"task": "调研", "readonly": True})

    names = captured["names"]
    assert "Read" in names and "Grep" in names
    for write_tool in ("Write", "Edit", "Patch", "Bash", "Rewind"):
        assert write_tool not in names, f"只读子代理不得带 {write_tool}"
    from app.agent_runtime.tool_registry import Effect

    assert captured["effects"] == (Effect.READ,)
