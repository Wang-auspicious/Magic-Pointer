"""Tests for the harness perception-as-tools namespace (gap review L2/L6).

Covers the PerceptionTools facade (injectable PerceptionBackend protocol,
fake backends only — nothing real is touched):

- read_around: success, radius clamping (1..10), BackendBusy -> busy
  Evidence, empty -> empty_confirmed, timeouts -> ActionFailure
- dump_subtree: success, depth clamping (1..8), cycle truncation with note
- find_in_window: hit / miss
- list_windows / get_focused: success and empty
- container heuristic: value == container name -> degraded, confidence <= 0.2,
  container_hint=True (evidence contract function)
- register_all: 5 ToolSpecs, model-usable schemas (schemas_for_model),
  is_concurrency_safe=True, effect=read
- registry.execute_tool integration: ToolResult.is_error=False on success,
  failure_type passthrough on tool failure
- input schema validation: validate_input missing/extra fields
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.errors import ActionFailure, FailureType  # noqa: E402
from app.agent_runtime.perception_tools import (  # noqa: E402
    CONTAINER_LIKE_TEXTS,
    BackendBusy,
    PerceptionBackend,
    PerceptionTools,
)
from app.agent_runtime.tool_registry import (  # noqa: E402
    Effect,
    ToolRegistry,
    ToolSpec,
)
from app.evidence.contract import EvidenceStatus  # noqa: E402


class FakeBackend:
    """In-memory PerceptionBackend; behaviour switchable per test."""

    def __init__(self) -> None:
        self.read_around_calls: list[tuple[str, int]] = []
        self.dump_subtree_calls: list[tuple[str, int]] = []
        self.find_calls: list[str] = []
        self.read_items: list[dict] = []
        self.tree: dict | None = None
        self.finds: list[dict] = []
        self.windows: list[dict] = []
        self.focused: dict | None = None
        self.busy: bool = False
        self.timeout: bool = False

    def read_around(self, anchor: str, radius: int) -> list[dict]:
        self.read_around_calls.append((anchor, radius))
        if self.busy:
            raise BackendBusy("perception worker occupied")
        if self.timeout:
            raise TimeoutError("backend timed out")
        return self.read_items

    def dump_subtree(self, anchor: str, depth: int) -> dict | None:
        self.dump_subtree_calls.append((anchor, depth))
        if self.busy:
            raise BackendBusy("perception worker occupied")
        return self.tree

    def find_in_window(self, pattern: str) -> list[dict]:
        self.find_calls.append(pattern)
        if self.busy:
            raise BackendBusy("perception worker occupied")
        return self.finds

    def list_windows(self) -> list[dict]:
        if self.busy:
            raise BackendBusy("perception worker occupied")
        return self.windows

    def get_focused(self) -> dict | None:
        if self.busy:
            raise BackendBusy("perception worker occupied")
        return self.focused


@pytest.fixture()
def backend() -> FakeBackend:
    return FakeBackend()


@pytest.fixture()
def tools(backend: FakeBackend) -> PerceptionTools:
    return PerceptionTools(backend)


def _assert_ok(evidence: object, expected: str | None = None) -> object:
    assert evidence.status is EvidenceStatus.OK
    assert evidence.value is not None
    if expected is not None:
        assert expected in evidence.value
    return evidence


class TestReadAround:
    def test_success_joins_texts_and_notes_sources(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.read_items = [
            {"text": "first line", "source": "uia", "bbox_ltrb": [0, 0, 10, 10], "confidence": 0.9},
            {"text": "second line", "source": "uia", "bbox_ltrb": [0, 10, 10, 20], "confidence": 0.8},
        ]
        ev = tools.read_around("anchor-1", radius=3)
        _assert_ok(ev)
        assert "first line" in ev.value
        assert "second line" in ev.value
        assert "2" in ev.note

    def test_radius_clamped_into_1_10(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        tools.read_around("a", radius=99)
        tools.read_around("b", radius=0)
        tools.read_around("c", radius=-5)
        calls = backend.read_around_calls
        assert calls == [("a", 10), ("b", 1), ("c", 1)]

    def test_busy_backend_gives_busy_evidence(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.busy = True
        ev = tools.read_around("a")
        assert ev.status is EvidenceStatus.BUSY
        assert ev.value is None
        assert ev.status is not EvidenceStatus.ERROR
        assert ev.status is not EvidenceStatus.EMPTY_CONFIRMED

    def test_empty_backend_gives_empty_confirmed(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        ev = tools.read_around("a")
        assert ev.status is EvidenceStatus.EMPTY_CONFIRMED
        assert ev.value is None

    def test_backend_timeout_raises_action_failure(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.timeout = True
        with pytest.raises(ActionFailure) as exc_info:
            tools.read_around("a")
        assert exc_info.value.failure_type is FailureType.TIMEOUT


class TestDumpSubtree:
    def test_success_serializes_tree(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.tree = {
            "text": "root",
            "children": [{"text": "child-a"}, {"text": "child-b", "children": [{"text": "grandchild"}]}],
        }
        ev = tools.dump_subtree("anchor-1")
        _assert_ok(ev)
        assert "root" in ev.value
        assert "child-a" in ev.value
        assert "grandchild" in ev.value

    def test_depth_clamped_into_1_8(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.tree = {"text": "root"}
        tools.dump_subtree("a", depth=50)
        tools.dump_subtree("b", depth=0)
        assert backend.dump_subtree_calls == [("a", 8), ("b", 1)]

    def test_none_tree_gives_empty_confirmed(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        ev = tools.dump_subtree("a")
        assert ev.status is EvidenceStatus.EMPTY_CONFIRMED

    def test_cycle_is_truncated_and_noted(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        root: dict = {"text": "root", "children": []}
        child: dict = {"text": "child"}
        root["children"].append(child)
        child["children"] = [root]
        backend.tree = root
        ev = tools.dump_subtree("a")
        _assert_ok(ev)
        assert "cycle" in ev.note
        assert "[cycle]" in ev.value
        assert ev.value.count("[cycle]") == 1


class TestFindInWindow:
    def test_hit_returns_text_and_bbox(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.finds = [
            {"text": "total: 42", "bbox_ltrb": [1, 2, 3, 4]},
            {"text": "total: 7", "bbox_ltrb": [5, 6, 7, 8]},
        ]
        ev = tools.find_in_window("total:")
        _assert_ok(ev)
        parsed = json.loads(ev.value)
        assert len(parsed) == 2
        assert parsed[0]["text"] == "total: 42"
        assert parsed[0]["bbox_ltrb"] == [1, 2, 3, 4]

    def test_miss_gives_empty_confirmed(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        ev = tools.find_in_window("nope")
        assert ev.status is EvidenceStatus.EMPTY_CONFIRMED
        assert ev.value is None


class TestListWindowsAndFocused:
    def test_list_windows_serializes_json(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.windows = [
            {"hwnd": 1, "title": "Editor", "process_name": "editor.exe", "pid": 10},
            {"hwnd": 2, "title": "Terminal", "process_name": "cmd.exe", "pid": 20},
        ]
        ev = tools.list_windows()
        _assert_ok(ev)
        parsed = json.loads(ev.value)
        assert [w["title"] for w in parsed] == ["Editor", "Terminal"]
        assert parsed[0]["hwnd"] == 1

    def test_list_windows_empty_gives_empty_confirmed(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        ev = tools.list_windows()
        assert ev.status is EvidenceStatus.EMPTY_CONFIRMED

    def test_get_focused_ok(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.focused = {"hwnd": 7, "title": "Focused", "process_name": "app.exe", "pid": 5}
        ev = tools.get_focused()
        _assert_ok(ev)
        parsed = json.loads(ev.value)
        assert parsed["title"] == "Focused"

    def test_get_focused_none_gives_empty_confirmed(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        ev = tools.get_focused()
        assert ev.status is EvidenceStatus.EMPTY_CONFIRMED
        assert ev.value is None


class TestContainerHeuristic:
    def test_container_name_value_is_degraded(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.read_items = [{"text": "List", "source": "uia", "bbox_ltrb": [0, 0, 1, 1], "confidence": 1.0}]
        ev = tools.read_around("a")
        assert ev.status is EvidenceStatus.DEGRADED
        assert ev.container_hint is True
        assert ev.confidence <= 0.2
        assert ev.value == "List"

    def test_plain_text_value_untouched(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.read_items = [{"text": "actual content", "source": "uia", "bbox_ltrb": [0, 0, 1, 1], "confidence": 1.0}]
        ev = tools.read_around("a")
        _assert_ok(ev)
        assert ev.container_hint is False
        assert ev.confidence == 1.0

    def test_container_names_cover_window_pane_group(self) -> None:
        assert {"Window", "Pane", "List", "Group"} <= set(CONTAINER_LIKE_TEXTS)


class TestRegisterAll:
    def test_all_tools_registered(self, tools: PerceptionTools) -> None:
        registry = ToolRegistry()
        tools.register_all(registry)
        names = {spec.name for spec in registry.list()}
        assert names == {"Around", "Tree", "Find", "ListWindows", "GetFocus"}
        for spec in registry.list():
            assert spec.effect is Effect.READ
            assert spec.is_concurrency_safe is True
            assert spec.input_schema["type"] == "object"

    def test_schemas_for_model_output(self, tools: PerceptionTools) -> None:
        registry = ToolRegistry()
        tools.register_all(registry)
        emitted = registry.schemas_for_model()
        assert len(emitted) == 5
        for entry in emitted:
            assert {"name", "description", "parameters"} <= set(entry)
            assert entry["parameters"]["type"] == "object"
            assert isinstance(entry["parameters"]["required"], list)

    def test_execute_via_registry_success(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.read_items = [{"text": "hello", "source": "uia", "bbox_ltrb": [0, 0, 1, 1], "confidence": 1.0}]
        registry = ToolRegistry()
        tools.register_all(registry)
        result = registry.execute_tool("Around", {"anchor": "a", "radius": 2})
        assert result.is_error is False
        assert "hello" in result.value.value
        assert result.failure_type is None

    def test_execute_via_registry_timeout_failure(self, tools: PerceptionTools, backend: FakeBackend) -> None:
        backend.timeout = True
        registry = ToolRegistry()
        tools.register_all(registry)
        result = registry.execute_tool("Around", {"anchor": "a"})
        assert result.is_error is True
        assert result.failure_type is FailureType.TIMEOUT

    def test_specs_are_toolspec_instances(self, tools: PerceptionTools) -> None:
        registry = ToolRegistry()
        tools.register_all(registry)
        assert all(isinstance(spec, ToolSpec) for spec in registry.list())

    def test_frozen_reads_are_labelled_historical(self, tools: PerceptionTools) -> None:
        registry = ToolRegistry()
        tools.register_all(registry)
        for name in ("Around", "Tree", "Find"):
            description = registry.get(name).description.casefold()
            assert "frozen" in description, name
            assert "observe" in description, name


class TestInputValidation:
    def test_validate_input_missing_anchor(self, tools: PerceptionTools) -> None:
        registry = ToolRegistry()
        tools.register_all(registry)
        spec = registry.get("Around")
        errors = registry.validate_input(spec, {"radius": 2})
        assert any("anchor" in e for e in errors)

    def test_validate_input_extra_field_rejected(self, tools: PerceptionTools) -> None:
        registry = ToolRegistry()
        tools.register_all(registry)
        spec = registry.get("Find")
        errors = registry.validate_input(spec, {"pattern": "x", "radius": 9})
        assert any("radius" in e for e in errors)

    def test_validate_input_ok_when_complete(self, tools: PerceptionTools) -> None:
        registry = ToolRegistry()
        tools.register_all(registry)
        spec = registry.get("Find")
        assert registry.validate_input(spec, {"pattern": "x"}) == []

    def test_backend_busy_through_registry_is_busy_evidence_not_error(
        self, tools: PerceptionTools, backend: FakeBackend
    ) -> None:
        backend.busy = True
        registry = ToolRegistry()
        tools.register_all(registry)
        result = registry.execute_tool("Around", {"anchor": "a"})
        assert result.is_error is False
        assert result.value.status is EvidenceStatus.BUSY
