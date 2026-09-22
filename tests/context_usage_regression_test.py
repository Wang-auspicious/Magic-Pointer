from pathlib import Path
from types import SimpleNamespace

from app.agent_runtime.activity_projection import RuntimeActivitySink, completed_trajectory
from app.agent_runtime.coding_tools import register_coding_tools
from app.agent_runtime.loop import _merge_model_usage
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.usage_cost import estimate_cost_usd
from app.governance.cancellation import CancellationToken


def registry(root: Path) -> ToolRegistry:
    reg = ToolRegistry()
    register_coding_tools(reg, workspace_root=root)
    return reg


def test_glob_skips_ignored_installation_tree_but_keeps_workspace_docs(tmp_path):
    (tmp_path / ".gitignore").write_text("/release/\n")
    (tmp_path / "notes.md").write_text("today")
    (tmp_path / "release").mkdir()
    (tmp_path / "release" / "noise.md").write_text("bundled copy")
    result = registry(tmp_path).execute_tool("Glob", {"pattern": "**/*.md"})
    assert not result.is_error
    assert "notes.md" in result.value
    assert "release" not in result.value


def test_glob_honours_cancellation_before_traversal(tmp_path):
    (tmp_path / "a.md").write_text("a")
    token = CancellationToken()
    token.cancel()
    result = registry(tmp_path).execute_tool("Glob", {"pattern": "**/*.md"}, scope=token)
    assert result.is_error
    assert "cancelled" in result.error_message


def test_grep_accepts_the_glob_field_used_in_the_gui_task(tmp_path):
    (tmp_path / "note.md").write_text("jev")
    (tmp_path / "noise.txt").write_text("jev")
    reg = registry(tmp_path)
    args = {"pattern": "jev", "glob": "*.md", "output_mode": "files_with_matches"}
    assert reg.validate_input(reg.get("Grep"), args) == []
    result = reg.execute_tool("Grep", args)
    assert "note.md" in result.value
    assert "noise.txt" not in result.value


def test_default_read_is_a_page_and_explicit_offset_can_read_the_rest(tmp_path):
    (tmp_path / "status.md").write_text("\n".join(f"line-{i}" for i in range(1, 1001)))
    reg = registry(tmp_path)
    first = reg.execute_tool("Read", {"path": "status.md"})
    assert "line-200\n" in first.value
    assert "line-201\n" not in first.value
    assert "showing lines 1-200 of 1000" in first.value
    following = reg.execute_tool("Read", {"path": "status.md", "offset": 201, "limit": 200})
    assert "line-201\n" in following.value


def test_default_read_budgets_long_status_entries_without_losing_explicit_access(tmp_path):
    (tmp_path / "status.md").write_text("\n".join("x" * 500 for _ in range(150)))
    reg = registry(tmp_path)
    result = reg.execute_tool("Read", {"path": "status.md"})
    assert len(result.value) < 12500
    assert "truncated" in result.value
    explicit = reg.execute_tool("Read", {"path": "status.md", "offset": 25, "limit": 2})
    assert "25\t" + "x" * 500 in explicit.value


def test_deepseek_cost_uses_exact_model_host_cache_and_request_time():
    usage = {"contextTokens": 1000000, "lastCacheReadTokens": 600000, "lastOutputTokens": 100000}
    assert estimate_cost_usd(usage, "deepseek-flash", "api.deepseek.com", 1789776000) == 0.1218
    assert estimate_cost_usd(usage, "deepseek-flash", "other-provider.com", 1789776000) is None
    assert estimate_cost_usd(usage, "unknown", "api.deepseek.com", 1789776000) is None
    assert estimate_cost_usd({"contextTokens": 10}, "deepseek-flash", "api.deepseek.com", 1789776000) is None


def test_usage_keeps_latest_request_separate_from_sum_and_counts_anthropic_cache():
    usage = {}
    _merge_model_usage(usage, {"prompt_tokens": 6888, "completion_tokens": 66})
    _merge_model_usage(usage, {"input_tokens": 100, "cache_read_input_tokens": 600,
                               "cache_creation_input_tokens": 200, "output_tokens": 25})
    assert usage["inputTokens"] == 7788
    assert usage["totalTokens"] == 7879
    assert usage["contextTokens"] == 900
    assert usage["lastOutputTokens"] == 25
    assert usage["lastCacheReadTokens"] == 600
    _merge_model_usage(usage, {"prompt_tokens": 1000, "completion_tokens": 10})
    assert usage["contextTokens"] == 1000
    assert "lastCacheReadTokens" not in usage


def test_activity_exposes_running_command_and_per_request_usage_before_tools():
    marks = []
    class Clock:
        def mark(self, phase, **fields):
            marks.append((phase, fields))
            return 1.0
        def mark_blob(self, phase, blob):
            marks.append((phase, blob))
            return 2.0
    sink = RuntimeActivitySink(Clock())
    sink(SimpleNamespace(kind="turn_started", turn=1))
    sink(SimpleNamespace(kind="model_usage", usage={"contextTokens": 6888, "inputTokens": 6888,
                         "contextEstimated": 0, "lastOutputTokens": 66}))
    sink(SimpleNamespace(kind="tool_call_started", id="bash-1", name="Bash", arguments={"command": "dir /s *.md"}))
    assert sink.trajectory[-1]["text"] == '{"command":"dir /s *.md"}'
    assert any(phase == "model_usage" for phase, _ in marks)
    assert sink.trajectory[1]["inputTokens"] == 6888
    completed = completed_trajectory({"modelUsage": {"inputTokens": 90823}}, sink.trajectory)
    assert completed[1]["inputTokens"] == 6888
