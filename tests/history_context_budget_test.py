import json

from app.agent_runtime.memory_tools import register_history_search
from app.agent_runtime.tool_registry import ToolRegistry


def test_recall_returns_small_excerpts_and_can_reopen_an_exact_event(tmp_path):
    content = "background " * 2000 + "needle: keep all user constraints" + " details" * 2000
    path = tmp_path / "agent-task.jsonl"
    path.write_text(json.dumps({"seq": 7, "type": "user/message", "data": {"content": content}}), encoding="utf-8")
    registry = ToolRegistry()
    register_history_search(registry, sessions_root=tmp_path)
    found = registry.execute_tool("Recall", {"query": "needle"})
    assert not found.is_error
    assert len(found.value) < 1200
    assert "keep all user constraints" in found.value
    assert "agent-task.jsonl" in found.value
    reopened = registry.execute_tool("Recall", {"session_id": "agent-task", "event_seq": 7,
                                                "offset": 21000, "max_chars": 2000})
    assert not reopened.is_error
    assert "keep all user constraints" in str(reopened.value)
    assert reopened.value["nextOffset"] is not None


def test_recall_result_limit_applies_after_per_session_limit(tmp_path):
    for session_id in ["a", "b"]:
        (tmp_path / f"{session_id}.jsonl").write_text("\n".join(
            json.dumps({"seq": i, "data": {"content": f"needle in {session_id}: {i}"}})
            for i in range(40)), encoding="utf-8")
    registry = ToolRegistry()
    register_history_search(registry, sessions_root=tmp_path)
    found = registry.execute_tool("Recall", {"query": "needle", "max_results": 6})
    assert "a.jsonl" in found.value and "b.jsonl" in found.value
